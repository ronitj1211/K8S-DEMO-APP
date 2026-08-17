# Prometheus + Grafana on Kubernetes

A complete, self-contained metrics stack: an instrumented app, Prometheus scraping it, recording and alerting rules, Alertmanager delivering notifications, node-exporter and kube-state-metrics for infrastructure signals, and Grafana with pre-provisioned dashboards.

> **Related folder:** [monitoring-networkpolicies/](../monitoring-networkpolicies/) also runs Prometheus + Grafana, but there they are a *supporting cast* for learning NetworkPolicies. **This** folder is the monitoring deep-dive: rules, Alertmanager, exporters, provisioning, PromQL, and cardinality — none of which that folder covers.

---

## What problem does this solve?

Logs (the [elk-logging/](../elk-logging/) folder) tell you *what happened in one request*. Metrics tell you *how the system is behaving in aggregate, over time*:

- Is the error rate climbing?
- Is p99 latency past the SLO?
- Are we about to run out of memory on that node?
- Did the deploy 10 minutes ago make anything worse?

Metrics are cheap to store, fast to query, and are what alerts are built on. Logs are for *diagnosis*; metrics are for *detection*.

---

## The stack

| Component | Role | Port |
|---|---|---|
| **demo-api** | Sample app exposing `/metrics` with RED metrics | 30300 |
| **Prometheus** | Scrapes targets, stores the TSDB, evaluates rules | 30090 |
| **Alertmanager** | Dedupes, groups, routes, and delivers alerts | 30093 |
| **node-exporter** | Host CPU / memory / disk / network (DaemonSet) | — |
| **kube-state-metrics** | State of K8s objects (replicas, phases, restarts) | — |
| **Grafana** | Dashboards over Prometheus | 30030 |

```
   ┌───────────────────────────── Kubernetes cluster ──────────────────────────┐
   │                                                                            │
   │  namespace: demo                     namespace: monitoring                 │
   │  ┌───────────────────┐               ┌──────────────────────────────────┐  │
   │  │ demo-api  x3      │               │                                  │  │
   │  │  GET /metrics     │◀──── scrape ──┤          Prometheus              │  │
   │  │  RED metrics      │      15s      │  ┌────────────────────────────┐  │  │
   │  └───────────────────┘               │  │ service discovery (K8s API)│  │  │
   │  ┌───────────────────┐               │  │ TSDB                       │  │  │
   │  │ loadgen           │               │  │ recording rules            │  │  │
   │  │ (drives traffic)  │               │  │ alerting rules             │  │  │
   │  └───────────────────┘               │  └─────────────┬──────────────┘  │  │
   │                                      │                │ fires            │  │
   │  ┌───────────────────┐               │                ▼                  │  │
   │  │ node-exporter     │◀──── scrape ──┤       ┌──────────────────┐        │  │
   │  │ (DaemonSet, host) │               │       │  Alertmanager    │        │  │
   │  └───────────────────┘               │       │  group/dedupe/   │        │  │
   │  ┌───────────────────┐               │       │  inhibit/route   │        │  │
   │  │ kube-state-metrics│◀──── scrape ──┤       └────────┬─────────┘        │  │
   │  │ (object state)    │               │                │ webhook          │  │
   │  └───────────────────┘               │                ▼                  │  │
   │  ┌───────────────────┐               │        demo-api POST /alerts      │  │
   │  │ kubelet / cAdvisor│◀──── scrape ──┤                                   │  │
   │  └───────────────────┘               │       ┌──────────────────┐        │  │
   │                                      │       │     Grafana      │        │  │
   │                                      │◀──────┤  PromQL queries  │        │  │
   │                                      │       │  2 dashboards    │        │  │
   │                                      └───────┴──────────────────┴────────┘  │
   └────────────────────────────────────────────────────────────────────────────┘
```

---

## The Prometheus model — pull, not push

Prometheus **pulls** metrics over HTTP. Your app doesn't send anything anywhere; it just exposes a `/metrics` endpoint returning plain text, and Prometheus GETs it every `scrape_interval`:

```
# HELP http_requests_total Total HTTP requests
# TYPE http_requests_total counter
http_requests_total{method="GET",route="/api/orders",status="200",service="demo-api"} 1834
http_request_duration_seconds_bucket{route="/api/orders",le="0.05"} 1201
http_request_duration_seconds_bucket{route="/api/orders",le="0.1"}  1755
http_request_duration_seconds_bucket{route="/api/orders",le="+Inf"} 1834
```

Why pull wins in Kubernetes:

- **Discovery is automatic.** Pods come and go; Prometheus asks the API server what exists and adjusts. Nothing to reconfigure on deploy.
- **`up` is free.** If a scrape fails, Prometheus records `up == 0` for that target — target health is a metric you can alert on with no extra work.
- **No app-side buffering.** The app has no queue, no retry, no knowledge of where metrics go.

The exception is short-lived batch jobs that die before a scrape can happen — those push to a **Pushgateway**.

### The four metric types

| Type | Behaviour | Example | Query with |
|---|---|---|---|
| **Counter** | Only increases; resets to 0 on restart | `http_requests_total` | `rate()` / `increase()` — **never** the raw value |
| **Gauge** | Goes up and down | `http_requests_in_flight`, memory usage | direct, `avg_over_time()`, `delta()` |
| **Histogram** | Buckets observations; gives quantiles server-side | `http_request_duration_seconds` | `histogram_quantile()` over `_bucket` |
| **Summary** | Client-computed quantiles; cannot be aggregated across pods | request size | direct (rarely the right choice) |

> **The mistake nearly everyone makes:** graphing a Counter directly. `http_requests_total` is a monotonically increasing number — the graph is a meaningless upward ramp. You almost always want `rate(http_requests_total[5m])`, which converts it to per-second change and correctly handles counter resets when a pod restarts.

### How Prometheus finds targets

`kubernetes_sd_configs` lists objects from the API server, then `relabel_configs` decide which to keep and how to address them. In this project, pods opt in with three annotations:

```yaml
annotations:
  prometheus.io/scrape: "true"
  prometheus.io/path:   "/metrics"
  prometheus.io/port:   "3000"
```

The `kubernetes-pods` job keeps only pods with `scrape="true"`, rewrites `__address__` to `pod_ip:3000`, and maps pod labels onto the resulting metrics. See [stack/11-prometheus-config.yaml](stack/11-prometheus-config.yaml) — every relabel step is commented.

> In production with the Prometheus Operator you'd use **ServiceMonitor** CRDs instead of annotations. Same mechanism underneath — the Operator generates this exact scrape config for you.

---

## Recording rules vs alerting rules

Both live in [stack/12-prometheus-rules.yaml](stack/12-prometheus-rules.yaml).

**Recording rules** precompute an expensive query on a schedule and save the result as a new series. A dashboard with 8 panels refreshing every 10s re-runs every query every time; if one is a heavy `histogram_quantile` over millions of series, you're recomputing it constantly. Record it once, query the cheap result:

```yaml
- record: service:http_latency_p95:5m
  expr: histogram_quantile(0.95, sum by (service, le) (rate(http_request_duration_seconds_bucket[5m])))
```

Naming convention is `level:metric:operation` — the colons are what mark a series as derived.

**Alerting rules** evaluate a condition and, once it has held for the `for:` duration, push an alert to Alertmanager:

```yaml
- alert: HighErrorRate
  expr: service:http_error_ratio:rate5m > 0.05
  for: 2m                    # must hold 2 minutes — kills flapping
  labels:
    severity: critical       # Alertmanager routes on this
  annotations:
    summary: "..."           # what the human reads
    runbook_url: "..."       # what they do about it
```

Note the alert *uses* the recording rule. That's the pattern: record once, alert and dashboard off the same series, so the number on the graph is provably the number that fired the page.

### Alert on symptoms, not causes

`NodeHighCPU` is a *cause*. It might mean nothing — the box could be busy and perfectly healthy. `HighErrorRate` and `HighLatencyP95` are *symptoms* users actually feel. Page on symptoms; make causes warnings that help you diagnose. That single principle is most of what separates a noisy alerting setup from a useful one.

---

## Alertmanager — why it exists

Prometheus decides *what* is wrong. Alertmanager decides *who gets told, how often, and together with what*. Without it, 40 pods failing produces 40 pages.

| Feature | What it does |
|---|---|
| **Grouping** | `group_by: [alertname, namespace]` — 40 failing pods become one notification |
| **`group_wait`** | Wait 10s before sending, to collect more of the same group |
| **`repeat_interval`** | Don't re-send an unchanged alert for an hour |
| **Inhibition** | Suppress the `warning` when the `critical` for the same thing is already firing |
| **Silences** | Mute known/planned noise during a maintenance window |
| **Routing tree** | `severity=critical` → PagerDuty; everything else → Slack |

In this project the receiver is a webhook pointing at the demo app's `POST /alerts`, so you can watch a real alert land with `kubectl logs`. See [stack/20-alertmanager.yaml](stack/20-alertmanager.yaml).

---

## The exporters

**node-exporter** ([stack/30-node-exporter.yaml](stack/30-node-exporter.yaml)) — a DaemonSet with `hostNetwork`, `hostPID`, and `/proc`, `/sys`, `/` mounted read-only, so it reports the *host's* CPU/memory/disk rather than the container's namespaced view. Gives you `node_cpu_seconds_total`, `node_memory_MemAvailable_bytes`, `node_filesystem_avail_bytes`.

**kube-state-metrics** ([stack/31-kube-state-metrics.yaml](stack/31-kube-state-metrics.yaml)) — listens to the API server and exposes the *state of objects*. The distinction that trips people up:

| | cAdvisor / node-exporter | kube-state-metrics |
|---|---|---|
| Answers | "how much CPU is this container using?" | "does this Deployment have all its replicas?" |
| Source | kernel / cgroups | Kubernetes API |
| Examples | `container_memory_working_set_bytes` | `kube_pod_status_phase`, `kube_deployment_status_replicas_available`, `kube_pod_container_status_restarts_total` |

Nearly every Kubernetes-level alert (CrashLooping, PodNotReady, ReplicasMismatch) is built on `kube_*` metrics.

**cAdvisor** is built into the kubelet — no deployment needed, just a scrape job hitting `/metrics/cadvisor` through the API server proxy.

---

## Grafana provisioning

Anything you click into the Grafana UI lives only in its database and dies with the pod. **Provisioning** declares datasources and dashboards as files:

- [stack/40-grafana-provisioning.yaml](stack/40-grafana-provisioning.yaml) — the Prometheus and Alertmanager datasources, plus a file-based dashboard provider watching `/var/lib/grafana/dashboards`.
- [stack/41-grafana-dashboards.yaml](stack/41-grafana-dashboards.yaml) — two dashboards as JSON in a ConfigMap:
  - **Demo API — RED**: request rate, error ratio, p50/p95/p99, rate by route, per-pod distribution, business orders, in-flight saturation.
  - **Cluster Health**: node CPU/memory, per-pod container CPU/memory, restarts, desired vs available replicas, scrape targets up.

That's what makes the whole stack reproducible — `kubectl delete ns monitoring` then re-apply, and the dashboards come back identical.

---

## Cardinality — the one thing that will break your Prometheus

Every unique combination of metric name + labels is a **separate time series**, held in memory. Cardinality is multiplicative:

```
http_requests_total{method, route, status}
   4 methods  ×  20 routes  ×  6 statuses  =  480 series      ← fine
```

Add a label with unbounded values and it explodes:

```
   ... × 50,000 user_ids  =  24,000,000 series                ← Prometheus is dead
```

**Never** use as a label: user ID, request ID, trace ID, session ID, email, full URL with query string, timestamp, or anything unbounded. Those belong in **logs**, not metrics. That's why [app/server.js](app/server.js) labels by `req.route.path` (the *pattern*, `/api/orders`) and never `req.path` (which for `/api/orders/12345` would create a series per order).

Symptoms of a cardinality problem: Prometheus memory climbing steadily, slow queries, OOMKills. Diagnose with:

```promql
topk(10, count by (__name__)({__name__=~".+"}))
```

---

## PromQL crash course

```promql
# Per-second request rate over 5 minutes, by status
sum by (status) (rate(http_requests_total[5m]))

# Error ratio (clamp_min avoids divide-by-zero when traffic is 0)
sum(rate(http_requests_total{status=~"5.."}[5m]))
  / clamp_min(sum(rate(http_requests_total[5m])), 0.001)

# p95 latency — `le` MUST survive the by() clause or this returns nothing
histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))

# Node CPU utilisation %
100 - (avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)

# Pods not Running
sum by (namespace, pod) (kube_pod_status_phase{phase!="Running"}) > 0

# Memory as a fraction of the container's limit
container_memory_working_set_bytes{container!=""}
  / on (namespace, pod, container) kube_pod_container_resource_limits{resource="memory"}

# Which targets are down
up == 0
```

**Rules of thumb:** the range in `rate(...[5m])` should be at least 4× the scrape interval; `rate()` for per-second, `increase()` for a total over a window; `sum` before `histogram_quantile`, never after.

---

## What to do next

1. [RUN-STEPS.md](RUN-STEPS.md) — bring it up on Colima/k3s and drive it end to end: watch targets appear, fire a real alert, see it arrive at the webhook.
2. [INTERNALS.md](INTERNALS.md) — how a scrape actually works, the TSDB, staleness, relabeling order, and the alert state machine.
3. [INTERVIEW.md](INTERVIEW.md) — Q&A with scenarios.
