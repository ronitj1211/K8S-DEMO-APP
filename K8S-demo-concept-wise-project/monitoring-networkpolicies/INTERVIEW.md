# Interview Questions — Monitoring & NetworkPolicies

Two distinct concepts in one folder. Sections are split.

---

# Part 1 — Monitoring (Prometheus + Grafana)

## Basic

### Q1. Why Prometheus and not a logging tool for metrics?
Prometheus is a **time-series database** optimized for numeric metrics with labels. It's a pull model (scrapes targets), in-cluster, and integrates naturally with K8s service discovery. Logs go to a separate stack (ELK, Loki). Mixing them is a category error — metrics for trends and alerting, logs for forensics.

### Q2. Pull vs push?
Prometheus **pulls** from `/metrics` endpoints. Pros: targets don't need to know where Prometheus is; failed scrapes are visible as `up{} == 0`; centralized rate-limiting. Cons: hard for short-lived jobs (use `pushgateway`).

### Q3. How does Prometheus discover targets in K8s?
Via `kubernetes_sd_configs`:
- `role: node` — scrape kubelets directly.
- `role: pod` — discover Pods (often filtered by `prometheus.io/scrape` annotation).
- `role: service` — discover Services.
- `role: endpoints` — discover endpoints of Services.

Relabel rules filter and tag the discovered targets.

### Q4. Why use `prometheus.io/scrape: "true"` annotations?
A convention. The Prometheus config has a relabel rule: "only keep targets whose Pod has this annotation set to `true`." Lets app teams opt their Pods in without editing the Prometheus config.

### Q5. What are the four metric types?
- **Counter** — only goes up (or resets to 0): `http_requests_total`.
- **Gauge** — up or down: `memory_in_use_bytes`.
- **Histogram** — buckets + sum + count: latency.
- **Summary** — similar but quantiles computed client-side.

For latencies, prefer Histogram (server-side aggregation across replicas works).

### Q6. What's PromQL?
Prometheus's query language. Key operators:
- `rate(http_requests_total[5m])` — per-second rate over 5 minutes.
- `sum by (status) (rate(http_requests_total[5m]))` — group by label.
- `histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[5m]))` — p99 latency.

### Q7. What's Grafana's role?
Visualization. Grafana queries one or more datasources (Prometheus, Loki, CloudWatch) and renders dashboards. It also has alerting (Grafana Alerting), though Prometheus has its own (Alertmanager).

## Intermediate

### Q8. How does kube-prometheus-stack differ from a minimal install?
**kube-prometheus-stack** (Helm chart) is the batteries-included variant — Prometheus + Alertmanager + Grafana + node-exporter (DaemonSet) + kube-state-metrics + a pile of pre-built dashboards and alerts. Production starts here. Minimal install (like this folder's manifests) is for understanding the moving parts.

### Q9. What's node-exporter vs kube-state-metrics?
- **node-exporter** — DaemonSet exposing **node-level OS metrics** (CPU, memory, disk, network from `/proc`, `/sys`).
- **kube-state-metrics** — Deployment exposing **K8s object metrics** (count of Pods in each phase, Deployment replicas, etc.).

You need both for full observability.

### Q10. Prometheus uses a lot of disk. How to control?
- **Retention**: `--storage.tsdb.retention.time=15d`. Shorter retention = less disk.
- **Reduce cardinality**: every unique label combination = one time series. High-cardinality labels (user_id, request_id) are the biggest disk eaters. Drop them in relabel.
- **Federation / remote_write**: ship aggregated metrics to long-term storage (Thanos, Cortex, Mimir, VictoriaMetrics) and keep local short.

### Q11. What's Alertmanager?
Receives alerts from Prometheus (when alerting rules fire) and **groups, deduplicates, routes, and silences** them — then forwards to receivers (Slack, PagerDuty, email). Separating routing logic from rule evaluation is the design.

## Scenario-based

### S1. A target is `down` in Prometheus. Why?
- Pod is unhealthy → readiness fails → Pod IP excluded from Endpoints → Prometheus loses the target. Or it's a scrape error — wrong port, /metrics not exposed, app crashed.
- Look at the targets page: `http://<prom>/targets`. The "Last Error" column tells you.

### S2. Prometheus is OOMKilled.
Heavy memory uses:
- Too many series (cardinality explosion). Find with `count by (__name__)({__name__=~".+"})`.
- `--storage.tsdb.min-block-duration` and head block too large.
- Large `query.max-samples` in one query.

Fix: drop labels at scrape time (`metric_relabel_configs: action: labeldrop`), reduce retention, raise memory, or move to Thanos with remote storage.

### S3. You add a new label to a metric and dashboards break.
Adding a label creates **new time series** — old queries that match `metric_name{}` still work, but ones that pin labels may fail. Recording rules and alert thresholds may break too. Always backfill or design dashboards to be label-tolerant.

---

# Part 2 — NetworkPolicies

## Basic

### Q1. What's a NetworkPolicy?
A namespaced resource that defines which Pods can receive (Ingress) or send (Egress) traffic. By default, **all traffic is allowed in K8s**; NetworkPolicies are how you lock that down.

### Q2. Does K8s actually enforce them?
Only if the CNI plugin supports it. **Calico, Cilium, Weave Net, Antrea** enforce them. **Flannel alone** does not. **k3s ships kube-router** alongside flannel specifically for NetworkPolicy enforcement.

### Q3. What's the default in K8s without any policy?
**Allow all.** No deny by default. Even cross-namespace pod-to-pod is open.

### Q4. How do you write a "default-deny" policy?
```yaml
kind: NetworkPolicy
spec:
  podSelector: {}              # match ALL Pods in the namespace
  policyTypes: [Ingress]
  # no `ingress` rules == deny all ingress
```
Once applied, no Pod in the namespace receives traffic except what other policies explicitly allow.

### Q5. Ingress vs Egress in NetworkPolicy?
- **Ingress** — traffic flowing **into** the selected Pods.
- **Egress** — traffic flowing **out**.

Both can be controlled independently. Common pattern: tight Ingress, looser Egress.

### Q6. What can you select in `from` / `to`?
- `podSelector` — match Pods by label, in the same namespace.
- `namespaceSelector` — match all Pods in selected namespaces.
- `podSelector` + `namespaceSelector` (in the same list item) — AND of both.
- `ipBlock` — CIDR (with optional exceptions).

## Intermediate

### Q7. What does `policyTypes` do?
Tells K8s which **directions** the policy governs. If `policyTypes: [Ingress]` and no ingress rules, ingress is denied. Egress is unaffected. If you want to block both, list both: `policyTypes: [Ingress, Egress]` and (optionally) leave rules empty for the direction you want to deny.

### Q8. Two policies, one allows traffic from `app=frontend`, another from `app=monitoring`. What happens?
NetworkPolicies are **additive (OR)**. Traffic is allowed if **any** policy permits it. You cannot write a "deny override" — to deny something specific, you have to NOT match it in any allow rule. (Cilium and some advanced CNIs add denial rules via CRDs.)

### Q9. How do you allow DNS in an Egress-deny world?
DNS is the first thing to allow — apps can't resolve hostnames without it:
```yaml
egress:
  - to:
      - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: kube-system } }
        podSelector: { matchLabels: { k8s-app: kube-dns } }
    ports:
      - { protocol: UDP, port: 53 }
      - { protocol: TCP, port: 53 }
```

### Q10. Pod-to-Service IP vs Pod-to-Pod IP — what does NetworkPolicy match?
NetworkPolicies match on **Pod IPs** (the destination/source after kube-proxy DNAT). When a Pod reaches a Service ClusterIP, the kernel rewrites the destination to a Pod IP before the policy is evaluated. So your `podSelector` in NetworkPolicy is what matters, regardless of how the client reached the destination.

### Q11. `ipBlock` use cases?
For traffic outside the cluster (e.g., an external database CIDR):
```yaml
egress:
  - to:
      - ipBlock:
          cidr: 10.100.0.0/16
          except: [10.100.5.0/24]   # block this sub-range
    ports: [{ protocol: TCP, port: 5432 }]
```

### Q12. Can NetworkPolicy do L7 (HTTP path) filtering?
**No.** Standard NetworkPolicy is L3/L4 (IP + port). For L7 you need:
- **Cilium** with NetworkPolicy CRD (or upstream Gateway API NetPol extensions).
- A **service mesh** (Istio AuthorizationPolicy, Linkerd ServerAuthorization).

## Scenario-based

### S1. Default-deny applied, now Prometheus can't scrape your backend. Fix?
Add an allow rule that selects Prometheus by namespace + label:
```yaml
ingress:
  - from:
      - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: monitoring } }
        podSelector: { matchLabels: { app: prometheus } }
    ports: [{ protocol: TCP, port: 3000 }]
```

### S2. Your CI Pod needs egress to `github.com` and nothing else.
NetworkPolicy can't resolve hostnames — it works on IPs. Options:
- **CIDR via `ipBlock`** — fragile, GitHub's CIDR changes.
- **Cilium FQDN policies** — match on DNS name (Cilium-only).
- **Egress proxy** — run a proxy with hostname allowlist; force the Pod through it via `http_proxy` env.

### S3. NetworkPolicy applied but traffic still flows. What's wrong?
- **CNI doesn't support it** (e.g., plain flannel). Check with the CNI's docs.
- **Policy in wrong namespace** — `podSelector` is namespace-scoped.
- **Pod has hostNetwork: true** — NetworkPolicies don't apply.
- Test with a probe Pod: `kubectl run probe --rm -i --image=curlimages/curl --command -- curl ...`.

### S4. You want to test policies safely before enforcing.
- **Cilium / Calico** have "audit" or "log" modes that don't drop traffic but log policy decisions.
- Apply policies in a staging namespace first.
- Run a synthetic probe (DaemonSet that connects to everything it shouldn't) and alert if it succeeds.

### S5. A NetworkPolicy denies traffic from `kube-system`. Now the API server can't reach webhooks.
NetworkPolicies select traffic *to* Pods in the policy's namespace. Webhook calls **from** the API server are sourced from the control plane IP, which may not be a Pod (depends on the cluster). On managed clusters, this often slips through; on kubeadm clusters, you may have to add an `ipBlock` rule with the control-plane CIDR. Always test webhook calls after applying default-deny.
