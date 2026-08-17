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

## What you need before you start

### Tooling

| Requirement | Why | Check |
|---|---|---|
| A Kubernetes cluster (Colima + k3s, minikube, kind, or EKS) | Everything runs in-cluster | `kubectl get nodes` |
| `kubectl` v1.25+ | Applying manifests | `kubectl version --client` |
| Docker | Building the demo app image | `docker version` |
| Internet access on first apply | Pulling the 5 upstream images | — |

**No Helm, no Prometheus Operator, and no CRDs are needed.** Everything here is plain Kubernetes objects — Deployments, a DaemonSet, ConfigMaps, Services, and RBAC. That's deliberate: you see every wire, instead of a Helm chart hiding them.

### Cluster resources

Adding up the `requests` of every pod in this project:

| | CPU requested | Memory requested | Memory limit |
|---|---|---|---|
| demo-api × 3 | 150m | 192Mi | 384Mi |
| loadgen | 10m | 16Mi | 32Mi |
| Prometheus | 100m | 512Mi | 1Gi |
| Alertmanager | 50m | 64Mi | 128Mi |
| kube-state-metrics | 50m | 64Mi | 192Mi |
| node-exporter (per node) | 50m | 32Mi | 128Mi |
| Grafana | 100m | 128Mi | 384Mi |
| **Total (1-node cluster)** | **~510m** | **~1Gi** | **~2.2Gi** |

A cluster with **2 CPUs and 4 GB** is comfortable. This is much lighter than the [elk-logging](../elk-logging/) chapter, because Prometheus stores compressed numbers rather than a full-text index.

### Images used

| Image | Where from | Purpose |
|---|---|---|
| `demo-api:1.0` | **built locally** from [app/](app/) | The instrumented sample app |
| `prom/prometheus:v2.54.1` | Docker Hub | Scraping, TSDB, rule evaluation |
| `prom/alertmanager:v0.27.0` | Docker Hub | Alert routing and delivery |
| `prom/node-exporter:v1.8.2` | Docker Hub | Host metrics |
| `registry.k8s.io/kube-state-metrics:v2.13.0` | registry.k8s.io | Kubernetes object state |
| `grafana/grafana:11.1.4` | Docker Hub | Dashboards |
| `busybox:1.36` | Docker Hub | Traffic generator |

`demo-api` is the only image you build. It uses `imagePullPolicy: IfNotPresent`, so the locally built copy is used and nothing is pulled for it.

### Two namespaces

| Namespace | Contains | Created by |
|---|---|---|
| `demo` | The application under observation — demo-api, loadgen | [app/app.yaml](app/app.yaml) |
| `monitoring` | The observability stack — Prometheus, Alertmanager, exporters, Grafana | [stack/00-namespace.yaml](stack/00-namespace.yaml) |

They're split on purpose: it mirrors production (a platform team owns `monitoring`, app teams own their own namespaces) and it forces the scraping to be genuinely **cross-namespace**, which is where RBAC and NetworkPolicy issues actually show up.

---

## What actually gets deployed

Nine pods on a single-node cluster. Here is every object and why it is the kind it is:

| Workload | Kind | Namespace | Replicas | Container port | Exposed at | Why this kind |
|---|---|---|---|---|---|---|
| **demo-api** | Deployment | `demo` | **3** | 3000 | NodePort 30300 | Stateless app — the 3 replicas exist so you can *see* per-pod metric distribution and load balancing |
| **loadgen** | Deployment | `demo` | **1** | — | — | Just needs to run somewhere; drives constant traffic so dashboards aren't flat |
| **Prometheus** | Deployment | `monitoring` | **1** | 9090 | NodePort 30090 | Local TSDB on disk — two replicas sharing one volume would corrupt it. Uses `strategy: Recreate` for the same reason |
| **Alertmanager** | Deployment | `monitoring` | **1** | 9093 | NodePort 30093 | Single instance is fine for a demo; production runs 3 with gossip clustering |
| **node-exporter** | **DaemonSet** | `monitoring` | **1 per node** | 9100 | headless Service | There is exactly one host per node, and it must read *that* host's `/proc` and `/sys` |
| **kube-state-metrics** | Deployment | `monitoring` | **1** | 8080 | headless Service | Reads the API server, not the node — one copy describes the whole cluster |
| **Grafana** | Deployment | `monitoring` | **1** | 3000 | NodePort 30030 | Stateless once dashboards are provisioned from files |

Supporting objects: 4 ConfigMaps (Prometheus config, rules, Alertmanager config, Grafana provisioning + dashboards), 2 ServiceAccounts with ClusterRoles and bindings (Prometheus, kube-state-metrics), and 6 Services.

```bash
# After deploying, this is what you should see:
kubectl get pods -n demo         # 3 demo-api + 1 loadgen  = 4 pods
kubectl get pods -n monitoring   # prometheus, alertmanager, kube-state-metrics,
                                 # grafana, node-exporter(×nodes) = 5 pods
```

### Why 3 application replicas specifically

One replica would work, but three teaches things one cannot:

- **Aggregation is visible.** `sum(rate(http_requests_total[5m]))` adds three series. With one pod you never learn that `rate()` must come *before* `sum()`.
- **Per-pod distribution is visible.** The "Per-pod request rate" panel shows whether the Service is balancing evenly across all three. If one pod is taking everything, you have a keep-alive/connection-pinning problem — a real production symptom you can only see with multiple pods.
- **The `service` label vs the `pod` label matter.** With one pod they look identical, so the distinction never registers.
- **Rolling updates are observable.** Watch the target count in Prometheus dip and recover during `kubectl rollout restart`.

### Why node-exporter must be a DaemonSet

A Deployment with `replicas: 3` gives you three pods placed by the scheduler wherever it likes — possibly all on the same node, leaving other nodes unmonitored. Host metrics need **exactly one collector per host, on every host, automatically including new nodes**. That is precisely what a DaemonSet guarantees.

Three details in [stack/30-node-exporter.yaml](stack/30-node-exporter.yaml) make it actually report the *host* rather than its own container:

```yaml
hostNetwork: true          # pod shares the node's network namespace, so the
                           # pod IP IS the node IP, and port 9100 is on the host
hostPID: true              # sees host processes, not just its own
tolerations:
  - operator: Exists       # runs even on tainted control-plane nodes
volumeMounts:
  - { name: proc, mountPath: /host/proc, readOnly: true }   # the real kernel stats
  - { name: sys,  mountPath: /host/sys,  readOnly: true }
  - { name: root, mountPath: /host/root, readOnly: true }   # real filesystem usage
args:
  - --path.procfs=/host/proc     # tell it to read the mounted host paths
  - --path.sysfs=/host/sys       # instead of its own container's /proc
  - --path.rootfs=/host/root
```

Without those mounts and args, node-exporter would happily run and report the *container's* view — a few megabytes of memory and no real disks. It would look healthy and be completely useless. This is the classic node-exporter misconfiguration.

---

## How each component sends its data to Prometheus

**Nothing "sends" anything.** Every component exposes a `/metrics` HTTP endpoint and waits; Prometheus does all the fetching. But the four components are *discovered* four different ways, and that's the part worth understanding.

```
                    ┌──────────────────────────────────────────┐
                    │            PROMETHEUS  (pulls)           │
                    │  asks the K8s API "what exists?" every    │
                    │  few seconds, then GETs each /metrics     │
                    └───┬───────┬───────────┬──────────────┬────┘
                        │       │           │              │
        ① role: pod     │       │ ② role:   │ ③ role:      │ ④ role: node
        + annotations   │       │ endpoints │ endpoints    │ + API proxy
                        ▼       ▼           ▼              ▼
                 ┌───────────┐ ┌──────────┐ ┌────────────┐ ┌──────────────┐
                 │ demo-api  │ │ node-    │ │ kube-state │ │ kubelet /    │
                 │ ×3        │ │ exporter │ │ -metrics   │ │ cAdvisor     │
                 │ :3000     │ │ :9100    │ │ :8080      │ │ :10250       │
                 │ /metrics  │ │ /metrics │ │ /metrics   │ │ /metrics     │
                 └───────────┘ └──────────┘ └────────────┘ └──────────────┘
                  app metrics   host metrics  object state   container usage
```

### ① demo-api — discovered by pod annotation

The app opts in with three annotations on the **pod template** (not the Deployment):

```yaml
annotations:
  prometheus.io/scrape: "true"      # the opt-in flag
  prometheus.io/path:   "/metrics"  # where to GET
  prometheus.io/port:   "3000"      # which port
```

The `kubernetes-pods` scrape job uses `role: pod`, which lists **every pod in the cluster**, then:

1. `action: keep` on `prometheus.io/scrape == "true"` — throws away every pod that didn't opt in.
2. Rewrites `__address__` from `pod_ip:80` to `pod_ip:3000` using the port annotation.
3. Copies pod labels onto the metrics (`app=demo-api` becomes a queryable label).
4. Drops pods that aren't Running.

Prometheus then GETs `http://10.42.0.15:3000/metrics` **directly on the pod IP** — it does *not* go through the Service. That matters: each of the 3 replicas is its own target with its own `pod` label, which is what makes per-pod panels possible. Going through the Service would give you one randomly-chosen pod per scrape and useless data.

> **Adding a new service to monitoring is therefore a 3-line change in that service's own manifest.** No Prometheus config edit, no restart. That's the whole point of annotation-based discovery.

### ② node-exporter — discovered via a headless Service's endpoints

node-exporter has a **headless Service** (`clusterIP: None`). The `node-exporter` scrape job uses `role: endpoints` and keeps only endpoints named `node-exporter`. Because the Service is headless, every backing pod appears as its own endpoint — so on a 5-node cluster you get 5 targets, automatically, with no configuration change when nodes are added or removed.

And because the pods run with `hostNetwork: true`, **the pod IP is the node IP**, so `10.0.1.23:9100` is literally the host. The relabel rule copies `__meta_kubernetes_endpoint_node_name` into a `node` label, which is how every node metric ends up attributable to a specific machine.

### ③ kube-state-metrics — also endpoints, but one target for the whole cluster

Same mechanism as node-exporter (headless Service, `role: endpoints`), but a single pod. It doesn't read any node — it **watches the Kubernetes API server** and converts object state into metrics:

```
kube_deployment_spec_replicas{deployment="demo-api"}              3
kube_deployment_status_replicas_available{deployment="demo-api"}  2      ← one missing!
kube_pod_status_phase{pod="demo-api-x", phase="Pending"}          1
kube_pod_container_status_restarts_total{pod="demo-api-x"}        7
```

This is why it needs its own ClusterRole with `list`/`watch` on pods, deployments, nodes, PVCs, HPAs and more — see [stack/31-kube-state-metrics.yaml](stack/31-kube-state-metrics.yaml). It is a *translator* from the API server to the Prometheus data model.

### ④ kubelet & cAdvisor — through the API server proxy

These need no deployment at all — the kubelet already exposes them on every node. The trick is *reaching* them, since the kubelet's port 10250 is TLS-protected and often not directly routable from a pod.

The `kubernetes-nodes` and `kubernetes-cadvisor` jobs use `role: node`, then rewrite the target to go through the API server's node proxy:

```yaml
- target_label: __address__
  replacement: kubernetes.default.svc:443          # talk to the API server...
- source_labels: [__meta_kubernetes_node_name]
  target_label: __metrics_path__
  replacement: /api/v1/nodes/$1/proxy/metrics/cadvisor    # ...which forwards to the kubelet
```

Authentication is the pod's own ServiceAccount token, mounted automatically at `/var/run/secrets/kubernetes.io/serviceaccount/token`. That's why the Prometheus ClusterRole includes `nodes/proxy` and `nodes/metrics`, plus the `nonResourceURLs` grant.

cAdvisor is where per-container resource usage comes from — `container_memory_working_set_bytes` and `container_cpu_usage_seconds_total`, the metrics that tell you an OOMKill is coming.

### Summary of the four paths

| Component | SD role | How it's selected | Target address | Gives you |
|---|---|---|---|---|
| demo-api ×3 | `pod` | `prometheus.io/scrape` annotation | pod IP : 3000 | Application RED metrics |
| node-exporter | `endpoints` | endpoints named `node-exporter` | node IP : 9100 | Host CPU, RAM, disk, network |
| kube-state-metrics | `endpoints` | endpoints named `kube-state-metrics` | pod IP : 8080 | Kubernetes object state |
| kubelet / cAdvisor | `node` | every node | API server proxy → kubelet | Container CPU/memory |

Plus Prometheus scraping **itself** via a `static_configs` target on `localhost:9090` — because if Prometheus is unhealthy, nothing else it reports can be trusted.

---

## Where the data goes after it's scraped

```
scrape ──▶ TSDB (in-memory head + WAL, flushed to disk blocks every 2h)
             │
             ├──▶ recording rules   ── every 15s, precompute and store new series
             │
             ├──▶ alerting rules    ── every 15s, evaluate conditions
             │                            │
             │                            │ condition true for `for:` duration
             │                            ▼
             │                     ┌──────────────────┐
             │                     │   Alertmanager   │ group → inhibit → route
             │                     └────────┬─────────┘
             │                              │ webhook
             │                              ▼
             │                     demo-api  POST /alerts   (visible in kubectl logs)
             │
             └──▶ HTTP query API ──▶ Grafana ──▶ your browser
```

| Component | Talks to | How | Configured in |
|---|---|---|---|
| Prometheus → Alertmanager | `alertmanager.monitoring.svc:9093` | HTTP push of firing alerts | [11-prometheus-config.yaml](stack/11-prometheus-config.yaml) `alerting:` block |
| Alertmanager → receiver | `demo-api.demo.svc:3000/alerts` | webhook POST | [20-alertmanager.yaml](stack/20-alertmanager.yaml) `receivers:` |
| Grafana → Prometheus | `prometheus.monitoring.svc:9090` | PromQL over HTTP, `access: proxy` | [40-grafana-provisioning.yaml](stack/40-grafana-provisioning.yaml) |
| You → everything | NodePort 30030 / 30090 / 30093 | browser | the Services |

Note that Grafana uses `access: proxy`, meaning **Grafana's backend** queries Prometheus — your browser never talks to Prometheus directly, so it doesn't need to be reachable from your laptop for dashboards to work.

---

## The stack at a glance

| Component | Role | Kind | Port |
|---|---|---|---|
| **demo-api** | Sample app exposing `/metrics` with RED metrics | Deployment ×3 | 30300 |
| **loadgen** | Generates constant traffic | Deployment ×1 | — |
| **Prometheus** | Scrapes targets, stores the TSDB, evaluates rules | Deployment ×1 | 30090 |
| **Alertmanager** | Dedupes, groups, routes, and delivers alerts | Deployment ×1 | 30093 |
| **node-exporter** | Host CPU / memory / disk / network | DaemonSet | 9100 |
| **kube-state-metrics** | State of K8s objects (replicas, phases, restarts) | Deployment ×1 | 8080 |
| **Grafana** | Dashboards over Prometheus | Deployment ×1 | 30030 |

```
 KUBERNETES CLUSTER
 ┌──────────────────────────────────────────────────────────────────────────┐
 │                                                                          │
 │  namespace: demo                    namespace: monitoring                │
 │  ┌────────────────────────────┐     ┌─────────────────────────────────┐  │
 │  │  demo-api  (Deployment)    │     │  PROMETHEUS  (Deployment x1)    │  │
 │  │   ┌─────┐ ┌─────┐ ┌─────┐  │     │   service discovery via K8s API │  │
 │  │   │pod 1│ │pod 2│ │pod 3│  │◀────│   TSDB  (6h, emptyDir)          │  │
 │  │   └─────┘ └─────┘ └─────┘  │  ①  │   5 recording + 11 alert rules  │  │
 │  │   each on :3000 /metrics   │     │   :9090                         │  │
 │  └────────────────────────────┘     └────────────┬────────────────────┘  │
 │  ┌────────────────────────────┐          push    │                       │
 │  │  loadgen  (Deployment x1)  │        firing    │                       │
 │  │  curls demo-api in a loop  │        alerts    ▼                       │
 │  └────────────────────────────┘     ┌─────────────────────────────────┐  │
 │              ▲                      │  ALERTMANAGER (Deployment x1)   │  │
 │              │  webhook             │   group -> inhibit -> route     │  │
 │              │  POST /alerts        │   :9093                         │  │
 │              └──────────────────────┴────────────┬────────────────────┘  │
 │                                                  │                       │
 │                                     ┌─────────────────────────────────┐  │
 │                                     │  node-exporter  (DaemonSet)     │  │
 │                            ②────────▶  ONE POD PER NODE  :9100        │  │
 │                                     │   hostNetwork + /proc,/sys      │  │
 │                                     └─────────────────────────────────┘  │
 │                                     ┌─────────────────────────────────┐  │
 │                            ③────────▶  kube-state-metrics (x1) :8080  │  │
 │                                     │   watches the API server        │  │
 │                                     └─────────────────────────────────┘  │
 │                                     ┌─────────────────────────────────┐  │
 │                                     │  GRAFANA  (Deployment x1) :3000 │  │
 │                                     │   queries Prometheus in PromQL  │  │
 │                                     │   2 provisioned dashboards      │  │
 │                                     └─────────────────────────────────┘  │
 │                                                                          │
 │  every node (not in any namespace — part of the node itself)             │
 │  ┌────────────────────────────────────────────────────────────────────┐  │
 │  │  kubelet :10250   ->  /metrics   and   /metrics/cadvisor           │  │
 │  │  ④ reached THROUGH the API server proxy, not connected directly    │  │
 │  └────────────────────────────────────────────────────────────────────┘  │
 └──────────────────────────────────────────────────────────────────────────┘

  Arrows point the way Prometheus REACHES OUT. Discovery mechanism:
  ① pod annotations   ② endpoints role   ③ endpoints role   ④ node role + API proxy
```

**Read it as: Prometheus reaches out to all four sources.** Nothing pushes metrics *to* Prometheus. The one push in this project is Prometheus → Alertmanager, because alerts are events rather than samples.

**Read it as: Prometheus reaches out to all four sources.** Nothing pushes to Prometheus. The single exception in this project is Prometheus → Alertmanager, which *is* a push, because alerts are events rather than samples.

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

## The exporters — which one answers which question

Deployment mechanics for these are covered above; what matters here is knowing *which one to query*. Three different sources produce three different kinds of metric, and mixing them up is the most common reason someone can't find the metric they need:

- **node-exporter** → `node_*` — the physical/virtual **host**. `node_cpu_seconds_total`, `node_memory_MemAvailable_bytes`, `node_filesystem_avail_bytes`.
- **cAdvisor** (built into the kubelet, nothing to deploy) → `container_*` — **resource usage per container**. `container_memory_working_set_bytes`, `container_cpu_usage_seconds_total`.
- **kube-state-metrics** → `kube_*` — the **state of Kubernetes objects** from the API server. `kube_deployment_status_replicas_available`, `kube_pod_status_phase`, `kube_pod_container_status_restarts_total`.

The distinction that trips people up:

| | cAdvisor / node-exporter | kube-state-metrics |
|---|---|---|
| Answers | "how much CPU is this container using?" | "does this Deployment have all its replicas?" |
| Source | kernel / cgroups | Kubernetes API |
| Examples | `container_memory_working_set_bytes` | `kube_pod_status_phase`, `kube_deployment_status_replicas_available`, `kube_pod_container_status_restarts_total` |

Nearly every Kubernetes-level alert (CrashLooping, PodNotReady, ReplicasMismatch) is built on `kube_*` metrics — see the `kubernetes.alerts` group in [stack/12-prometheus-rules.yaml](stack/12-prometheus-rules.yaml).

**Worked example — "is my app healthy?" needs all three:**

```promql
kube_deployment_status_replicas_available{deployment="demo-api"}   # 2 of 3 available   (kube-state-metrics)
container_memory_working_set_bytes{pod="demo-api-abc"}             # 124Mi of 128Mi     (cAdvisor)
node_memory_MemAvailable_bytes                                     # node nearly full   (node-exporter)
```

Read together: a replica is missing because it was OOMKilled, because the node is out of memory. No single exporter tells you that story.

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
