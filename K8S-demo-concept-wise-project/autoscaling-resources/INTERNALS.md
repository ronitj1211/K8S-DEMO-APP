# Autoscaling & Resources — Internals

cgroups, CFS throttling, OOM killer semantics, HPA formula, VPA/Cluster Autoscaler mechanics.

---

## Purpose

Three-axis scaling in Kubernetes:
- **HPA** (Horizontal Pod Autoscaler): more Pods.
- **VPA** (Vertical Pod Autoscaler): bigger Pods (adjust requests/limits).
- **Cluster Autoscaler / Karpenter**: more nodes.

Underneath: `requests` are scheduler hints for placement; `limits` are enforced by the Linux kernel via cgroups.

## Requests — the scheduler's view

Requests are **not enforced at runtime**. They're what the scheduler uses to bin-pack Pods onto nodes.

Node has 4 CPUs, 8 GiB. Pods with requests summing to <= 4 CPU, <= 8 GiB can fit. That's the math. When kube-scheduler runs its filter/score algorithm on candidate nodes:

- **Filter**: "does this node have `requests.cpu` and `requests.memory` free (after subtracting existing Pods' requests)?"
- **Score**: "which node ranks best?" (least-allocated, spread across nodes, etc.)

Actual usage doesn't matter for scheduling. A Pod using 5% of its request still "reserves" the full request from the scheduler's view.

## Limits — the kernel's enforcement

Limits are hard ceilings enforced by cgroups (Linux control groups).

### CPU limits — CFS bandwidth control

The Completely Fair Scheduler enforces CPU limits via **periods** and **quotas**:
- Default period: 100ms (`cpu.cfs_period_us=100000`).
- Quota derived from limit: `limits.cpu: 500m` → 50ms of CPU per 100ms period (`cpu.cfs_quota_us=50000`).

Within each 100ms window, the container gets up to 50ms of CPU. If it tries to use more, the kernel **throttles** — pauses the process until the next period starts.

**The invisible latency killer**: your metrics say CPU is at 40%, but the app is randomly slow. Look at `container_cpu_cfs_throttled_seconds_total` — throttling shows up here. Fix: raise the limit, or omit it entirely (leave only requests) for latency-sensitive apps.

### Memory limits — OOM kill

Memory limits are enforced by cgroup memory controller. If a container's memory usage exceeds `limits.memory`, the kernel's OOM killer terminates the process with SIGKILL. Exit code 137 (128 + 9).

The container is then restarted per `restartPolicy`. `kubectl describe pod` shows:
```
Last State: Terminated
  Reason:   OOMKilled
  Exit Code: 137
```

**Memory is not compressible.** Unlike CPU where the kernel can just slow the process down, memory can't be "throttled" — the process needs the RAM or it dies. This is why memory limits are more dangerous than CPU limits.

### QoS classes

Automatically derived:
- **Guaranteed**: every container has `requests == limits` for CPU AND memory. Best treatment under pressure — last to be evicted.
- **Burstable**: requests set but limits differ, or partial requests/limits. Middle tier.
- **BestEffort**: no requests or limits. First to die under pressure.

The kubelet evicts in this order when the node hits `MemoryPressure`:
1. BestEffort Pods (by usage descending).
2. Burstable Pods exceeding their memory requests.
3. Guaranteed Pods (very rare; usually a system Pod issue).

## HPA — the reconcile loop

The HPA controller (in kube-controller-manager) runs every 15 seconds (default).

For a `HorizontalPodAutoscaler` targeting `deployment/backend`:

1. **Fetch current metric values** from:
   - `metrics.k8s.io/v1beta1` API (backed by metrics-server) for resource metrics (CPU, memory).
   - `custom.metrics.k8s.io/v1beta1` (backed by Prometheus Adapter or similar) for custom metrics.
   - `external.metrics.k8s.io/v1beta1` (KEDA, cloud watchers) for external metrics.

2. **Compute desired replicas** for each metric target:
   ```
   desired = ceil(currentReplicas × (currentMetric / targetMetric))
   ```
   Multiple metrics: use the max.

3. **Apply constraints**:
   - Clamp to `minReplicas..maxReplicas`.
   - Apply `behavior.scaleUp.stabilizationWindowSeconds` — smoothing to avoid flapping.
   - Apply `behavior.scaleUp.policies` — rate limits ("at most 2 Pods per 30s").

4. **Update the Deployment's `spec.replicas`** to the desired value.

Deployment controller then reconciles as usual (RS scales up, Pods created).

## The HPA formula, worked

3 Pods at 90% CPU utilization, target 50%.

```
desired = ceil(3 × (90 / 50))
        = ceil(3 × 1.8)
        = ceil(5.4)
        = 6
```

HPA increases replicas to 6. Metrics-server continues sampling. Once average CPU drops to ~50%, HPA holds.

**"Utilization" is against requests**, not limits. `requests.cpu: 100m`, current usage `150m` → 150% utilization. Rise in usage without a rise in `requests` doesn't recalibrate the baseline; the HPA sees ever-increasing utilization percentages.

## metrics-server — how HPA gets data

**metrics-server** is a Deployment (usually in kube-system) that:
1. Scrapes each kubelet's `/metrics/resource` endpoint every 15s.
2. Aggregates into the Metrics API.
3. Serves `metrics.k8s.io/v1beta1` for HPA + `kubectl top`.

**Doesn't store history** — just the last sample. For historical metrics, use Prometheus.

**Common failure mode**: kubelet exposes metrics over HTTPS with a self-signed cert; metrics-server refuses to verify. Fix: add `--kubelet-insecure-tls` flag to metrics-server. See [MORE-PRODUCTION-INCIDENTS.md #9](../MORE-PRODUCTION-INCIDENTS.md).

## `behavior` — fine-grained HPA tuning

```yaml
behavior:
  scaleUp:
    stabilizationWindowSeconds: 0     # react immediately
    policies:
      - type: Pods
        value: 4
        periodSeconds: 30           # max +4 Pods per 30s
      - type: Percent
        value: 100
        periodSeconds: 30           # max +100% per 30s
    selectPolicy: Max               # whichever allows more
  scaleDown:
    stabilizationWindowSeconds: 300  # wait 5min of low load
    policies:
      - type: Pods
        value: 2
        periodSeconds: 60           # max -2 Pods per minute
```

**Design principle**: **scale up fast, scale down slow**. Latency spike from too-few-Pods is worse than cost from too-many-Pods.

Without `behavior`:
- Default `scaleUp.stabilizationWindowSeconds: 0`.
- Default `scaleDown.stabilizationWindowSeconds: 300`.
- Default policies (paraphrased): max +100% or +4 Pods per 15s; max -100% or -1 Pod per 15s.

## Custom & external metrics

Beyond CPU/memory:

**Custom metrics** — a per-Pod metric served through the K8s API. Common: Prometheus Adapter exposes `demo_request_rate` as a K8s metric.

```yaml
metrics:
  - type: Pods
    pods:
      metric: { name: demo_requests_per_second }
      target: { type: AverageValue, averageValue: "100" }
```

Scale to keep each Pod at ~100 req/sec.

**External metrics** — a metric NOT tied to a Pod. Queue depth, external API latency, cloud service metrics.

```yaml
metrics:
  - type: External
    external:
      metric:
        name: sqs_queue_depth
        selector: { matchLabels: { queue: work-queue } }
      target: { type: Value, value: "50" }
```

Often provided by **KEDA**, which supports 60+ external sources (Kafka lag, SQS depth, Redis list size, HTTP request rate, cloud metrics).

## VPA — vertical scaling

VerticalPodAutoscaler observes Pods' actual resource usage over time and adjusts `requests` (and optionally `limits`).

**Three modes:**
- `Off` — only recommends. No changes applied.
- `Initial` — apply recommendations when Pods are created. No mutation of running Pods.
- `Auto` — apply and *restart* Pods to pick up new resources. Because K8s can't change a running container's resource requests in place (K8s 1.27+ has an alpha feature for this).

VPA has three components:
- **Recommender**: reads usage, computes recommended values.
- **Updater**: identifies Pods with outdated resources; evicts them.
- **Admission Controller**: mutates newly-created Pods to use the recommended values.

**Don't run VPA `Auto` mode + HPA on the same metric.** They fight — HPA sees utilization change as VPA adjusts the request baseline. Common composition: HPA on CPU + VPA `Off` mode for memory recommendations (act on them via CI, not automatically).

## Cluster Autoscaler

Watches for **Pending Pods** that failed to schedule due to insufficient resources.

For each pending Pod:
1. Simulate scheduling on each node group's candidate node types.
2. If a bigger/different node would allow the Pod to schedule → call the cloud API to add a node.
3. Wait for the new node to register with the API server (~2-5 min on cloud).
4. Scheduler places the pending Pod on the new node.

**Scale-down**: nodes underutilized for `--scale-down-unneeded-time` (default 10min) → CA drains them and calls cloud API to remove.

**Constraints:**
- Pods with `nodeSelector: gpu=true` — CA needs a node group with matching labels.
- PodDisruptionBudgets prevent CA from draining nodes if it would violate the PDB.
- Node group max sizes cap growth.

## Karpenter — the newer approach

AWS-native alternative to Cluster Autoscaler (also expanding to other clouds). Differences:

- **No node groups** — Karpenter provisions individual nodes matching pending Pods' requirements exactly.
- **Faster**: nodes launched via EC2 fleet API, typically 30-60s vs CA's 2-5min.
- **Smarter instance-type selection**: picks the cheapest instance that fits the Pod requirements.
- **Spot-aware**: can prefer spot instances with configurable fallback.

Same "scale in response to unschedulable Pods" mental model, but faster and more flexible.

## PriorityClass + preemption

Under resource pressure, high-priority Pods can evict lower-priority Pods.

```yaml
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: high-priority
value: 1000000
globalDefault: false
description: "For critical apps"
```

Assign to a Pod: `spec.priorityClassName: high-priority`.

When a high-priority Pod is Pending because no node has room, the scheduler looks for nodes where evicting lower-priority Pods would make room. Preempts those Pods (sends TERM signals, drains) to place the high-priority one.

**Reserved classes:**
- `system-cluster-critical` — control-plane components.
- `system-node-critical` — kube-proxy, CNI DaemonSets.

Both have priorities in the billions — normal workloads should never approach them.

---

## The 30-second summary

- Requests = scheduler hint (bin-packing); limits = kernel-enforced ceiling.
- CPU limits become CFS throttling (silent latency); memory limits become OOM kills.
- QoS: Guaranteed (last to die) > Burstable > BestEffort (first to die).
- HPA formula: `desired = ceil(replicas × currentMetric/targetMetric)`. Metrics from metrics-server (CPU/mem), custom metrics API, or external metrics.
- HPA behavior: **scale up fast, scale down slow** — the design principle.
- VPA in `Auto` mode restarts Pods to apply new resource values. Don't combine with HPA on the same metric.
- Cluster Autoscaler / Karpenter add nodes when Pods are unschedulable due to resource shortage.
- PriorityClass + preemption: high-priority Pods can evict lower ones to make room.
