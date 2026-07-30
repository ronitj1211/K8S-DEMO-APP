# Monitoring & NetworkPolicies — Internals

Prometheus TSDB, service discovery mechanics, CoreDNS, NetworkPolicy enforcement by CNI plugins.

---

# Part 1: Prometheus + Grafana

## Purpose

Prometheus stores time-series metrics scraped from HTTP `/metrics` endpoints. Grafana visualizes queries against Prometheus (and other datasources).

## The pull model

Every 15s (or whatever `scrape_interval`), Prometheus opens an HTTP GET to each target's `/metrics` endpoint. The target responds with a plain-text format:

```
# HELP http_requests_total Total HTTP requests
# TYPE http_requests_total counter
http_requests_total{method="GET",status="200",path="/"} 1523 1690000000000
http_requests_total{method="POST",status="500",path="/api"} 3 1690000000000
```

Each line is a `<metric>{labels} <value> <timestamp>`.

Prometheus parses, timestamps, appends to its TSDB.

**Why pull?**
- Targets don't need to know Prometheus's address.
- `up{}` metric: automatic 0/1 metric per target — you know when scraping itself is broken.
- No firehose during redeploys — Prometheus paces itself.

**When pull doesn't work**: short-lived jobs die before the next scrape. Use `pushgateway` — a service Prometheus scrapes, but that other jobs push to.

## Service discovery in K8s

Prometheus's `kubernetes_sd_configs` role provides automatic target discovery:

```yaml
- job_name: kubernetes-pods
  kubernetes_sd_configs:
    - role: pod
  relabel_configs:
    - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
      action: keep
      regex: true
```

Prometheus watches the K8s API. For every Pod, it creates a candidate target with metadata (`__meta_kubernetes_pod_name`, `__meta_kubernetes_pod_annotation_*`, `__meta_kubernetes_namespace`, ...).

**Relabel rules** filter and transform:
- `action: keep, regex: true` — only keep targets whose Pod has `prometheus.io/scrape: "true"` annotation.
- `action: replace, target_label: __address__` — rewrite the scrape target to `podIP:port` based on the pod's port annotation.
- `action: labelmap` — copy `__meta_kubernetes_pod_label_*` labels to actual labels on the scraped series.

The `__meta_*` labels are "meta" — they exist during relabel but don't get stored. Regular labels (`namespace`, `pod`, `app`) get stored on every sample.

## The TSDB — how Prometheus stores metrics

**Block structure** on disk:

```
data/
├── 01ABCD.../          ← 2-hour block
│   ├── chunks/         ← compressed sample data
│   ├── index           ← inverted index for fast label lookup
│   └── meta.json
├── 01ABCE.../          ← next 2-hour block
├── ...
└── wal/                ← write-ahead log for the current (unfinished) block
```

- Every 2 hours, the current WAL is compacted into a block.
- Blocks are compacted together over time (2h → 8h → longer).
- Old blocks are deleted per `--storage.tsdb.retention.time`.

**Sample compression**: XOR-based delta encoding for values, delta-delta for timestamps. Very efficient — ~1-2 bytes per sample amortized.

## Cardinality — the memory killer

Every unique label combination is its own **time series**. Each series has an in-memory index entry (~1-2 KB).

```
http_requests_total{method="GET", status="200"}  ← series 1
http_requests_total{method="POST", status="200"} ← series 2
http_requests_total{method="GET", status="404"}  ← series 3
```

If you add a label `user_id`, and you have 10,000 users, you now have 10,000× the series count for that metric. RAM usage explodes.

**The rule**: labels should have low cardinality — think dozens, not thousands. Never label with `request_id`, `user_id`, `session_id`, IP addresses, timestamps.

## PromQL — query language mechanics

```promql
rate(http_requests_total[5m])
```

For each series, compute the per-second rate over the last 5-minute window. Returns a **range vector** of counters transformed into rates.

```promql
sum by (status) (rate(http_requests_total[5m]))
```

Sum across all series that share the same `status` label. Effectively: total request rate per status code.

```promql
histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[5m]))
```

Server-side p99 latency, computed from bucket counts of the histogram. Works across replicas (buckets are additive).

## Prometheus scaling

Single Prometheus scales to millions of series but is fundamentally one process. For scale:

- **Federation**: hierarchical — each cluster's Prometheus scrapes locally; a central Prometheus federates only aggregated metrics.
- **Remote write**: Prometheus writes samples to an external time-series backend (Thanos, Cortex, Mimir, VictoriaMetrics) that scales horizontally.
- **Sharding**: multiple Prometheus instances each responsible for a subset of targets.

## Alertmanager

Prometheus fires alerts (evaluates alerting rules every `evaluation_interval`). Alerts are sent to Alertmanager.

Alertmanager:
- **Groups** related alerts (avoid pager spam).
- **Deduplicates** across HA Prometheus replicas.
- **Silences** alerts during maintenance windows.
- **Routes** to receivers (Slack, PagerDuty, email) based on labels.
- **Inhibits** — one alert can suppress others (e.g., "cluster down" alert suppresses individual "Pod down" alerts).

## Grafana

Grafana queries Prometheus via HTTP. Dashboards define panels; each panel is a PromQL query rendered as a chart.

Grafana can query many datasources — Prometheus, Loki (logs), Tempo (traces), CloudWatch, Postgres, MySQL, Elasticsearch. That makes it the natural "single pane of glass" across a K8s observability stack.

**Alerting in Grafana**: since Grafana 9, Grafana Alerting is a first-class subsystem — a modern alternative to Prometheus Alertmanager (though they can coexist).

---

# Part 2: NetworkPolicies

## Purpose

By default, all Pod-to-Pod traffic in a K8s cluster is allowed. NetworkPolicies let you restrict it: "these Pods can only receive traffic from those Pods."

## How enforcement works

NetworkPolicies are just **spec objects** — they don't do anything themselves. The **CNI plugin** enforces them by programming node-level firewall rules.

- **Calico**: iptables rules (or eBPF in Calico Cloud).
- **Cilium**: eBPF programs attached to network hooks.
- **kube-router** (k3s): iptables.
- **Antrea**: Open vSwitch flow rules.
- **flannel alone**: NO enforcement. Policies applied but silently ignored.

Test by applying a default-deny and verifying a Pod actually can't reach another. If it can, your CNI doesn't enforce.

## The `default-deny` pattern

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-ingress
spec:
  podSelector: {}          # ALL Pods in this namespace
  policyTypes: [Ingress]   # only ingress; egress unaffected
  # no ingress rules → deny everything
```

**Effect**: any Pod in this namespace, once matched by any NetworkPolicy, denies all ingress not explicitly allowed by another policy.

**Important semantic**: NetworkPolicies are **additive-only allow**. If a Pod is matched by any policy, it's in "deny by default" mode. If no policy matches a Pod, that Pod remains in K8s's default "allow all" mode.

## Rules structure

```yaml
spec:
  podSelector:
    matchLabels: { app: backend }        # who this policy applies to
  policyTypes: [Ingress, Egress]
  ingress:
    - from:
        - podSelector: { matchLabels: { app: frontend } }
        - namespaceSelector: { matchLabels: { name: monitoring } }
        - ipBlock:
            cidr: 10.0.0.0/24
            except: [10.0.0.5/32]
      ports:
        - protocol: TCP
          port: 8080
  egress:
    - to:
        - podSelector: { matchLabels: { app: database } }
      ports:
        - protocol: TCP
          port: 5432
```

**Selectors combine**:
- Within one `from`/`to` item: `podSelector` AND `namespaceSelector` (both must match).
- Between items in the list: OR (any item matches).
- Multiple `ingress` blocks: OR.

## What NetworkPolicy matches — Pod IPs, not Services

NetworkPolicies operate on Pod IPs after DNAT. When Pod A calls `svc.namespace.svc.cluster.local`, kube-proxy DNATs the destination to a specific Pod IP. NetworkPolicy evaluates using that final Pod IP.

**Consequence**: you selectors reason about *Pod labels*, not Service names. `podSelector: {app: backend}` covers Pods labeled `app=backend`, regardless of which Services route to them.

## Common gotchas

**DNS breaks after default-deny**:
```yaml
egress:
  # Allow DNS to CoreDNS
  - to:
      - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: kube-system } }
        podSelector: { matchLabels: { k8s-app: kube-dns } }
    ports:
      - { protocol: UDP, port: 53 }
      - { protocol: TCP, port: 53 }
```

Without this, Pods can't resolve hostnames. Every default-deny egress policy needs a DNS allowance.

**Prometheus scraping breaks after default-deny**:
Add an allow-from-monitoring rule:
```yaml
ingress:
  - from:
      - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: monitoring } }
        podSelector: { matchLabels: { app: prometheus } }
    ports:
      - { protocol: TCP, port: 3000 }
```

**hostNetwork Pods are unaffected**: NetworkPolicies target Pod networks. A Pod with `hostNetwork: true` uses the node's network stack directly — policies don't apply.

## L7 policies (Cilium)

Standard NetworkPolicy is L3/L4. For L7 (HTTP method, path, JWT claims), Cilium supports its own CRD:

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: allow-api-get-only
spec:
  endpointSelector:
    matchLabels: { app: api }
  ingress:
    - fromEndpoints:
        - matchLabels: { app: frontend }
      toPorts:
        - ports: [{ port: "8080", protocol: TCP }]
          rules:
            http:
              - method: GET
                path: /public/.*
```

Frontend can only make GET requests to /public/* on the api Pods. Cilium's eBPF programs implement this L7 inspection at the datapath level.

---

## The 30-second summary

- Prometheus **pulls** metrics from targets on a 15s schedule; K8s service discovery finds Pods via annotations.
- TSDB stores 2-hour blocks with efficient delta encoding — millions of samples per byte.
- Cardinality is the biggest scale concern: labels should be low-cardinality (dozens, not thousands).
- PromQL: `rate()`, `sum by()`, `histogram_quantile()` — the workhorse patterns.
- NetworkPolicy is a spec; a **CNI plugin** enforces it. Flannel alone doesn't enforce; Calico/Cilium/kube-router do.
- Default-deny + explicit allow is the zero-trust pattern. Common footguns: forgetting DNS and Prometheus scrape allows.
- L7 (HTTP-level) policies require Cilium (or a service mesh) — standard NetworkPolicy is L4 only.
