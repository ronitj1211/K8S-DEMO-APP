# Internals — how Prometheus actually works

The mechanics behind the stack in [README.md](README.md). This is the material that separates "I've used Grafana" from "I've operated Prometheus."

---

## 1. The life of a scrape

Every `scrape_interval`, for every target:

1. **Service discovery** produces a target list. Each target starts as a set of `__meta_*` labels from the Kubernetes API — `__meta_kubernetes_pod_name`, `__meta_kubernetes_pod_annotation_*`, and dozens more.
2. **`relabel_configs` run** against those meta labels. This happens *before* the scrape and decides two things: whether to scrape the target at all (`action: keep` / `drop`), and what address and labels it gets.
3. **The HTTP GET** goes to `http://__address__ + __metrics_path__`, with a `scrape_timeout` (default 10s, must be < `scrape_interval`).
4. **The response is parsed** — Prometheus text exposition format, or protobuf for native histograms.
5. **`metric_relabel_configs` run** against the parsed samples. This is the *second* relabeling stage, and it's how you drop expensive metrics you don't want to store:
   ```yaml
   metric_relabel_configs:
     - source_labels: [__name__]
       action: drop
       regex: go_gc_duration_seconds.*
   ```
6. **Target labels are attached** — `job`, `instance`, plus anything relabeling added. If a metric already has a label with the same name, the target label wins and the original is renamed `exported_<label>`.
7. **Samples are appended** to the TSDB with the scrape timestamp.
8. **Synthetic metrics are recorded** for the scrape itself:
   - `up` — 1 if the scrape succeeded, 0 otherwise
   - `scrape_duration_seconds`
   - `scrape_samples_scraped`
   - `scrape_samples_post_metric_relabeling`
   - `scrape_series_added` ← watch this one for cardinality growth

**Key consequence:** `up` exists for every target automatically. `up == 0` is the cheapest, most reliable alert you can write, and it costs the application nothing.

---

## 2. Relabeling — the part everyone finds confusing

Relabeling is a small pipeline of rewrite rules over a label set. Each rule reads `source_labels`, joins them with `separator` (default `;`), matches `regex`, and applies `action`.

| Action | Effect |
|---|---|
| `keep` | Drop the target/sample unless the regex matches |
| `drop` | Drop it if the regex matches |
| `replace` | Write `replacement` (with `$1` capture groups) into `target_label` |
| `labelmap` | Copy labels matching a regex to new names |
| `labeldrop` / `labelkeep` | Remove or retain labels by regex |
| `hashmod` | Hash a label into N buckets — used for sharding Prometheus |

Worked example from [stack/11-prometheus-config.yaml](stack/11-prometheus-config.yaml):

```yaml
- source_labels: [__address__, __meta_kubernetes_pod_annotation_prometheus_io_port]
  action: replace
  regex: ([^:]+)(?::\d+)?;(\d+)
  replacement: $1:$2
  target_label: __address__
```

Given `__address__ = "10.42.0.15:80"` and the port annotation `"3000"`, the joined string is `10.42.0.15:80;3000`. The regex captures `10.42.0.15` as `$1` and `3000` as `$2`, so `__address__` becomes `10.42.0.15:3000`. That's how an annotation redirects the scrape to the right port.

**Labels beginning with `__` are dropped after relabeling** — they're internal. That's why `__address__` doesn't appear on your metrics but `instance` (derived from it) does.

---

## 3. The TSDB

Prometheus stores samples in a purpose-built time-series database:

- **A sample is 16 bytes** in memory (8-byte timestamp, 8-byte float64), compressed to **~1.3 bytes on disk** using delta-of-delta encoding for timestamps and XOR encoding for values (the Gorilla paper). This compression is why Prometheus can hold so much on modest hardware.
- **The head block** holds the most recent ~2 hours in memory, backed by a **WAL** (write-ahead log) on disk so an unclean restart doesn't lose data.
- Every 2 hours the head is **flushed to a persistent block** — an immutable directory with chunks, an index, and metadata.
- A **compactor** merges small blocks into larger ones over time, and deletes blocks past `--storage.tsdb.retention.time`.

**Capacity planning rule of thumb:**

```
disk = retention_seconds × ingested_samples_per_second × bytes_per_sample(≈1.5-2)
```

For 1M active series scraped every 15s over 15 days: `1,296,000s × 66,667 samples/s × 2B ≈ 170 GB`.

**Memory is driven by active series, not by retention.** Roughly 8 KB per active series for the in-memory index. That's why cardinality — not disk — is what OOMKills a Prometheus.

**Prometheus is not clustered.** A single server is a single point of failure with local storage. Real HA is either two identical servers scraping the same targets (deduplicated at query time), or **Thanos / Mimir / Cortex / AWS Managed Prometheus** for global query, unlimited retention in object storage, and downsampling.

---

## 4. Staleness

When a target disappears (pod deleted, scaled down), its series don't linger forever showing the last value. Prometheus writes an explicit **stale marker** and the series stops returning data.

Rules that follow from this:

- A query at time T looks back up to **5 minutes** (`--query.lookback-delta`) for the most recent sample. So a scrape interval longer than 5 minutes produces gappy graphs.
- After a pod is deleted, its series vanish from instant queries within one scrape interval, but historical data is still queryable over a range.
- This is why `absent()` and `up == 0` work reliably for "this thing stopped existing."

---

## 5. `rate()`, `irate()`, `increase()` — and extrapolation

`rate(counter[5m])` does not simply subtract the first sample from the last:

1. It takes all samples in the window.
2. It **detects counter resets** — any decrease means the process restarted, so it adds the pre-reset value back rather than reporting a huge negative rate.
3. It computes the per-second slope.
4. It **extrapolates** to the window edges, because samples rarely land exactly on the boundary.

Consequences that surprise people:

- `increase()` can return non-integers like `3.0000000000000004` — that's the extrapolation, not a bug.
- You need **at least 2 samples** in the range or the result is empty. Rule: `range ≥ 4 × scrape_interval`. With a 15s scrape, `[1m]` is the practical minimum; `[5m]` is the safe default.
- `irate()` uses only the **last two** samples — very responsive, very spiky. Use it for zoomed-in debugging, never for alerting.
- **Always `rate()` before `sum()`**, never after. `sum(rate(x[5m]))` is correct; `rate(sum(x)[5m])` is meaningless because summing across pods destroys the per-series reset detection.

---

## 6. Histograms and `histogram_quantile`

A histogram metric expands into three series families:

```
http_request_duration_seconds_bucket{le="0.05"}   ← cumulative count ≤ 0.05s
http_request_duration_seconds_bucket{le="0.1"}
http_request_duration_seconds_bucket{le="+Inf"}   ← total count
http_request_duration_seconds_sum                  ← sum of all observed values
http_request_duration_seconds_count                ← number of observations
```

Buckets are **cumulative**: the `le="0.1"` bucket counts everything ≤ 0.1s, including what's in `le="0.05"`.

`histogram_quantile(0.95, ...)` finds the bucket containing the 95th percentile and **linearly interpolates within it**. That means:

- **Accuracy depends entirely on bucket boundaries.** If your buckets are `[1, 5, 10]` and all requests take 1.1s, p95 is interpolated somewhere in `(1, 5]` — worthless. Buckets must straddle your SLO.
- **The `le` label must survive aggregation.** `sum by (service, le) (rate(..._bucket[5m]))` is correct; dropping `le` returns nothing, and this is the single most common PromQL bug.
- Each bucket is a separate series, so a 10-bucket histogram × 20 routes × 3 pods = 600 series from one metric. Histograms are the biggest cardinality contributor in most systems.

**Average latency is a lie** — `sum / count` hides the tail completely. Ten fast requests and one 10-second request average to something that looks fine. Always use quantiles.

**Native histograms** (Prometheus 2.40+, experimental) replace fixed buckets with an exponential schema — far better resolution at a fraction of the series count.

---

## 7. The alert state machine

```
        expr false          expr true            held for `for:`
INACTIVE ─────────▶ INACTIVE ────────▶ PENDING ─────────────────▶ FIRING
   ▲                                      │                          │
   │                                      │ expr false               │ expr false
   └──────────────────────────────────────┴──────────────────────────┘
                                                              (then RESOLVED
                                                               sent after
                                                               resolve_timeout)
```

- **Pending** exists solely to absorb transient spikes. `for: 2m` means the condition must be continuously true across every evaluation in that window — a single false evaluation resets the timer to zero.
- Prometheus re-sends firing alerts to Alertmanager **every evaluation cycle**. Alertmanager's `repeat_interval` — not Prometheus — controls how often *you* get notified.
- An alert is identified by its **full label set**. Change a label and it's a different alert: the old one resolves and a new one fires.
- `ALERTS{alertname="X", alertstate="firing"}` is itself a queryable metric, so you can graph and alert on your own alerting.

---

## 8. Alertmanager pipeline

```
   receive → dedupe → group → inhibit → silence → route → notify
                                                              │
                                                    retry with backoff
```

- **Dedupe** — multiple HA Prometheus servers sending the same alert produce one notification.
- **Group** — `group_by` collapses many alerts into one notification. `group_by: [...]` with `alertname` and `namespace` means all pods failing in one namespace page once.
- **`group_wait`** (10s) — the initial delay before sending a new group, so a cascade arrives together.
- **`group_interval`** (30s) — the minimum gap before sending an *updated* group (new alerts joined the group).
- **`repeat_interval`** (1h) — the gap before re-notifying about an *unchanged* group.
- **Inhibition** — suppress alert B while alert A fires, matched on `equal:` labels. Classic use: don't send "service degraded" when "entire cluster down" is already firing.
- **Silences** — time-bounded, matcher-based mutes created via the UI or API. Always use these for planned maintenance rather than deleting rules.

Alertmanager clusters via a **gossip protocol** so multiple instances don't double-notify.

---

## 9. Pull vs push, and the Pushgateway

Prometheus pulls. The one case where that genuinely can't work is a **short-lived batch job** that exits before any scrape lands. The Pushgateway holds those metrics for Prometheus to scrape later.

Use it only for that. It's an anti-pattern for service metrics because:

- It becomes a single point of failure and a bottleneck.
- Metrics pushed to it are **sticky** — they persist until explicitly deleted, so a decommissioned job reports its last value forever.
- You lose `up` — the Pushgateway is always up, so you can't tell whether the job ran.

---

## 10. Scaling Prometheus

When one server isn't enough, in order of escalation:

1. **Reduce cardinality.** Drop unused metrics with `metric_relabel_configs`, remove high-cardinality labels. Always try this first — it's usually a 10× win for free.
2. **Increase scrape interval.** 15s → 30s halves ingestion.
3. **Recording rules.** Precompute what dashboards query repeatedly.
4. **Functional sharding.** One Prometheus for infrastructure, one per team/tenant.
5. **Hash sharding.** Multiple servers each scraping a slice via `hashmod` on `__address__`.
6. **Federation.** A global Prometheus scrapes aggregated series from shard Prometheuses via `/federate`. Only federate recording-rule output — never raw series.
7. **Thanos / Mimir / Cortex.** Sidecar ships blocks to S3; Querier fans out across all of them; Compactor downsamples for long-range queries. This is the real answer for multi-cluster, long retention, and global view.
8. **Managed** — AWS Managed Prometheus (AMP), Grafana Cloud, Google Managed Prometheus.

---

## 11. Grafana internals worth knowing

- **`access: proxy` vs `direct`** — proxy means Grafana's *backend* queries Prometheus, so the datasource needs no browser reachability and credentials stay server-side. Always use proxy.
- **Panel queries are executed by the browser calling Grafana's backend**, which then queries the datasource. A dashboard with 12 panels refreshing every 5s is 144 PromQL queries a minute — this is how people accidentally DoS their own Prometheus.
- **`$__rate_interval`** is a Grafana variable that automatically picks a range ≥ 4× the scrape interval and adjusts with zoom level. Prefer it over a hardcoded `[5m]` in dashboards.
- **`$__interval`** is the step size Grafana computes from panel width and time range — used with `avg_over_time` for downsampling.
- **Provisioned dashboards are read-only-ish**: with `allowUiUpdates: true` you can edit in the UI, but the file wins on the next reload. Treat the JSON in Git as the source of truth and export changes back into it.
- **Template variables** (`$namespace`, `$pod`) turn one dashboard into many. Defined with `label_values(kube_pod_info, namespace)` style queries.
