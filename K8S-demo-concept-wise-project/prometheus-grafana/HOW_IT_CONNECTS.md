# How It Connects — every hop, and the exact line that configures it

This traces the **complete journey of a single number** — from the Linux kernel on a node, through node-exporter, into Prometheus, out to Grafana, and onto a pixel in your browser. At every hop: what talks to what, over what address, and **which file and line makes that happen**.

The worked example is **node CPU**, because it's the longest path. The same seven stages apply to every metric in the stack.

---

## The one mechanism behind everything: Service DNS

Every Service in Kubernetes gets an automatic DNS name:

```
<service-name>.<namespace>.svc.cluster.local
```

So `prometheus` in namespace `monitoring` is reachable from any pod as `prometheus.monitoring.svc:9090`. That's why no config in this project contains a hardcoded pod IP — the addresses are all Service DNS names, and they stay correct when pods are rescheduled.

The exception is **scrape targets**: Prometheus deliberately talks to **pod IPs directly**, never through a Service. More on why in Stage 3.

---

## The whole path in one picture

```
  ① Linux kernel on the node
        /proc/stat  ── counters the kernel has always maintained
             │  read by
             ▼
  ② node-exporter pod  (DaemonSet, one per node)
        translates /proc into Prometheus text format
        serves it on :9100/metrics — and just waits
             │  HTTP GET every 15s
             ▼
  ③ Prometheus pod
        found the target by asking the K8s API (service discovery)
        stores samples in its local TSDB
             │  PromQL over HTTP
             ▼
  ④ Grafana pod
        backend queries prometheus.monitoring.svc:9090
        returns JSON to the browser
             │
             ▼
  ⑤ Your browser  →  a line on a graph
```

Five components, four network hops. Now each one in detail.

---

## Stage 1 — The kernel already has the data

Nothing collects anything yet. The Linux kernel has always kept cumulative counters in `/proc`:

```bash
$ cat /proc/stat
cpu  219847 1834 58291 8472913 4821 0 3947 0 0 0
     ^user  ^nice ^sys  ^idle   ^iowait ...
```

Those are **jiffies since boot** — monotonically increasing counters. This is the raw truth; everything downstream is just transport and formatting.

The same is true for `/proc/meminfo` (memory), `/proc/net/dev` (network), and `/sys/block/*` (disk).

---

## Stage 2 — node-exporter reads the host and exposes it

### Why a DaemonSet

**Configured in:** [stack/30-node-exporter.yaml:6](stack/30-node-exporter.yaml) — `kind: DaemonSet`

A DaemonSet guarantees **exactly one pod on every node**, automatically, including nodes added later. A Deployment with `replicas: 3` would let the scheduler put all three on one node and leave the others unmonitored — useless for host metrics, where the whole point is per-host coverage.

```bash
kubectl get ds -n monitoring node-exporter
# DESIRED   CURRENT   READY   NODE SELECTOR   AGE
# 1         1         1       <none>          5m     ← DESIRED always equals node count
```

### How it reaches the host's real data

A container normally sees a namespaced view of the system — its own cgroup limits, not the machine's. Four settings break out of that:

| Setting | Line | What it does |
|---|---|---|
| `hostNetwork: true` | [:21](stack/30-node-exporter.yaml) | Pod shares the **node's** network namespace, so the **pod IP is the node IP** and port 9100 is open on the host itself |
| `hostPID: true` | [:22](stack/30-node-exporter.yaml) | Sees host processes, not just its own |
| `hostPath` volumes | [:53-58](stack/30-node-exporter.yaml) | Mounts the node's real `/proc`, `/sys`, `/` into the container |
| `--path.procfs` etc. | [:30-32](stack/30-node-exporter.yaml) | **Tells node-exporter to read those mounted paths** instead of its own `/proc` |

```yaml
# stack/30-node-exporter.yaml
hostNetwork: true                        # line 21
hostPID: true                            # line 22
args:
  - --path.procfs=/host/proc             # line 30  ← read the MOUNTED host proc
  - --path.sysfs=/host/sys               # line 31
  - --path.rootfs=/host/root             # line 32
volumeMounts:
  - { name: proc, mountPath: /host/proc, readOnly: true }   # line 39-41
volumes:
  - name: proc
    hostPath: { path: /proc }            # line 53-54  ← the node's actual /proc
```

> **The classic misconfiguration:** mounting the volumes but forgetting the `--path.*` args. node-exporter then reads its *own* `/proc`, reports a few MB of memory and no real disks, and looks perfectly healthy while being completely wrong. Both halves are required.

### What it produces

node-exporter converts `/proc/stat` into Prometheus text format and serves it at `:9100/metrics`:

```
# HELP node_cpu_seconds_total Seconds the CPUs spent in each mode.
# TYPE node_cpu_seconds_total counter
node_cpu_seconds_total{cpu="0",mode="idle"}   84729.13
node_cpu_seconds_total{cpu="0",mode="user"}   2198.47
node_cpu_seconds_total{cpu="0",mode="system"} 582.91
node_memory_MemAvailable_bytes 3847291392
```

**Verify it yourself:**

```bash
NE=$(kubectl get pod -n monitoring -l app=node-exporter -o jsonpath='{.items[0].metadata.name}')
kubectl exec -n monitoring $NE -- wget -qO- localhost:9100/metrics | grep node_cpu_seconds_total | head -4
```

**Critically: node-exporter now does nothing.** It doesn't connect to Prometheus. It doesn't know Prometheus exists. It's an HTTP server sitting there waiting to be asked. All the initiative is on Prometheus's side — that's what "pull-based" means.

---

## Stage 3 — Prometheus discovers the target and scrapes it

This stage has three separate questions: how Prometheus *finds* node-exporter, how it's *allowed* to, and how it *fetches*.

### 3a. Finding it — the headless Service + endpoints discovery

**Configured in:** [stack/30-node-exporter.yaml:60-70](stack/30-node-exporter.yaml) (the Service) and [stack/11-prometheus-config.yaml:77-86](stack/11-prometheus-config.yaml) (the scrape job)

```yaml
# stack/30-node-exporter.yaml — line 61 onward
kind: Service
metadata:
  name: node-exporter
spec:
  clusterIP: None          # line 68 — HEADLESS
  selector:
    app: node-exporter
  ports:
    - { name: metrics, port: 9100 }
```

`clusterIP: None` makes it **headless** — no virtual IP, no load balancing. Its only job here is to make Kubernetes maintain an **Endpoints** object listing every matching pod:

```bash
kubectl get endpoints -n monitoring node-exporter
# NAME            ENDPOINTS           AGE
# node-exporter   192.168.5.15:9100   5m     ← one entry per node
```

Prometheus watches that list:

```yaml
# stack/11-prometheus-config.yaml — line 77
- job_name: node-exporter
  kubernetes_sd_configs:
    - role: endpoints              # line 79 — list all Endpoints in the cluster
  relabel_configs:
    - source_labels: [__meta_kubernetes_endpoints_name]
      action: keep                 # line 82 — throw away everything...
      regex: node-exporter         # line 83 — ...except this one
    - source_labels: [__meta_kubernetes_endpoint_node_name]
      action: replace
      target_label: node           # line 86 — stamp which node each came from
```

`role: endpoints` lists **every** Endpoints object in the cluster; the `keep` rule filters to just node-exporter's. Because the Service is headless, **each pod is its own target** — on a 5-node cluster this yields 5 targets automatically, with no config change when nodes are added or removed.

The last rule copies the node name into a `node` label. That's why `node_cpu_seconds_total` is attributable to a specific machine in Grafana.

**Why not scrape through the Service IP?** A normal ClusterIP Service load-balances — each scrape would hit a random pod, so you'd get one node's metrics labelled ambiguously and the rest never scraped. Targets must always be individual pods.

### 3b. Being allowed to — RBAC

**Configured in:** [stack/10-prometheus-rbac.yaml](stack/10-prometheus-rbac.yaml)

Service discovery is an API call, so Prometheus needs permission:

```yaml
rules:
  - apiGroups: [""]
    resources: [nodes, nodes/proxy, nodes/metrics, services, endpoints, pods]
    verbs: ["get", "list", "watch"]
```

Bound to the `prometheus` ServiceAccount, which the pod runs as via [stack/13-prometheus.yaml:22](stack/13-prometheus.yaml) (`serviceAccountName: prometheus`).

> **This is the #1 cause of an empty targets page.** Without RBAC, discovery silently returns nothing — no error in the UI, just no targets. Check with:
> ```bash
> kubectl logs -n monitoring deploy/prometheus | grep -i forbidden
> ```

### 3c. How Prometheus knows to do any of this — the ConfigMap mount

**Configured in:** [stack/11-prometheus-config.yaml](stack/11-prometheus-config.yaml) (the ConfigMap) → [stack/13-prometheus.yaml:31,38-44,54-60](stack/13-prometheus.yaml) (the mount)

The config isn't baked into the image. It's a ConfigMap mounted as a file:

```yaml
# stack/13-prometheus.yaml
args:
  - --config.file=/etc/prometheus/prometheus.yml   # line 31 — read config from here
volumeMounts:
  - { name: config, mountPath: /etc/prometheus }        # line 39-40
  - { name: rules,  mountPath: /etc/prometheus/rules }  # line 41-42
volumes:
  - name: config
    configMap: { name: prometheus-config }           # line 55-57
  - name: rules
    configMap: { name: prometheus-rules }            # line 58-60
```

So: ConfigMap `prometheus-config` → file `/etc/prometheus/prometheus.yml` → read at startup by the `--config.file` flag. Editing the ConfigMap and reloading changes behaviour with no image rebuild:

```bash
kubectl exec -n monitoring deploy/prometheus -- ls -l /etc/prometheus/
kubectl exec -n monitoring deploy/prometheus -- cat /etc/prometheus/prometheus.yml | head -20
```

### 3d. The actual scrape

Every 15 seconds (`scrape_interval`, [stack/11-prometheus-config.yaml:9](stack/11-prometheus-config.yaml)), Prometheus makes a plain HTTP GET:

```
GET http://192.168.5.15:9100/metrics
User-Agent: Prometheus/2.54.1
```

It parses the response, attaches the target labels (`job="node-exporter"`, `instance="192.168.5.15:9100"`, `node="..."`), and appends each sample to the TSDB with a timestamp. It also records `up{job="node-exporter"} 1` for the scrape itself.

**See the target in the UI:** http://localhost:30090/targets — or:

```bash
curl -s localhost:30090/api/v1/targets | python3 -m json.tool | grep -A3 node-exporter | head -20
```

---

## Stage 4 — Where the data lives, and where you can see it first

**Configured in:** [stack/13-prometheus.yaml:32-33,43-44,63-64](stack/13-prometheus.yaml)

```yaml
args:
  - --storage.tsdb.path=/prometheus              # line 32
  - --storage.tsdb.retention.time=6h             # line 33
volumeMounts:
  - { name: data, mountPath: /prometheus }       # line 43-44
volumes:
  - name: data
    emptyDir: {}                                 # line 63-64 — demo only!
```

Samples go into an in-memory head block backed by a WAL, flushed to disk blocks every 2 hours. **`emptyDir` means all metrics are lost when the pod restarts** — fine for learning, never for production (use a PVC, or ship to Thanos/Mimir/AMP).

**The data is queryable in Prometheus itself before Grafana is involved at all.** This is the checkpoint that isolates "is the data there?" from "is Grafana configured right?":

```bash
# Raw counter
curl -sG localhost:30090/api/v1/query --data-urlencode \
  'query=node_cpu_seconds_total{mode="idle"}' | python3 -m json.tool

# The actual CPU-utilisation expression
curl -sG localhost:30090/api/v1/query --data-urlencode \
  'query=100 - (avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)'
```

Or in the browser at **http://localhost:30090/graph**. If it works here and not in Grafana, the problem is Grafana — Stage 5.

---

## Stage 5 — Grafana connects to Prometheus

**Configured in:** [stack/40-grafana-provisioning.yaml:15-20](stack/40-grafana-provisioning.yaml) → mounted by [stack/42-grafana.yaml:39-40,59-63](stack/42-grafana.yaml)

```yaml
# stack/40-grafana-provisioning.yaml
datasources:
  - name: Prometheus
    type: prometheus                                   # line 16
    access: proxy                                      # line 17
    url: http://prometheus.monitoring.svc:9090         # line 18  ← Service DNS
    isDefault: true
```

That file is mounted into Grafana's provisioning directory:

```yaml
# stack/42-grafana.yaml
volumeMounts:
  - name: provisioning-datasources
    mountPath: /etc/grafana/provisioning/datasources    # line 39-40
volumes:
  - name: provisioning-datasources
    configMap:
      name: grafana-provisioning
      items:
        - { key: datasources.yaml, path: datasources.yaml }   # line 59-63
```

Grafana scans that directory at startup and creates the datasource. **This is what makes the setup reproducible** — a datasource clicked into the UI lives only in Grafana's internal database and dies with the pod.

### `access: proxy` — the detail that matters

With `proxy`, **Grafana's backend** makes the PromQL query. Your browser talks only to Grafana:

```
browser ──▶ grafana:3000 ──▶ prometheus.monitoring.svc:9090
```

With `direct` (deprecated), the browser would query Prometheus itself — requiring Prometheus to be reachable from your laptop and exposing credentials client-side. Proxy also means the datasource URL is resolved **inside the cluster**, which is why `prometheus.monitoring.svc` works even though your laptop can't resolve that name.

**Verify the connection:**

```bash
kubectl exec -n monitoring deploy/grafana -- wget -qO- http://prometheus.monitoring.svc:9090/-/healthy
# Prometheus Server is Healthy.

curl -s -u admin:admin localhost:30030/api/datasources | python3 -m json.tool | grep -E '"name"|"url"'
```

---

## Stage 6 — The dashboard asks the question

**Configured in:** [stack/41-grafana-dashboards.yaml:209](stack/41-grafana-dashboards.yaml) → provider [stack/40-grafana-provisioning.yaml:35-44](stack/40-grafana-provisioning.yaml) → mount [stack/42-grafana.yaml:43-44,71-73](stack/42-grafana.yaml)

The "Node CPU utilisation %" panel is literally a PromQL string in JSON:

```json
{
  "type": "timeseries",
  "title": "Node CPU utilisation %",
  "targets": [
    { "expr": "100 - (avg by (instance) (rate(node_cpu_seconds_total{mode=\"idle\"}[5m])) * 100)",
      "legendFormat": "{{instance}}" }
  ]
}
```

That expression is the whole translation from kernel counters to a percentage:

1. `node_cpu_seconds_total{mode="idle"}` — cumulative idle seconds (the counter from `/proc/stat`).
2. `rate(...[5m])` — idle **seconds per second** over 5 minutes. A fully idle core gives 1.0.
3. `avg by (instance)` — average across all cores on that node.
4. `* 100` — as a percentage idle.
5. `100 - ...` — invert to percentage **busy**.

How the JSON reaches Grafana, in three linked pieces:

```yaml
# 40-grafana-provisioning.yaml — the provider tells Grafana WHERE to look
providers:
  - name: default
    type: file
    options:
      path: /var/lib/grafana/dashboards        # line 44

# 42-grafana.yaml — the ConfigMap is mounted at exactly that path
volumeMounts:
  - name: dashboards
    mountPath: /var/lib/grafana/dashboards     # line 43-44
volumes:
  - name: dashboards
    configMap: { name: grafana-dashboards }    # line 71-73
```

**Verify the files landed:**

```bash
kubectl exec -n monitoring deploy/grafana -- ls -l /var/lib/grafana/dashboards/
# cluster-dashboard.json   red-dashboard.json

kubectl exec -n monitoring deploy/grafana -- cat /etc/grafana/provisioning/dashboards/dashboards.yaml
```

---

## Stage 7 — Browser to pixel

1. You open **http://localhost:30030** → the NodePort ([stack/42-grafana.yaml:92](stack/42-grafana.yaml)) forwards to the Grafana pod on 3000.
2. You open the Cluster Health dashboard. The browser calls Grafana's own API:
   `POST /api/ds/query` with the panel's PromQL expression and time range.
3. **Grafana's backend** (not the browser) issues:
   `GET http://prometheus.monitoring.svc:9090/api/v1/query_range?query=100-...&start=...&end=...&step=15s`
4. Prometheus reads the TSDB, evaluates the expression over the range, returns JSON time series.
5. Grafana reshapes it into data frames and returns them to the browser.
6. The browser renders the line.

Every 30 seconds (`"refresh": "30s"` in the dashboard JSON), steps 2–6 repeat.

> A 7-panel dashboard refreshing every 30s is **14 PromQL queries a minute**. With 20 people watching, that's 280/min against one Prometheus. This is how teams accidentally overload their own monitoring — worth knowing before you set `refresh: 5s`.

---

## The same seven stages for the other three sources

The pattern never changes: *something exposes `/metrics` → Prometheus discovers and pulls it → Grafana queries Prometheus.* Only the **discovery** step differs.

| | Exposed by | Discovery | Selected by | Target address | Configured in |
|---|---|---|---|---|---|
| **demo-api** | Your own code, `prom-client` | `role: pod` | `prometheus.io/scrape: "true"` annotation | pod IP:3000 | [app/app.yaml:25-28](app/app.yaml), [11-prometheus-config.yaml:38-75](stack/11-prometheus-config.yaml) |
| **node-exporter** | The exporter binary | `role: endpoints` | endpoints named `node-exporter` | node IP:9100 | [30-node-exporter.yaml](stack/30-node-exporter.yaml), [11-prometheus-config.yaml:77-86](stack/11-prometheus-config.yaml) |
| **kube-state-metrics** | The KSM binary watching the API | `role: endpoints` | endpoints named `kube-state-metrics` | pod IP:8080 | [31-kube-state-metrics.yaml](stack/31-kube-state-metrics.yaml), [11-prometheus-config.yaml:93-101](stack/11-prometheus-config.yaml) |
| **kubelet / cAdvisor** | Built into the kubelet | `role: node` | every node | API server proxy → kubelet | [11-prometheus-config.yaml:104-143](stack/11-prometheus-config.yaml) |

### The demo-api variation

The app opts in with annotations on the **pod template** ([app/app.yaml:25-28](app/app.yaml)):

```yaml
annotations:
  prometheus.io/scrape: "true"
  prometheus.io/path: "/metrics"
  prometheus.io/port: "3000"
```

and the scrape job rewrites the target address from those annotations:

```yaml
# 11-prometheus-config.yaml — line 52-56
- source_labels: [__address__, __meta_kubernetes_pod_annotation_prometheus_io_port]
  action: replace
  regex: ([^:]+)(?::\d+)?;(\d+)
  replacement: $1:$2
  target_label: __address__
```

Given `__address__ = "10.42.0.15:80"` and the annotation `"3000"`, the joined string is `10.42.0.15:80;3000`; `$1` captures the IP, `$2` the port, giving `10.42.0.15:3000`.

**Consequence: adding a new service to monitoring is a 3-line change in that service's own manifest.** No Prometheus config edit, no restart, no platform-team ticket.

### The kubelet/cAdvisor variation

The kubelet's port 10250 is TLS-protected and often not directly routable, so Prometheus goes **through the API server**:

```yaml
# 11-prometheus-config.yaml — line 138-143
- target_label: __address__
  replacement: kubernetes.default.svc:443                    # talk to the API server
- source_labels: [__meta_kubernetes_node_name]
  target_label: __metrics_path__
  replacement: /api/v1/nodes/$1/proxy/metrics/cadvisor       # which forwards to the kubelet
```

Authentication uses the pod's own ServiceAccount token, auto-mounted at `/var/run/secrets/kubernetes.io/serviceaccount/token` — which is why the ClusterRole needs `nodes/proxy` and the `nonResourceURLs` grant.

---

## The alert path — the one thing that pushes

Everything above is pull. Alerts are the exception, because they're events, not samples.

```
Prometheus rule evaluation (every 15s)
   │  condition true for the full `for:` duration
   ▼  HTTP POST — Prometheus PUSHES here
Alertmanager  (alertmanager.monitoring.svc:9093)
   │  group → inhibit → silence → route
   ▼  HTTP POST webhook
demo-api  (demo-api.demo.svc:3000/alerts)
   │
   ▼  console.log
kubectl logs -n demo -l app=demo-api
```

| Hop | Address | Configured in |
|---|---|---|
| Prometheus → Alertmanager | `alertmanager.monitoring.svc:9093` | [11-prometheus-config.yaml:15-18](stack/11-prometheus-config.yaml) `alerting:` block |
| Rules that fire | — | [12-prometheus-rules.yaml](stack/12-prometheus-rules.yaml) |
| Alertmanager → receiver | `demo-api.demo.svc:3000/alerts` | [20-alertmanager.yaml:34-39](stack/20-alertmanager.yaml) `receivers:` |
| Receiver logs it | — | [app/server.js](app/server.js) `POST /alerts` handler |

Note it crosses namespaces: Alertmanager in `monitoring` posts to a Service in `demo`, using the fully-qualified DNS name. RUN-STEPS step 8 walks through firing this live.

---

## Debugging: which hop is broken?

Test each hop in order. The first failure tells you exactly where to look.

```bash
# HOP 1 — does the exporter expose anything at all?
NE=$(kubectl get pod -n monitoring -l app=node-exporter -o jsonpath='{.items[0].metadata.name}')
kubectl exec -n monitoring $NE -- wget -qO- localhost:9100/metrics | head -5
#   fails -> node-exporter itself is broken (check its logs, hostPath mounts)

# HOP 2 — did Prometheus discover the target?
curl -s localhost:30090/api/v1/targets | grep -o '"job":"[^"]*"' | sort -u
#   missing -> RBAC, or the relabel `keep` rule, or the Service/Endpoints

# HOP 3 — is the target healthy?
curl -s 'localhost:30090/api/v1/query?query=up' | python3 -m json.tool | grep -B2 '"0"'
#   up==0 -> network path or wrong port; the /targets page shows the error text

# HOP 4 — is the data actually stored?
curl -sG localhost:30090/api/v1/query --data-urlencode 'query=node_cpu_seconds_total' | head -c 300
#   empty -> scrape is succeeding but returning nothing useful; check metric names

# HOP 5 — can Grafana reach Prometheus?
kubectl exec -n monitoring deploy/grafana -- wget -qO- http://prometheus.monitoring.svc:9090/-/healthy
#   fails -> datasource URL wrong, or NetworkPolicy blocking cross-pod traffic

# HOP 6 — did the dashboards get mounted?
kubectl exec -n monitoring deploy/grafana -- ls /var/lib/grafana/dashboards/
#   empty -> ConfigMap not mounted, or the provider path doesn't match the mountPath
```

**The rule:** always test the source before blaming the sink. Nine times out of ten "Grafana shows no data" is actually a broken scrape three hops upstream.

---

## Every address in one table

| From | To | Address | Protocol | Configured in |
|---|---|---|---|---|
| Prometheus | demo-api pods | `<pod-ip>:3000/metrics` | HTTP pull | [11-prometheus-config.yaml:35](stack/11-prometheus-config.yaml) + pod annotations |
| Prometheus | node-exporter | `<node-ip>:9100/metrics` | HTTP pull | [11-prometheus-config.yaml:77](stack/11-prometheus-config.yaml) |
| Prometheus | kube-state-metrics | `<pod-ip>:8080/metrics` | HTTP pull | [11-prometheus-config.yaml:93](stack/11-prometheus-config.yaml) |
| Prometheus | kubelet/cAdvisor | `kubernetes.default.svc:443/api/v1/nodes/*/proxy/metrics*` | HTTPS pull + SA token | [11-prometheus-config.yaml:105](stack/11-prometheus-config.yaml) |
| Prometheus | K8s API (discovery) | `kubernetes.default.svc:443` | HTTPS + SA token | [10-prometheus-rbac.yaml](stack/10-prometheus-rbac.yaml) |
| Prometheus | Alertmanager | `alertmanager.monitoring.svc:9093` | HTTP **push** | [11-prometheus-config.yaml:15](stack/11-prometheus-config.yaml) |
| Alertmanager | demo-api | `demo-api.demo.svc:3000/alerts` | HTTP **push** | [20-alertmanager.yaml:39](stack/20-alertmanager.yaml) |
| Grafana | Prometheus | `prometheus.monitoring.svc:9090` | HTTP query | [40-grafana-provisioning.yaml:18](stack/40-grafana-provisioning.yaml) |
| Grafana | Alertmanager | `alertmanager.monitoring.svc:9093` | HTTP query | [40-grafana-provisioning.yaml:27](stack/40-grafana-provisioning.yaml) |
| kube-state-metrics | K8s API | `kubernetes.default.svc:443` | HTTPS watch | [31-kube-state-metrics.yaml](stack/31-kube-state-metrics.yaml) |
| Browser | Grafana | `localhost:30030` | NodePort | [42-grafana.yaml:92](stack/42-grafana.yaml) |
| Browser | Prometheus | `localhost:30090` | NodePort | [13-prometheus.yaml:81](stack/13-prometheus.yaml) |
| Browser | Alertmanager | `localhost:30093` | NodePort | [20-alertmanager.yaml](stack/20-alertmanager.yaml) |
