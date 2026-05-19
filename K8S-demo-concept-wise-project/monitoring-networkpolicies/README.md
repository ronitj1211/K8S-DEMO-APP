# Monitoring (Prometheus + Grafana) & NetworkPolicies

Two concepts that aren't related by themselves, but pair naturally because:

- **Monitoring** is one of the things you very often grant **cross-namespace network access** to.
- The day you turn on a default-deny NetworkPolicy, the first thing that breaks is usually Prometheus scraping. Better to learn them together.

The folder builds both: the Prometheus + Grafana stack scraping a sample app, and the NetworkPolicies that lock down who can talk to that sample app — while still letting Prometheus scrape it.

---

# Part 1 — Monitoring

## What problem does it solve?

Logs (the EFK folder) tell you *what happened in this log line*. Metrics tell you:

- *How busy* something is (rate of requests, queue depth).
- *How healthy* it is (error rate, P99 latency).
- *How its resources are doing* (CPU, memory, file descriptors).

Metrics are cheap to store, easy to alert on, and the backbone of SRE practice (the four Golden Signals: latency, traffic, errors, saturation).

## The Prometheus model

Prometheus **pulls** metrics from your services on a `/metrics` HTTP endpoint, on a schedule (~every 15s). The endpoint returns plain-text:

```
demo_requests_total{route="/",status="200"} 42
demo_request_duration_seconds_bucket{route="/",le="0.05"} 38
demo_request_duration_seconds_bucket{route="/",le="0.1"}  41
```

Each metric has **labels** (`route`, `status`, ...) that you slice and dice over with **PromQL**.

### Architecture

```
   ┌──────────────────────────────────────────────────────────┐
   │                 Kubernetes cluster                       │
   │                                                          │
   │   Pod (app)   Pod (app)   Pod (app)                      │
   │     /metrics    /metrics    /metrics                     │
   │        ▲          ▲          ▲                           │
   │        │  scrape  │          │                           │
   │        └──────────┼──────────┘                           │
   │                   │                                      │
   │             ┌──────────────┐                             │
   │             │  Prometheus  │                             │
   │             │  (kube SD)   │  ← finds Pods via K8s API   │
   │             └──────┬───────┘    (reads annotations)      │
   │                    │                                     │
   │                    ▼                                     │
   │             ┌──────────────┐                             │
   │             │   Grafana    │  ← queries Prometheus,      │
   │             │              │     draws dashboards        │
   │             └──────────────┘                             │
   └──────────────────────────────────────────────────────────┘
```

### How Prometheus knows where to scrape

It uses **kubernetes service discovery**: it lists Pods via the K8s API and decides which ones to scrape based on annotations:

```yaml
metadata:
  annotations:
    prometheus.io/scrape: "true"
    prometheus.io/port:   "3000"
    prometheus.io/path:   "/metrics"
```

That's what the sample app in this folder has.

### What metrics you typically expose

- **Counters** — only go up: `http_requests_total`, `tasks_processed_total`.
- **Gauges** — go up and down: `queue_depth`, `active_connections`.
- **Histograms** — bucketed observations: `request_duration_seconds`. Lets you compute P50/P95/P99 in PromQL.
- **Summaries** — like histograms but client-side quantiles.

### PromQL primer

```promql
# Requests per second on the backend, by route, averaged over the last 5m
rate(demo_requests_total[5m])

# 95th percentile request latency over the last 5m
histogram_quantile(0.95, sum by (le, route) (rate(demo_request_duration_seconds_bucket[5m])))

# Error rate (5xx / total)
sum(rate(demo_requests_total{status=~"5.."}[5m])) / sum(rate(demo_requests_total[5m]))
```

### Production note: kube-prometheus-stack

For real work you almost never write Prometheus manifests by hand — you install the [`kube-prometheus-stack`](https://github.com/prometheus-community/helm-charts/tree/main/charts/kube-prometheus-stack) Helm chart. That gives you:

- Prometheus Operator + CRDs (`ServiceMonitor`, `PodMonitor`, `PrometheusRule`).
- Alertmanager for routing alerts.
- Grafana with a bundled set of K8s dashboards.
- node-exporter + kube-state-metrics for cluster-level metrics.

This folder is a from-scratch deployment so you see the moving parts.

---

# Part 2 — NetworkPolicies

## What problem do they solve?

By default in Kubernetes, **any Pod can talk to any other Pod**, in any namespace, on any port. That's a wide-open blast radius — if one Pod is compromised, it can reach everything.

A **NetworkPolicy** is a Pod-level firewall:

- Select Pods by **label**.
- Restrict who can talk **to** them (ingress) or who they can talk **out to** (egress).

### Important: needs a CNI that enforces them

NetworkPolicy is a *spec*, not an implementation. The cluster's CNI plugin actually enforces it. Most do:

| CNI | NetworkPolicy support |
|-----|-----------------------|
| Calico | ✓ (also extends with its own CRD) |
| Cilium | ✓ (and adds L7 policies) |
| Weave | ✓ |
| Flannel (default in some clusters) | ✗ — you'd see no effect |

**minikube**: `minikube start --cni=calico` if you want NetworkPolicies to actually work.

### Common pattern: default-deny, then allow-list

```yaml
# 1. Deny all ingress to every Pod in the namespace.
spec:
  podSelector: {}
  policyTypes: [Ingress]
  # no `ingress:` rules == deny all
```

```yaml
# 2. Allow only the things you actually need.
spec:
  podSelector:
    matchLabels: { app: backend }
  policyTypes: [Ingress]
  ingress:
    - from:
        - podSelector: { matchLabels: { app: frontend } }
      ports:
        - protocol: TCP
          port: 3000
```

Policies are **additive** — multiple policies that allow are OR'd together. You don't write deny rules; you write a default-deny and then list the allows.

### Cross-namespace selectors

```yaml
ingress:
  - from:
      - namespaceSelector:
          matchLabels:
            kubernetes.io/metadata.name: monitoring   # auto-applied to every namespace
        podSelector:
          matchLabels: { app: prometheus }
```

The `kubernetes.io/metadata.name` label is automatically applied by Kubernetes to every namespace — it's the easiest way to target a specific namespace.

---

## What's in this folder

```
monitoring-networkpolicies/
├── backend/
│   ├── server.js                    # exposes /metrics with prom-client
│   ├── package.json, Dockerfile
│   └── 01-app.yaml                  # Deployment + Service, with prometheus.io annotations
├── frontend/
│   ├── index.html, Dockerfile       # button UI that drives traffic
│   └── frontend.yaml
├── stack/                           # the monitoring stack (namespace: monitoring)
│   ├── 00-namespaces.yaml           # monitoring + demo
│   ├── 10-prometheus-rbac.yaml      # SA + ClusterRole + Binding for kube SD
│   ├── 11-prometheus-config.yaml    # scrape config (kubernetes_sd_configs + relabel)
│   ├── 12-prometheus.yaml           # Prometheus Deployment + NodePort
│   └── 20-grafana.yaml              # Grafana Deployment + NodePort + datasource ConfigMap
├── policies/                        # NetworkPolicies (namespace: demo)
│   ├── 01-default-deny-ingress.yaml
│   ├── 02-allow-frontend-to-backend.yaml
│   └── 03-allow-prometheus-scrape.yaml
└── README.md
```

---

## Prerequisites

- Docker, `kubectl`, local cluster.
- **A CNI that enforces NetworkPolicy** (for Part 2). On minikube:
  ```bash
  minikube start --cni=calico
  ```

---

## How to run

### 1. Build images

```bash
eval $(minikube docker-env)   # minikube only

cd backend  && docker build -t monitoring-backend:1.0 .
cd ../frontend && docker build -t monitoring-frontend:1.0 .
```

(kind: `kind load docker-image ...`)

### 2. Deploy the monitoring stack

```bash
kubectl apply -f stack/
kubectl get pods -n monitoring -w
```

Wait until Prometheus + Grafana are `Running`.

### 3. Deploy the sample app

```bash
kubectl apply -f backend/01-app.yaml
kubectl apply -f frontend/frontend.yaml
kubectl get pods -n demo
```

### 4. Generate some traffic

```bash
NODE_IP=$(minikube ip)
for i in $(seq 1 50); do
  curl -s http://$NODE_IP:30100/        >/dev/null
  curl -s http://$NODE_IP:30100/slow    >/dev/null
  curl -s http://$NODE_IP:30100/error   >/dev/null
done
```

Or use the UI at `http://$NODE_IP:30103`.

### 5. Verify the backend is exposing metrics

```bash
curl http://$NODE_IP:30100/metrics | head -30
```

You should see Prometheus-format text with `demo_requests_total{...}` lines.

### 6. Open Prometheus

```
http://<node-ip>:30101
```

- **Status → Targets** — you should see your two backend Pods listed, scraping every 10s with state `UP`. If they're not there, check the Pod annotations on `01-app.yaml` and the Prometheus config.
- **Graph** — try some PromQL:
  - `demo_requests_total`
  - `rate(demo_requests_total[1m])`
  - `histogram_quantile(0.95, sum by (le) (rate(demo_request_duration_seconds_bucket[5m])))`

### 7. Open Grafana

```
http://<node-ip>:30102        (admin / admin)
```

- The **Prometheus** datasource is pre-provisioned (see [`stack/20-grafana.yaml`](./stack/20-grafana.yaml)).
- Click **Explore** in the side nav, pick **Prometheus**, and try a query.
- Or import the K8s reference dashboards from [grafana.com/dashboards](https://grafana.com/grafana/dashboards/) — IDs `315`, `6417`, `1860`.

### 8. Lock it down with NetworkPolicies

```bash
# Apply default-deny FIRST. The frontend can no longer reach the backend.
kubectl apply -f policies/01-default-deny-ingress.yaml

# Verify the break:
curl http://$NODE_IP:30100/      # times out — node port is fine but Pod refuses
# Or test from inside the cluster:
kubectl run dbg --rm -it --image=curlimages/curl -n demo -- \
  curl --max-time 3 http://backend.demo.svc/

# Restore the frontend → backend path:
kubectl apply -f policies/02-allow-frontend-to-backend.yaml

# Restore Prometheus scraping (look at /targets — they go red, then green):
kubectl apply -f policies/03-allow-prometheus-scrape.yaml
```

> **What happens here**: With only `default-deny-ingress`, nothing can reach the backend Pods. NodePort doesn't help — the policy is at the Pod, not the Service. Adding the allow-frontend policy fixes frontend → backend. Adding the allow-prometheus policy fixes Prometheus scraping. Anything not allowed is still denied.

### 9. Inspect policies

```bash
kubectl get networkpolicy -n demo
kubectl describe networkpolicy allow-frontend-to-backend -n demo
```

---

## Useful commands

```bash
# Prometheus
kubectl logs -n monitoring deploy/prometheus -f
kubectl port-forward -n monitoring svc/prometheus 9090:9090

# Grafana
kubectl logs -n monitoring deploy/grafana -f
kubectl port-forward -n monitoring svc/grafana 3000:3000

# Look at scrape config
kubectl get cm -n monitoring prometheus-config -o yaml

# NetworkPolicy
kubectl get networkpolicy -A
kubectl describe networkpolicy <name> -n <ns>
```

---

## Cleanup

```bash
kubectl delete -f policies/
kubectl delete -f frontend/frontend.yaml
kubectl delete -f backend/01-app.yaml
kubectl delete -f stack/
kubectl delete namespace demo monitoring
```

---

## Key takeaways

### Monitoring
1. **Metrics are pulled** from `/metrics` endpoints on a regular schedule by Prometheus.
2. K8s service discovery picks up Pods via **annotations** (this folder) or **ServiceMonitor CRs** (the Prometheus Operator way).
3. Expose **counters**, **gauges**, and **histograms** — histograms are what let you compute latency percentiles in PromQL.
4. For real work, use the `kube-prometheus-stack` Helm chart. Don't roll your own in production.
5. Pair logs (ELK/EFK) + metrics (Prom/Grafana) + traces (Tempo/Jaeger) for full observability.

### NetworkPolicies
1. Kubernetes is **open by default** — without policies, all Pods can talk to all Pods.
2. The pattern is **default-deny** + a small set of allow rules. Rules are additive (OR).
3. Policies need a **CNI that enforces them** (Calico, Cilium, etc.).
4. Don't forget the **monitoring** path — Prometheus has to be allowed to scrape, or your dashboards go dark.
5. Use the `kubernetes.io/metadata.name` label for cross-namespace policies — it's always present.

**Back to** [course index](../README.md)
