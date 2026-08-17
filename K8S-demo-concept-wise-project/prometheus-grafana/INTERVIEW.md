# Interview Q&A — Prometheus, Grafana & Alerting

Each answer is short enough to say out loud, with a scenario that shows you've actually run this.

---

## Basics

**Q1. What is Prometheus?**
An open-source time-series database and monitoring system that **pulls** metrics from HTTP `/metrics` endpoints on a schedule, stores them with a label-based data model, and evaluates rules over them with PromQL.

*Scenario:* Every pod in the `demo` namespace exposes `/metrics`. Prometheus discovers them through the Kubernetes API and scrapes each one every 15s — nothing is configured per-pod, and a new replica is scraped within one interval of starting.

**Q2. Pull vs push — why does Prometheus pull?**
Because in a dynamic cluster, pull gives you target discovery and target health for free. Prometheus asks the API server what exists, so pods that come and go need no configuration. And a failed scrape records `up == 0`, meaning "is this thing alive" is answered by the same mechanism that collects metrics.

*Scenario:* A deploy scales from 3 to 10 pods. Nothing is reconfigured — Prometheus picks up 7 new targets on its next discovery cycle. With a push model, each pod would need to know where to send, and a pod that silently stopped pushing would be indistinguishable from a healthy idle one.

**Q3. What are the metric types?**
**Counter** (monotonically increasing, use `rate()`), **Gauge** (goes up and down, read directly), **Histogram** (bucketed observations, gives server-side quantiles), **Summary** (client-computed quantiles, can't be aggregated).

*Scenario:* `http_requests_total` is a counter — graphing it raw gives an ever-rising line that tells you nothing. `rate(http_requests_total[5m])` turns it into requests-per-second, which is what you actually wanted.

**Q4. Why can't you aggregate a Summary across pods?**
Because the quantiles are computed *inside each client* before export. Averaging three pods' p95 values is not the fleet p95 — it's mathematically meaningless. Histograms export raw buckets, so you can sum the buckets across pods and *then* compute the true quantile.

**Q5. What is `up`?**
A synthetic metric Prometheus writes for every target on every scrape: 1 for success, 0 for failure. `up == 0` is the simplest and most valuable alert in any setup.

---

## Configuration & discovery

**Q6. How does Prometheus find what to scrape in Kubernetes?**
`kubernetes_sd_configs` queries the API server for pods/services/endpoints/nodes, producing targets carrying `__meta_kubernetes_*` labels. `relabel_configs` then filter that list and rewrite addresses and labels.

*Scenario:* Our pods carry `prometheus.io/scrape: "true"`. The scrape job's first rule is `action: keep, regex: "true"` against that annotation — so a pod opts into monitoring by adding an annotation, with no Prometheus config change at all.

**Q7. What is relabeling, and what's the difference between `relabel_configs` and `metric_relabel_configs`?**
Both rewrite label sets, but at different stages. `relabel_configs` runs **before** the scrape and decides *which targets to scrape and at what address*. `metric_relabel_configs` runs **after** the scrape on the returned samples and decides *which metrics to keep*.

*Scenario:* We used the first to redirect scraping to port 3000 based on an annotation, and the second to drop `go_gc_duration_seconds*` — Go runtime metrics we never queried but which were 15% of our series count.

**Q8. Targets page is empty. What's wrong?**
In order: RBAC (Prometheus's ServiceAccount needs cluster-wide list/watch on pods/nodes/endpoints — check the logs for `forbidden`), then annotation mismatch (`"true"` must be a quoted string in YAML, or it parses as a boolean and the regex won't match), then a `keep` rule that's too strict.

**Q9. What's a ServiceMonitor?**
A CRD from the Prometheus Operator that declares "scrape the pods behind this Service" in Kubernetes-native YAML. The Operator translates it into exactly the kind of scrape config we wrote by hand and reloads Prometheus. It's the production-standard approach because app teams can add monitoring without touching central config.

---

## PromQL

**Q10. `rate()` vs `irate()` vs `increase()`?**
`rate()` = per-second average over the whole window, handles counter resets, smooth — use it for dashboards and alerts. `irate()` = per-second based on only the last two samples, very spiky — debugging only. `increase()` = total growth over the window (`rate × seconds`) — use for "how many errors in the last hour."

**Q11. Why must you `rate()` before `sum()`?**
Counter reset detection is per-series. `sum()` first destroys the individual series, so a pod restarting looks like the total dropping, and the rate goes wrong or negative. `sum(rate(x[5m]))` is correct; `rate(sum(x)[5m])` is broken.

**Q12. How do you calculate p95 latency?**
```promql
histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))
```
*Scenario:* The classic bug here is dropping `le` from the `by()` clause — the query then returns empty with no error, and people assume the metric is missing. `le` is the bucket boundary label; `histogram_quantile` cannot work without it.

**Q13. Why is average latency a bad metric?**
It hides the tail. 100 requests at 50ms and 1 request at 30s averages to ~350ms, which looks acceptable — while one user waited 30 seconds. Percentiles show what your worst-served users experience.

**Q14. How do you compute an error ratio safely?**
```promql
sum(rate(http_requests_total{status=~"5.."}[5m]))
  / clamp_min(sum(rate(http_requests_total[5m])), 0.001)
```
The `clamp_min` matters: when traffic drops to zero the denominator is 0, and `0/0` produces `NaN`, which can make an alert flap or silently never fire.

**Q15. What range should you use in `rate()`?**
At least 4× the scrape interval so there are always ≥2 samples. With 15s scrapes, `[1m]` is the floor and `[5m]` is the sensible default. In Grafana, use `$__rate_interval`, which computes this for you and adapts to zoom.

---

## Alerting

**Q16. Walk through what happens from a condition becoming true to someone being paged.**
Prometheus evaluates the rule every `evaluation_interval`. When the expression returns data, the alert goes **Pending**. If it stays true for the whole `for:` duration it becomes **Firing** and is pushed to Alertmanager on every subsequent evaluation. Alertmanager dedupes it, waits `group_wait` to collect related alerts, applies inhibition and silences, matches it against the routing tree, and delivers to the receiver — retrying with backoff on failure.

**Q17. What does `for:` do and why does it matter?**
It requires the condition to hold continuously before firing. Without it, a single scrape blip pages someone at 3am. A single false evaluation resets the timer.

*Scenario:* Our `HighErrorRate` alert uses `for: 2m`. A one-off deploy blip pushes the error ratio over 5% for 20 seconds — it goes Pending, then straight back to Inactive. Nobody is woken up, and the graph still shows what happened.

**Q18. Why do you need Alertmanager at all?**
Prometheus decides *what* is wrong; Alertmanager decides *who is told, how often, and grouped with what*. Without it, 40 pods failing produces 40 notifications. It provides grouping, deduplication (essential with HA Prometheus pairs), inhibition, silences, and the routing tree.

**Q19. Symptom-based vs cause-based alerting?**
Alert on symptoms users feel — error rate, latency, availability. Treat causes — CPU, memory, disk — as warnings that help you diagnose. High CPU on a healthy, fast service is not an incident; it's a machine doing its job.

*Scenario:* We deleted a `NodeHighCPU` page that fired weekly and never once corresponded to user impact, and replaced it with an error-budget-burn alert on the service SLO. Page volume dropped and every remaining page was real.

**Q20. What is inhibition?**
Suppressing one alert while a more severe related alert is firing, matched on shared labels. If the whole cluster is down, you want the one "cluster down" page, not fifty "service unreachable" pages.

**Q21. What are recording rules and when do you use them?**
Precomputed queries saved as new series, evaluated on a schedule. Use them when a query is expensive and used repeatedly — dashboards refreshing every 10s, or an alert and a panel sharing the same complex expression. Naming convention: `level:metric:operation`.

*Scenario:* Our p95 recording rule is queried by both a Grafana panel and the `HighLatencyP95` alert. That guarantees the number someone sees on the dashboard is exactly the number that fired the alert — no "the graph looks fine but it paged" confusion.

---

## Operations & scale

**Q22. What is cardinality and why does it matter?**
Every unique combination of metric name and label values is a separate stored time series, costing roughly 8 KB of memory. Cardinality multiplies across labels, so one unbounded label destroys a Prometheus server.

*Scenario:* A team labelled requests with `user_id`. 50,000 users × 20 routes × 6 statuses is 6 million series from one metric. Prometheus OOMKilled within hours. The fix was removing the label — user-level detail belongs in logs, where it's indexed once, not in metrics where it multiplies.

**Q23. How do you find a cardinality problem?**
```promql
topk(10, count by (__name__)({__name__=~".+"}))    # worst metrics
topk(10, count by (job) ({__name__=~".+"}))        # worst jobs
```
Plus `scrape_series_added` to catch growth as it starts, and the TSDB status page at `/tsdb-status`.

**Q24. What labels should never be metric labels?**
User ID, request ID, trace ID, session ID, email, IP address, full URL with query string, timestamps, error messages — anything unbounded. Use the **route pattern** (`/api/orders/:id`), never the actual path.

**Q25. How much memory/disk does Prometheus need?**
Memory is driven by **active series** (~8 KB each), not retention. Disk is `retention_seconds × samples_per_second × ~2 bytes` — samples compress to about 1.3–2 bytes thanks to delta-of-delta and XOR encoding.

**Q26. How do you make Prometheus highly available?**
Prometheus itself doesn't cluster. Options: run two identical servers scraping the same targets (Alertmanager dedupes the alerts), and for long-term storage and a global view use **Thanos** or **Mimir** — a sidecar ships 2-hour blocks to S3, a Querier fans out across all instances, and a Compactor downsamples for cheap long-range queries. Managed equivalents: AWS AMP, Grafana Cloud.

**Q27. What's the difference between kube-state-metrics and cAdvisor/metrics-server?**
**cAdvisor** (in the kubelet) reports *resource usage* — CPU seconds, memory working set, per container. **kube-state-metrics** reports *object state* from the API server — desired vs available replicas, pod phase, restart counts, PVC status. **metrics-server** is a separate lightweight aggregator that exists purely to serve `kubectl top` and the HPA; it stores nothing and is not a Prometheus replacement.

*Scenario:* "Is this pod using too much memory?" → cAdvisor. "Is this Deployment missing replicas?" → kube-state-metrics. "Should the HPA scale up?" → metrics-server.

**Q28. Where does the Pushgateway fit?**
Only for short-lived batch jobs that exit before a scrape can reach them. Avoid it for services: metrics are sticky (a dead job reports its last value forever), it becomes a single point of failure, and you lose `up` as a health signal.

---

## Grafana

**Q29. How do you make a Grafana setup reproducible?**
Provisioning — datasources and dashboards declared as files on disk (here, mounted from ConfigMaps) rather than clicked into the UI. UI-created dashboards live only in Grafana's database and die with the pod.

*Scenario:* We deleted and re-created the entire monitoring namespace during a cluster migration. Both dashboards and both datasources came back identical, because they're in Git — see [stack/40-grafana-provisioning.yaml](stack/40-grafana-provisioning.yaml).

**Q30. Datasource `access: proxy` vs `direct`?**
`proxy` means Grafana's backend makes the query, so Prometheus doesn't need to be reachable from the user's browser and credentials never leave the server. Always proxy.

**Q31. What is `$__rate_interval`?**
A Grafana variable that resolves to a range at least 4× the scrape interval, adjusted for the panel's current zoom. It prevents the classic "graph goes empty when I zoom in" problem caused by a hardcoded `[5m]` with too few samples.

**Q32. What dashboards would you build for a service?**
The **RED** method for request-driven services — Rate, Errors, Duration — plus saturation. For infrastructure, **USE** — Utilization, Saturation, Errors. Then a cluster-health view (nodes, pod restarts, replicas desired vs available) and an SLO view showing error budget remaining. That's exactly the split in [stack/41-grafana-dashboards.yaml](stack/41-grafana-dashboards.yaml).

---

## Scenario questions

**Q33. Grafana shows "No data" but the app is clearly serving traffic. Walk me through it.**
Work the pipeline backwards from the source:
1. `curl pod:3000/metrics` — is the app exposing anything at all?
2. Prometheus `/targets` — is the target listed, and is it `UP`? A `DOWN` target's error message names the cause (connection refused = wrong port; 404 = wrong path).
3. Query the raw metric in the Prometheus UI — if it works there, the problem is Grafana, not Prometheus.
4. Check the Grafana datasource URL and hit **Save & test**.
5. Check the panel's time range and the query itself — a dropped `le`, a typo'd label, or a `rate()` window too short for the scrape interval all return empty silently.

**Q34. Prometheus keeps getting OOMKilled. What do you do?**
It's almost always cardinality, not retention. Run `topk(10, count by (__name__)({__name__=~".+"}))` to find the offender, then check `scrape_series_added` to see when growth started — usually it correlates with a deploy. Short term, drop the offending metric or label with `metric_relabel_configs` and raise the memory limit. Long term, fix the instrumentation and add a series-count budget with an alert on it.

**Q35. An alert fired but the dashboard looks fine. How is that possible?**
Usually the alert and the panel are computing different things — different rate window, different aggregation, or different label filters. This is the exact reason to have alerts query **recording rules** and dashboards query the *same* recording rules. Other causes: the alert fired on a condition that has since resolved (check `ALERTS` history rather than the current graph), or the panel's time range doesn't cover the firing window.

**Q36. You're asked to monitor a brand-new service. What do you instrument first?**
The RED signals, in this order: a request counter labelled by route pattern and status code; a duration histogram with buckets straddling the SLO; and a gauge for in-flight work. Then one or two business metrics that mean something to non-engineers — orders processed, payments failed. Then health endpoints. That gives you an error-rate alert, a latency alert, and a dashboard on day one — and deliberately no unbounded labels.
