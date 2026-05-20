# Interview Questions — Autoscaling & Resources

---

## Basic

### Q1. What's HPA (HorizontalPodAutoscaler)?
A controller that scales the **number of Pods** in a Deployment / StatefulSet / ReplicaSet based on metrics (CPU, memory, custom). It reads from metrics-server (resource metrics) or Prometheus Adapter (custom metrics) and adjusts replicas between `minReplicas` and `maxReplicas`.

### Q2. What's VPA (VerticalPodAutoscaler)?
Adjusts a Pod's **CPU/memory requests and limits** based on observed usage. Useful when you don't know how much your app needs. Modes:
- `Off` — only recommends.
- `Initial` — sets resources at Pod creation.
- `Auto` — updates resources, may restart Pods.

Don't mix VPA's `Auto` mode with HPA on the same metric (they fight).

### Q3. What's Cluster Autoscaler?
Adds or removes **nodes** based on Pod scheduling. If Pods are `Pending` due to insufficient resources, it asks the cloud to add a node. If a node sits underutilized for a while, it drains and removes it. Distinct from HPA/VPA which work on Pods.

### Q4. What are `requests` and `limits`?
- **Requests** — guaranteed minimum. The scheduler uses requests to decide which node has room.
- **Limits** — ceiling. CPU > limit → throttled. Memory > limit → OOMKilled.

The HPA's percentage target is computed against **requests**.

### Q5. What are QoS classes?
Based on requests/limits:
- **Guaranteed** — requests == limits for all containers. Last to be evicted under memory pressure.
- **Burstable** — requests < limits (or set asymmetrically).
- **BestEffort** — nothing set. First to be evicted.

The kubelet evicts in reverse order: BestEffort → Burstable → Guaranteed.

### Q6. How does CPU throttling work?
The Linux kernel enforces CPU limits via CFS (Completely Fair Scheduler) bandwidth. If the container hits its limit, it gets throttled — work pauses until the next period. You'll see `container_cpu_cfs_throttled_seconds_total` in metrics. Throttling is the silent latency killer in K8s.

### Q7. How does memory limit work?
Hard ceiling. If a container exceeds it, the kernel OOM-kills the process. The container is then restarted per `restartPolicy`. There's no "throttling" for memory — it's binary.

---

## Intermediate

### Q8. What does HPA actually compute?
Given the current usage and the target:
```
desired = ceil(currentReplicas * (currentMetric / targetMetric))
```
E.g., 3 Pods at 250m average CPU, target 50m → ceil(3 * (250/50)) = 15. Capped at `maxReplicas`. Reverse for scale-down.

### Q9. HPA `behavior` field — what's it for?
Fine-grained control over scale-up/down speed. Common pattern:
```yaml
behavior:
  scaleUp:
    stabilizationWindowSeconds: 0     # react immediately
    policies: [{ type: Pods, value: 2, periodSeconds: 30 }]
  scaleDown:
    stabilizationWindowSeconds: 300   # wait 5min of low load
    policies: [{ type: Pods, value: 1, periodSeconds: 60 }]
```
The big lesson: **scale up fast, scale down slow** — prevents flapping under bursty load.

### Q10. What metrics can HPA use?
- **Resource** — CPU, memory (from metrics-server).
- **Pods** — average value of a custom metric per Pod (e.g., queue depth per replica).
- **Object** — single value of a custom metric on a K8s object (e.g., RPS on an Ingress).
- **External** — outside K8s (e.g., AWS SQS queue length via KEDA / external-metrics adapter).

### Q11. Why doesn't HPA work? `cpu: <unknown>/50%`
metrics-server isn't installed, isn't running, or can't reach the kubelet. Check:
- `kubectl top nodes` — fails → metrics-server is the issue.
- `kubectl get apiservice v1beta1.metrics.k8s.io` — should be `Available: True`.
- For TLS: metrics-server often needs `--kubelet-insecure-tls` for self-signed kubelet certs.

### Q12. PriorityClass and preemption?
A higher-PriorityClass Pod can **evict** a lower-priority Pod if no other node has room. K8s has reserved classes: `system-cluster-critical`, `system-node-critical`. You can create your own (`value: 1000` etc.). Common pattern: critical infrastructure DaemonSets get high priority; batch jobs get low priority.

### Q13. What's a `ResourceQuota`?
Namespace-level cap. Limits total requests/limits/objects per namespace:
```yaml
spec:
  hard:
    requests.cpu: "10"
    requests.memory: 20Gi
    pods: "50"
```
Prevents one team from monopolizing the cluster.

### Q14. What's a `LimitRange`?
Namespace-level **defaults and bounds** on Pods/containers. E.g., "min memory request 64Mi, max 2Gi, default request if unset 128Mi." Pair with ResourceQuota: LimitRange ensures users don't submit unbounded BestEffort Pods; ResourceQuota caps the total.

### Q15. How does eviction work under memory pressure?
The kubelet watches `MemoryPressure` on the node. When triggered, it evicts Pods in this order:
1. BestEffort pods (no requests/limits).
2. Burstable pods exceeding their requests, sorted by usage delta.
3. Guaranteed pods (rare; usually only if a system pod is starving).

Evicted Pods are killed with reason `Evicted`; their controller (Deployment, etc.) recreates them — possibly on the same node, defeating the purpose unless something changed.

### Q16. What's `KEDA`?
**K**ubernetes **E**vent-**d**riven **A**utoscaling. An add-on that scales on external metrics (Kafka lag, SQS depth, Redis list size, HTTP requests) without writing your own custom metrics adapter. Acts as a layer in front of HPA. Can also scale to **zero**, which vanilla HPA cannot.

---

## Scenario-based

### S1. HPA scaled to `maxReplicas` and the app is still slow.
Two possibilities:
- **Bottleneck isn't CPU/replica count**. Database, downstream API, or shared cache is the actual choke point. Scaling replicas just multiplies pressure on the downstream.
- **`maxReplicas` is too low**. Raise it, but only after confirming the scaling actually helped.

Look at saturation metrics, not just CPU%: connection pool depth, latency p99, downstream queue lag.

### S2. Your app's CPU is at 80% but HPA hasn't scaled.
- Did you set CPU requests? HPA percentage is calculated against requests. If `requests.cpu` is unset, the percentage is nonsensical.
- `kubectl describe hpa` — shows the current metric and target. `<unknown>` → metrics-server problem.
- `behavior.scaleUp.stabilizationWindowSeconds` too high — HPA's holding for a window.
- `maxReplicas` already reached.

### S3. Pods keep getting OOMKilled even though usage looks fine in dashboards.
Common causes:
- **Memory spike between scrapes**: Prometheus samples every 30s, but a brief spike to >limit OOMs the container.
- **Kernel page cache counted**: K8s/cgroups counts working set, sometimes including cache. Use `kubectl top pod` (RSS) and increase the limit with headroom (1.5x p99 usage is a good start).
- **JVM apps**: heap + native + stack + metaspace + threads add up. `-Xmx` alone isn't the limit. Use container-aware JVM flags (`-XX:MaxRAMPercentage=70`).

### S4. HPA is flapping (scales up, down, up, down).
- Tighten `behavior.scaleDown.stabilizationWindowSeconds` (e.g., 300s).
- The target metric is too sensitive — averaging window in metrics-server is brief.
- The app's traffic is genuinely bursty — combine HPA with a small `minReplicas` floor that's slightly above your baseline.

### S5. Your Pod template has no `requests` or `limits`. What happens?
The Pod is `BestEffort`. The scheduler treats it as needing 0 resources — it can land anywhere. The kubelet may OOM-kill it first under pressure. HPA can't measure utilization. In any production cluster, a LimitRange should reject Pods without resources, or default them.

### S6. VPA recommends 4Gi but the node has 2Gi free. What happens?
VPA's `updateMode: Auto` would try to recreate the Pod with 4Gi requests — it'd be `Pending` because no node fits. With `Off` or `Initial`, VPA only recommends; you'd see the suggestion in the VPA object and act manually (add bigger node, or rightsize the app).

### S7. Cluster Autoscaler isn't adding nodes despite `Pending` Pods.
- The node group's max size is reached.
- Pods have `nodeSelector` / affinity that no available node group satisfies.
- Cluster Autoscaler can only scale node groups it knows about — multi-AZ misconfig can block it.
- Pod requests larger than any node type in the pool.
- The pending pods are unschedulable due to a taint, not lack of capacity (Cluster Autoscaler doesn't add nodes for taint mismatches by default).

`kubectl logs -n kube-system cluster-autoscaler-...` is the truth.

### S8. You want to scale a worker Deployment based on Kafka lag, not CPU.
Use **KEDA** with the Kafka scaler. KEDA reads lag from Kafka, emits a metric to HPA, and HPA scales the Deployment. KEDA can also scale to 0 when lag is 0 — vanilla HPA can't.

```yaml
kind: ScaledObject
spec:
  scaleTargetRef: { name: worker }
  minReplicaCount: 0
  maxReplicaCount: 20
  triggers:
    - type: kafka
      metadata:
        topic: orders
        consumerGroup: workers
        lagThreshold: "100"
```
