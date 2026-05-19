# EFK Logging on Kubernetes (the modern "ELK")

## What problem does this solve?

In Kubernetes, every container writes logs to `stdout` / `stderr`, and the kubelet stashes them at `/var/log/containers/*.log` on each node. That's fine for one Pod, but:

- Pods come and go — when a Pod dies, its logs are gone.
- Logs are spread across nodes — `kubectl logs` works for one Pod at a time.
- There's no search, no time-range filter, no aggregation.

You need a **centralized logging stack** that:

1. Collects logs from every Pod on every node.
2. Enriches each log line with Kubernetes context (namespace, pod, labels).
3. Stores them in a searchable index.
4. Lets you query and visualize them.

That's exactly what this stack does.

---

## The stack — EFK (not ELK)

The classic ELK stack is **E**lasticsearch + **L**ogstash + **K**ibana.

For Kubernetes, the more common modern variant is **EFK**:

- **E**lasticsearch — distributed search and storage engine. The "database" for logs.
- **F**luent Bit — tiny log collector that runs as a DaemonSet (one per node). Replaces Logstash.
- **K**ibana — web UI for searching and visualizing logs in Elasticsearch.

Why Fluent Bit instead of Logstash?

| | Logstash | Fluent Bit |
|---|----------|------------|
| Memory | ~500 MB+ | ~10–30 MB |
| Language | JVM | C |
| K8s metadata enrichment | via plugin | first-class |
| Typical deployment | central pipeline | DaemonSet |

In a real K8s cluster you almost always pick Fluent Bit (or Fluentd, its bigger sibling) for the node-level log shipper. If you genuinely need a heavy transformation pipeline, you put Logstash *between* Fluent Bit and Elasticsearch.

---

## Data flow

```
   ┌────────────────────────────────────────────────────────────┐
   │                       Worker Node                          │
   │                                                            │
   │   Pod A     Pod B     Pod C                                │
   │   stdout    stdout    stdout                               │
   │     │         │         │                                  │
   │     └────┬────┴────┬────┘                                  │
   │          ▼         ▼                                       │
   │   /var/log/containers/*.log   ← kubelet writes here        │
   │          │                                                 │
   │          ▼                                                 │
   │   ┌──────────────┐                                         │
   │   │  Fluent Bit  │   (DaemonSet — tails the log files,     │
   │   │   (per-node) │    parses CRI format, asks the K8s API  │
   │   └──────┬───────┘    for Pod labels, ships JSON out)      │
   │          │                                                 │
   └──────────┼─────────────────────────────────────────────────┘
              │
              ▼
       ┌──────────────┐
       │ Elasticsearch│  ← stores everything in indices like
       │  (cluster)   │     k8s-logs-2026.05.19
       └──────┬───────┘
              │
              ▼
       ┌──────────────┐
       │    Kibana    │  ← Discover, Lens, dashboards, alerts
       └──────────────┘
```

### What Fluent Bit actually does, step by step

1. **INPUT (tail)** — Reads new lines from `/var/log/containers/*.log` on the host. Each file name encodes the Pod name, namespace, and container, e.g.:
   ```
   sample-app-abc123_demo_app-<container-id>.log
   ```
2. **PARSER (cri)** — Each line on disk is `<time> <stream> <tag> <log>`. The CRI parser splits these out.
3. **FILTER (kubernetes)** — Hits the Kubernetes API to look up labels, annotations, namespace, Pod UID for the Pod that owns that container. Adds them to the record.
4. **Merge_Log** — If the app's `log` field is itself JSON, parse it and merge the keys into the record. So when our backend writes `{"level":"error","msg":"..."}`, those become first-class fields in Elasticsearch.
5. **OUTPUT (es)** — Bulk-ship records to Elasticsearch, into a daily index `k8s-logs-YYYY.MM.DD`.

---

## What's in this folder

```
elk-logging/
├── backend/                          # sample app that emits structured logs
│   ├── server.js                     # writes JSON to stdout (info/warn/error)
│   ├── package.json, Dockerfile
│   └── sample-app.yaml               # Deployment + Service in namespace "demo"
├── frontend/                         # button UI that hits the backend
│   ├── index.html, Dockerfile
│   └── frontend.yaml
├── orders-service/                   # SECOND demo app — different log shape (orderId, customerId, ...)
│   ├── server.js                     # POST /orders, POST /payments/charge, GET /orders/:id
│   ├── package.json, Dockerfile
│   └── orders-service.yaml           # Deployment + NodePort, 2 replicas
├── stack/                            # the EFK stack itself, in namespace "logging"
│   ├── 00-namespace.yaml             # "logging" + "demo" namespaces
│   ├── 10-elasticsearch.yaml         # ES StatefulSet + Service (single node)
│   ├── 20-kibana.yaml                # Kibana Deployment + NodePort
│   ├── 30-fluent-bit-rbac.yaml       # SA + ClusterRole + Binding (read pods/ns)
│   ├── 31-fluent-bit-config.yaml     # ConfigMap with the Fluent Bit pipeline
│   └── 32-fluent-bit-daemonset.yaml  # DaemonSet — one Pod per node
├── README.md
├── KIBANA_GUIDE.md                   # step-by-step Kibana setup + per-service filtering
└── HOW_IT_CONNECTS.md                # who talks to whom, what address, where in the YAML
```

Two services emit logs:

- **`sample-app`** — simple HTTP endpoints (`/`, `/warn`, `/error`).
- **`orders-service`** — order/payment endpoints, logs with `orderId`, `customerId`, `action`, etc.

The point of having two is to practice **distinguishing services in Kibana**. See [KIBANA_GUIDE.md](./KIBANA_GUIDE.md) for the full walkthrough.

> ⚠️ This stack is sized for a **laptop / learning cluster**: single-node Elasticsearch, no security, no PVC, no replicas. For real workloads use the [ECK operator](https://www.elastic.co/guide/en/cloud-on-k8s/current/index.html) or [bitnami/elasticsearch](https://artifacthub.io/packages/helm/bitnami/elasticsearch) Helm chart.

---

## Prerequisites

- Docker, `kubectl`, local cluster.
- **At least 4 GB of free memory** for the cluster (Elasticsearch + Kibana are heavy).
  - `minikube start --memory=6144 --cpus=4`
- On Linux you may need to raise `vm.max_map_count`:
  ```bash
  sudo sysctl -w vm.max_map_count=262144
  ```
  Docker Desktop and minikube handle this automatically.

---

## How to run

### 1. Build the sample app images

```bash
eval $(minikube docker-env)   # minikube only

cd backend         && docker build -t elk-demo-backend:1.0 .
cd ../frontend     && docker build -t elk-demo-frontend:1.0 .
cd ../orders-service && docker build -t orders-service:1.0 .
```

For kind:

```bash
kind load docker-image elk-demo-backend:1.0
kind load docker-image elk-demo-frontend:1.0
kind load docker-image orders-service:1.0
```

### 2. Apply the stack (in order)

```bash
kubectl apply -f stack/00-namespace.yaml
kubectl apply -f stack/10-elasticsearch.yaml
kubectl apply -f stack/20-kibana.yaml
kubectl apply -f stack/30-fluent-bit-rbac.yaml
kubectl apply -f stack/31-fluent-bit-config.yaml
kubectl apply -f stack/32-fluent-bit-daemonset.yaml
```

Or apply everything at once:

```bash
kubectl apply -f stack/
```

### 3. Wait for the stack to be ready

```bash
kubectl get pods -n logging -w
```

Wait until Elasticsearch and Kibana are `Running` and `1/1` ready. Elasticsearch takes ~30s, Kibana takes ~60s the first time.

### 4. Deploy the sample apps

```bash
kubectl apply -f backend/sample-app.yaml
kubectl apply -f orders-service/orders-service.yaml
kubectl apply -f frontend/frontend.yaml
kubectl get pods -n demo
```

### 5. Generate some logs

```bash
# CLI — sample-app
NODE_IP=$(minikube ip)
curl http://$NODE_IP:30090/
curl http://$NODE_IP:30090/warn
curl http://$NODE_IP:30090/error

# CLI — orders-service
curl -X POST http://$NODE_IP:30099/orders
curl -X POST http://$NODE_IP:30099/payments/charge
curl      http://$NODE_IP:30099/orders/ord_1003
```

Or open the UI: `http://<node-ip>:30091` and click the buttons.

Each service also emits a periodic background log (heartbeat / pending-orders scan), so idle pods still produce data.

### 6. Open Kibana

```
http://<node-ip>:30092
```

It takes a minute on the first open. **First-time-in-Kibana setup is its own walkthrough — see [KIBANA_GUIDE.md](./KIBANA_GUIDE.md).** Short version:

1. Click **Discover** in the left menu (or **Stack Management → Data Views**).
2. Create a **Data View** with index pattern `k8s-logs-*` and time field `@timestamp`.
3. Go back to **Discover**. You should see your logs.

Filter examples:

- `kubernetes.namespace_name : "demo"` — only your sample app.
- `level : "error"` — only error-level lines.
- `kubernetes.pod_name : "sample-app*"` — one app.

### 7. Quick sanity check from the CLI

You can also query Elasticsearch directly:

```bash
kubectl port-forward -n logging svc/elasticsearch 9200:9200 &
curl 'http://localhost:9200/_cat/indices?v'
curl 'http://localhost:9200/k8s-logs-*/_search?q=level:error&pretty&size=5'
```

You should see records with fields like `level`, `msg`, `hostname`, plus the Fluent Bit additions: `kubernetes.namespace_name`, `kubernetes.pod_name`, `kubernetes.labels.app`.

---

## Anatomy of an indexed log record

A single line from the sample app, after Fluent Bit enrichment, looks roughly like:

```json
{
  "@timestamp": "2026-05-19T07:42:18.123Z",
  "log_processed": {
    "level": "error",
    "msg": "simulated error",
    "path": "/error",
    "code": "E_DEMO"
  },
  "kubernetes": {
    "pod_name": "sample-app-7d4-abcde",
    "namespace_name": "demo",
    "container_name": "app",
    "labels": { "app": "sample-app" },
    "host": "minikube"
  },
  "stream": "stdout"
}
```

That's the payoff: the app emits structured JSON; the collector adds Kubernetes context; Kibana lets you slice by namespace, pod, label, log level, time, free text.

---

## Useful commands

```bash
# Stack
kubectl get pods -n logging
kubectl logs -n logging -l app=fluent-bit --tail=50
kubectl logs -n logging deploy/kibana
kubectl logs -n logging statefulset/elasticsearch

# Elasticsearch
kubectl port-forward -n logging svc/elasticsearch 9200:9200
curl http://localhost:9200/_cluster/health?pretty
curl http://localhost:9200/_cat/indices?v
curl 'http://localhost:9200/k8s-logs-*/_search?pretty&size=3'

# Kibana
kubectl port-forward -n logging svc/kibana 5601:5601

# Sample app
kubectl logs -n demo deploy/sample-app -f
```

---

## Scaling notes (for the real world)

| Concern | What you do in production |
|---------|---------------------------|
| **Elasticsearch HA** | At least 3 nodes (`master`, `data`, `ingest` roles), discovery via headless Service, PVCs for storage. Use the ECK operator. |
| **Storage** | Hot/warm/cold tiers; ILM policies to roll old indices to cheaper storage and delete after N days. |
| **Auth** | Enable X-Pack security: TLS, role-based access, OIDC for Kibana. |
| **Index sizing** | One index per day per app, or use data streams. Watch shard count — under 50 GB / shard. |
| **Pipeline** | If you need transformations, add Logstash or Vector between Fluent Bit and Elasticsearch. |
| **Backpressure** | Set `Mem_Buf_Limit` and `storage.type filesystem` in Fluent Bit so it spools to disk when ES is slow. |
| **Multi-cluster** | Either ship to a central Elasticsearch (Fluent Bit → ES across network), or run one ES per cluster + cross-cluster search. |
| **Cost** | Drop noisy / debug logs at the Fluent Bit level. Don't index what you'd never search. |

---

## Cleanup

```bash
kubectl delete -f backend/sample-app.yaml
kubectl delete -f frontend/frontend.yaml
kubectl delete -f stack/         # tears down the whole stack
kubectl delete namespace logging demo
```

---

## Key takeaways

1. **EFK = Elasticsearch + Fluent Bit + Kibana.** The "L" of classic ELK is replaced by Fluent Bit on Kubernetes.
2. The log shipper is a **DaemonSet** — one per node — because logs live on the node.
3. The shipper needs **RBAC** to read Pod metadata from the API server (that's how it knows which Pod a log line came from).
4. **Write structured (JSON) logs** from your apps. Fluent Bit's `Merge_Log` turns JSON fields into searchable Elasticsearch fields. Plain text logs still work but are far less useful.
5. For real workloads, use the **ECK operator** or a managed offering. Single-node ES is for learning only.
6. Pair this (logs) with the **monitoring** project (metrics) for full observability.

**Back to** [course index](../README.md)
