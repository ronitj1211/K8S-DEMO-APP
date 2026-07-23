# Monitoring & NetworkPolicies — Deep Dive for Interviews

The narrative on the two concepts in this folder. Prometheus + Grafana for observability; NetworkPolicies for cluster-level network segmentation.

---

# Part 1 — Monitoring (Prometheus + Grafana)

## The origin story

In pre-K8s microservices, monitoring was ad-hoc — every team wired up Datadog or New Relic differently, dashboards were snowflakes, alerts fired inconsistently. Prometheus emerged from SoundCloud (2012, later CNCF) with a novel design:

- **Time-series database** with a query language (PromQL) built for metrics.
- **Pull model** — Prometheus scrapes targets on a schedule.
- **Kubernetes-native service discovery** — auto-discover Pods/Services via the K8s API, no manual target list.
- **Multi-dimensional data model** — every metric has labels (`http_requests_total{route="/users", status="500"}`) that make slicing trivial.

Combined with Grafana for visualization, kube-state-metrics for K8s object metrics, node-exporter for host metrics, and Alertmanager for routing alerts, the "PGKA stack" (or the packaged `kube-prometheus-stack` Helm chart) became the K8s-native observability default.

## The mental model

Prometheus is a **pull-based time-series DB**. Every target exposes a `/metrics` HTTP endpoint. Prometheus scrapes on a schedule (e.g., every 15s) and stores the values. You query with PromQL: aggregations, rates, joins on labels.

The stack:
- **Prometheus** — scrape + store + PromQL.
- **Grafana** — dashboards on top of Prometheus queries.
- **node-exporter** — DaemonSet exposing host-level metrics (CPU, memory, disk, network).
- **kube-state-metrics** — Deployment exposing K8s object metrics (Pod status, Deployment replicas, PVC bound state).
- **Alertmanager** — receives alerts from Prometheus, groups/dedupes, routes to Slack/PagerDuty/email.

Pull vs push: Prometheus pulls. This means:
- Targets don't need to know where Prometheus is.
- A failed scrape shows up as `up{} == 0` — you know when monitoring itself is broken.
- Short-lived jobs (that die before the next scrape) need `pushgateway` — otherwise their metrics vanish.

## How it actually works

**Service discovery** in K8s via `kubernetes_sd_configs`:
- `role: pod` — discover all Pods, filter by annotations.
- `role: service` — discover all Services.
- `role: endpoints` — discover Endpoints of Services.
- `role: node` — scrape kubelets on nodes.

Relabel rules filter and tag targets. Common pattern: only scrape Pods with `prometheus.io/scrape: "true"` annotation. That's opt-in — apps declare "I have /metrics; come get me."

**Metric types**:
- **Counter** — monotonically increasing (only goes up, or resets to zero on restart). `http_requests_total`.
- **Gauge** — up and down. `memory_in_use_bytes`, `queue_depth`.
- **Histogram** — buckets + count + sum. `http_request_duration_seconds`. Use for latency — server-side aggregation across replicas is math-safe.
- **Summary** — client-side quantile computation. Rarely correct in multi-replica setups; prefer Histogram.

**PromQL essentials**:
- `rate(http_requests_total[5m])` — per-second rate over 5m window.
- `sum by (status) (rate(http_requests_total[5m]))` — group by label.
- `histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[5m]))` — p99 latency.
- `up == 0` — targets that are down.

**Storage**: Prometheus writes to a local TSDB (time-series database). Retention typically 15d for a small setup. For long-term storage, use `remote_write` to Thanos, Cortex, Mimir, or VictoriaMetrics.

## When to use monitoring

Every production cluster. Full stop. Without metrics you're flying blind — you don't know when things are broken, can't set SLOs, can't debug performance regressions.

**What to instrument**:
- **RED metrics** — Rate (requests/sec), Errors (rate of failed), Duration (latency histogram). Per service.
- **USE metrics** — Utilization, Saturation, Errors. Per resource (CPU, memory, disk).
- **Business metrics** — signups/hour, orders/min. Ties technical health to what actually matters.

## Common misunderstandings

**"Prometheus scales horizontally."** It doesn't — single-instance by design. For HA, run two identical Prometheuses; for scale, federate or shard. Or use Thanos/Cortex/Mimir which are designed for scale.

**"Histograms give you accurate quantiles."** They give you approximate quantiles based on your bucket boundaries. Use bucket boundaries that fit your latency distribution: 10ms, 50ms, 100ms, 500ms, 1s, 5s for a web API.

**"High-cardinality labels are fine."** They're the #1 way to blow up Prometheus memory. Every unique label combination is a separate time series. Adding `user_id` as a label = one series per user. At 10k users, that's 10k series per metric. Rule: labels should have low cardinality (dozens, not thousands).

**"Alerts should be based on Prometheus metrics directly."** They should be based on **derived symptoms** (SLO burn rate, error budget consumption), not raw metrics. "5xx > 100" is noisy; "5xx budget for the month is being consumed faster than sustainable" is meaningful.

**"Prometheus and Grafana are the same thing."** They're separate. Prometheus stores and queries; Grafana visualizes (via Prometheus as a datasource). Grafana can also use Loki (logs), Tempo (traces), CloudWatch, etc.

## Monitoring war stories

**"Prometheus OOMed after we added a `request_id` label."** Cardinality explosion. Every unique request_id was a new time series. Fix: drop that label with a `metric_relabel_configs: action: labeldrop`. Never label with high-cardinality values.

**"We had metrics but no useful alerts."** Alerts on raw thresholds ("CPU > 80%") caused pager fatigue. Migrated to SLO-based alerting (Google's "alert on symptoms, not causes") and pages dropped 80%.

**"Grafana query took 30 seconds."** Wide time range on high-cardinality metric. Fix: reduce range, use pre-aggregated recording rules, or move to a tiered setup (Thanos with downsampling).

---

# Part 2 — NetworkPolicies

## The origin story

Kubernetes' network model is intentionally flat: **any Pod can talk to any other Pod**. That's great for developer velocity (no manual firewall rules) but terrible for security (compromised Pod can reach anything).

NetworkPolicies were added to give segmentation. They're a **namespaced firewall rule** describing which Pods can send to or receive from which other Pods. But — and this is critical — **NetworkPolicies are only enforced if your CNI plugin supports them**. Plain flannel doesn't. Calico, Cilium, Weave Net, Antrea, and (in k3s) kube-router do.

## The mental model

NetworkPolicies work by **explicit allow**. Once you apply the first NetworkPolicy selecting a set of Pods, those Pods deny **everything** they don't have an allow rule for.

Selectors work in three dimensions:
- **Namespace** — allow traffic from Pods in namespace X.
- **Pod labels** — allow from Pods with label `role=frontend`.
- **IP block (CIDR)** — allow from a specific IP range (for external / non-Pod sources).

`policyTypes` = Ingress and/or Egress. Same rules structure for both — a `from`/`to` clause and a `ports` clause.

## How it actually works

Behind the scenes:
- CNI plugin (Calico, Cilium, kube-router) watches NetworkPolicies via the K8s API.
- On each policy change, plugin programs the node's data plane:
  - Calico: BPF or iptables rules.
  - Cilium: eBPF programs attached to network hooks.
  - kube-router: iptables.
- When a Pod tries to connect out, or receives inbound, the plugin's rules evaluate.

Policies are **additive (OR)**. Traffic is allowed if any policy allows it. There's no "deny override" in vanilla NetworkPolicy (Cilium and Calico add this via their own CRDs).

**Default-deny pattern**: apply a NetworkPolicy that selects all Pods (`podSelector: {}`) and has no ingress rules. Now nothing in the namespace can receive traffic. Then add narrow allow policies for what should work.

## When to use NetworkPolicies

- **Zero-trust posture**: every namespace has a default-deny, and only explicit allows for what should communicate.
- **Multi-tenancy**: isolate tenants' Pods so a compromise in tenant A can't lateral-move to tenant B.
- **Compliance**: PCI, HIPAA require documented network segmentation.

Don't use for:
- **Simple homogeneous clusters** where "all Pods can talk to all Pods" is fine.
- **L7 policies** (HTTP methods, paths, JWT claims) — NetworkPolicy is L3/L4. Use Cilium's L7 policies or a service mesh.

## Common misunderstandings

**"Namespaces isolate network traffic."** They don't. Namespaces scope names, RBAC, quotas — not traffic. You need NetworkPolicies for isolation.

**"Once I apply a NetworkPolicy, everything else is blocked."** Only for Pods matched by that policy. Pods not selected by any NetworkPolicy remain allow-all.

**"NetworkPolicies affect Service traffic."** They affect the Pod IP — kube-proxy DNATs Service IP to Pod IP before the policy is evaluated. So `podSelector` on the *destination Pod* is what matters, not the Service ClusterIP.

**"NetworkPolicies control Pod-to-external traffic."** Yes for egress — you can restrict Pods from reaching arbitrary external IPs. But not by hostname — you have to use CIDR blocks. Cilium's DNS-based policies bridge this gap.

**"NetworkPolicies work on all CNIs."** They don't. Plain flannel silently ignores them. Verify: `kubectl get networkpolicies -A` shows your policy exists. Then run a Pod that shouldn't be able to reach another Pod, and confirm it can't. If it can, your CNI isn't enforcing.

## NetworkPolicy war stories

**"Applied default-deny, cluster DNS stopped resolving."** CoreDNS lives in kube-system; your namespace's default-deny egress blocked traffic to it. Fix: add an explicit allow-egress rule for UDP/TCP 53 to kube-system's kube-dns Pods.

**"Prometheus scraping broke after applying default-deny."** Prometheus lives in `monitoring`; your `demo` namespace default-deny blocks it. Fix: allow ingress from `namespaceSelector: kubernetes.io/metadata.name=monitoring` on the target Pods' metrics port.

**"NetworkPolicies applied but traffic still flows."** CNI doesn't enforce. Check the CNI plugin. On k3s, `kube-router` runs as a DaemonSet in kube-system for policy enforcement — verify it's there.

**"We denied everything and now can't debug."** Emergency escape: `kubectl exec -it <pod> -- <command>` uses the kubelet, not Pod network — so exec still works even when Pod network is denied. Use it to poke at things while policies are being sorted out.

---

## What to actually say in an interview

If asked about monitoring:

> Prometheus + Grafana is the K8s-native stack. Prometheus pulls metrics from targets on a schedule, stores them in a time-series DB, and lets you query with PromQL. Discovery is automatic in K8s via annotations like `prometheus.io/scrape: "true"`. Grafana visualizes; Alertmanager routes alerts. Together with kube-state-metrics for K8s object metrics and node-exporter for host metrics, that's the standard. Watch for cardinality — high-cardinality labels blow up Prometheus memory quickly. And prefer histogram metrics for latency; summaries don't aggregate correctly across replicas.

If asked about SLOs / alerting:

> Alert on symptoms, not causes. "Error budget for this SLO is burning faster than sustainable" is a page-worthy alert. "CPU > 80% for 5 minutes" isn't — it's noisy and doesn't correlate with user impact. Google's SRE book covers the pattern: define SLO (e.g., 99.9% availability), track error budget, alert on burn rate.

If asked about NetworkPolicies:

> NetworkPolicies are the K8s primitive for network segmentation. By default, all Pod-to-Pod traffic is allowed; NetworkPolicies flip that to deny-by-default for selected Pods, then you add narrow allow rules. Critical caveat: they're only enforced if the CNI plugin supports them — Calico, Cilium, Weave, and k3s's kube-router do; plain flannel doesn't. Standard pattern is default-deny per namespace, then explicit allow rules for legitimate flows: frontend can reach backend, monitoring can scrape /metrics, kube-system DNS is reachable.

If asked about L7 vs L3/L4:

> Standard NetworkPolicy is L3/L4 — IP + port only. If you need L7 (HTTP method, path, JWT claims), you need Cilium (with its L7 policies via eBPF) or a service mesh like Istio with AuthorizationPolicy. NetworkPolicy is the baseline for zero-trust segmentation; L7 policies layer on top for API-level enforcement.

Say the words: **pull-based**, **PromQL**, **cardinality**, **histogram vs summary**, **SLO burn rate alerting**, **CNI-dependent enforcement**, **default-deny then explicit allow**, **L3/L4 vs L7**.
