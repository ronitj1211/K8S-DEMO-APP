# Autoscaling & Resources — Deep Dive for Interviews

The narrative on requests/limits, QoS classes, HPA, VPA, and Cluster Autoscaler. What's actually happening under the covers, and how to talk about it.

---

## The origin story

Kubernetes had to answer two related questions from day one:

**"How does the scheduler decide where to place a Pod?"** — needs to know how much CPU/memory each Pod requires. Enter **resource requests**.

**"How does the kernel keep one greedy Pod from taking down its neighbors?"** — needs a ceiling on consumption. Enter **resource limits**.

Requests and limits are two different levers. Requests are used by the scheduler at Pod-placement time; limits are enforced by the kernel (via cgroups) at runtime. Their ratio produces the **QoS class**, which determines which Pod the kubelet evicts first when a node runs out of memory.

Autoscaling came later, layered on top. **HPA** watches Pod-level metrics (CPU utilization, memory, custom) and adjusts replica count. **VPA** watches actual usage and adjusts requests/limits. **Cluster Autoscaler** watches for unschedulable Pods and adds nodes. Three different tools, three different scaling axes.

## The mental model

Requests = **reservation**. Limits = **ceiling**. QoS class = **eviction priority**.

Scaling:
- **HPA** — horizontal, more Pods.
- **VPA** — vertical, bigger Pods.
- **Cluster Autoscaler** — more nodes.

All three can coexist. HPA is by far the most common in practice.

## How requests, limits, and QoS actually work

### Requests

The scheduler filters nodes by "does this node have `container.resources.requests.cpu` and `.memory` available (after subtracting requests of already-scheduled Pods)?" That's it. Requests don't cap anything at runtime — they're a scheduling hint.

**CPU** is compressible: multiple Pods share CPU via CFS bandwidth control. Under contention, you're guaranteed at least your request (weighted-fair scheduling).

**Memory** is not compressible: the kernel can't just "give back" memory. Under contention, kubelet evicts Pods.

### Limits

Limits are enforced by the Linux kernel via cgroups.

**CPU limit** → CFS bandwidth. If your container tries to use 1.0 CPU but has `limits.cpu: 500m`, the kernel throttles the process — it literally gets paused until the next 100ms period. **This is the invisible latency killer of Kubernetes**. Your app looks fine in metrics (some CPU used, no crashes), but request latency inexplicably spikes. Fix: raise the limit, or remove it if the app is well-behaved.

**Memory limit** → OOMKiller. If your container's working set exceeds the limit, the kernel OOM-kills the specific process. Container restarts per its restartPolicy. Symptom: `Last State: Terminated, Reason: OOMKilled`.

### QoS classes

Derived automatically:
- **Guaranteed** — every container has requests == limits for both CPU and memory. Highest priority, evicted last.
- **Burstable** — requests set but < limits, or partial. Middle tier.
- **BestEffort** — no requests or limits. Evicted first.

When a node's memory pressure hits, kubelet iterates: BestEffort first (in order of usage descending), then Burstable Pods that exceed their requests, then Guaranteed as a last resort (rare unless a system Pod is starving).

## How HPA actually works

The formula for CPU-based HPA:
```
desired = ceil(currentReplicas × currentUtilization / targetUtilization)
```

If 3 Pods are at 90% CPU and target is 50%, desired = ceil(3 × 90/50) = 6.

Bounded by `minReplicas` and `maxReplicas`. If desired > maxReplicas, capped there — you're "saturated at max."

Data comes from **metrics-server** (installed as a pod-level metrics aggregator) for resource metrics like CPU/memory. For custom metrics (RPS on Ingress, queue depth on Kafka, etc.), you need a metrics adapter — usually **Prometheus Adapter** or **KEDA**.

`behavior` field (v2 API) gives fine control:
- `scaleUp.stabilizationWindowSeconds` — smoothing to avoid flapping.
- `scaleUp.policies` — max Pods added per period.
- `scaleDown.stabilizationWindowSeconds` — usually higher (5min default) to avoid flapping down.
- `scaleDown.policies` — max Pods removed per period.

**Scale up fast, scale down slow** is the design principle. Users should never feel a scale-down.

## VPA and Cluster Autoscaler quickly

**VPA** observes actual Pod resource usage over time and recommends (or applies) new request/limit values. Modes: `Off` (recommend only), `Initial` (apply at creation), `Auto` (apply and restart Pod to pick up new values). **Don't run VPA in Auto mode on the same metric HPA is scaling** — they fight.

**Cluster Autoscaler** watches for Pending Pods that failed to schedule due to insufficient resources. If a Pod would fit on a bigger cluster, CA calls the cloud API to add a node. Also removes underutilized nodes (drains their Pods first).

Modern alternative: **Karpenter** (AWS-native, ExtGPL-2.0). Faster than CA, picks the right instance types dynamically.

## Common misunderstandings

**"HPA percentage is against limits."** No — HPA computes utilization against **requests**. If `requests.cpu: 100m` and current usage is 150m, that's 150% utilization. Set requests carefully — they're the baseline HPA scales against.

**"No requests / limits means unlimited resources."** Sort of, until the node runs out. Then your Pod is first to die (BestEffort class). "Unlimited" is really "first to be sacrificed."

**"CPU limits are safe."** They're the #1 cause of inexplicable latency in K8s. Throttling doesn't show up as CPU pressure — it shows up as random 200ms spikes in your p99. Consider omitting CPU limits (leave only requests) for latency-sensitive apps. Memory limits are still important.

**"Setting requests == limits is safest."** It makes you Guaranteed QoS, yes. But you reserve resources you may not use. Cost implications for large clusters. Trade-off.

**"HPA scales down when I stop the load."** After the `scaleDown.stabilizationWindowSeconds` window (default 300s = 5min). Load drops at T=0, HPA doesn't shrink until T=300s+. This is intentional (avoids flapping on brief traffic dips) but confuses new operators who expect immediate scale-down.

**"VPA and HPA together = smart scaling."** They fight on the same metric. HPA scaling on CPU + VPA adjusting CPU requests = one thinks "target 50%", the other keeps changing what "50% of" is. Use them on different metrics, or VPA in `Off` (recommend-only) mode.

**"Cluster Autoscaler adds nodes instantly."** It takes 1-5 minutes to provision a new node (cloud API + boot + kubelet register). If your traffic spikes faster than that, you need higher `minReplicas` to have headroom, or use over-provisioning Pods (low-priority "placeholder" Pods that get preempted when real work needs the room).

## The war stories

**"Our p99 latency doubled after we set CPU limits."** CFS throttling. Metrics-server showed CPU at 40% average — nothing to see. The `container_cpu_cfs_throttled_seconds_total` metric was skyrocketing. Removing the CPU limit dropped p99 by 100ms. General lesson: measure throttling, not just utilization.

**"Java app kept getting OOMKilled at exactly the limit."** JVM's understanding of "memory" and cgroup's understanding weren't aligned. Old JVM versions didn't respect container limits — `-Xmx4g` would happily use 4g heap plus native memory, exceeding the limit. Fix: `-XX:MaxRAMPercentage=70` in JDK 11+, and set `limits.memory` to at least 1.4× the heap size to account for native / metaspace / stack overhead.

**"HPA said `cpu: <unknown>/50%` forever."** metrics-server wasn't installed, or wasn't reachable from the API server (`kubelet-insecure-tls` misconfiguration). Verify with `kubectl top nodes` — if that fails, HPA has no data.

**"HPA scaled to maxReplicas and app was still slow."** The bottleneck wasn't CPU/replicas. Database connection pool was saturated. Downstream API rate-limiting. Cache miss storm. Scaling replicas just multiplied pressure on the downstream. Lesson: measure saturation everywhere, not just at the app tier.

**"Cluster Autoscaler didn't add nodes."** Pod had `nodeSelector: gpu=true` but no GPU node group was configured — CA won't invent one. Or the node group's max was already reached. Or the pending Pod was pending for a taint mismatch, not resources — CA doesn't add nodes for taint reasons by default.

**"VPA restarted our stateful Pod at 3am."** VPA in `Auto` mode picked up new recommendations and restarted the Pod to apply. StatefulSet reconciled and it came back, but there was a brief outage. Fix: don't use VPA `Auto` on stateful workloads; use `Initial` (apply at creation only) or `Off` (recommend).

## What to actually say in an interview

If asked about requests/limits:

> Requests are what the scheduler uses to decide where to place a Pod — reservations. Limits are hard ceilings enforced by the kernel at runtime. CPU limits become CFS throttling, which is a common latency issue people don't notice; memory limits become OOM-kills. The ratio of requests to limits determines QoS class: Guaranteed if equal, Burstable if different, BestEffort if neither is set. Kubelet uses QoS to decide eviction order under memory pressure — BestEffort dies first.

If asked about HPA:

> HPA scales replicas based on metrics — typically CPU utilization against the request value. The formula is currentReplicas × currentUtilization / targetUtilization, capped by min and max replicas. It needs metrics-server for CPU/memory, or a custom metrics adapter like Prometheus Adapter or KEDA for anything else (queue depth, RPS, whatever). The `behavior` block lets you tune scale-up and scale-down separately — the design principle is fast scale-up, slow scale-down. That prevents flapping on transient load dips.

If asked about the three autoscalers:

> HPA is horizontal — more Pods. VPA is vertical — bigger Pods, by adjusting requests. Cluster Autoscaler adds nodes when Pods can't schedule. HPA and Cluster Autoscaler compose naturally: HPA adds Pods, and if the cluster can't fit them, CA adds nodes. HPA and VPA on the same metric fight — don't do that. Use HPA on CPU + VPA for memory rightsizing, or use VPA in recommend-only mode.

If asked about a specific troubleshooting scenario like OOMKilled:

> First check the exit reason and last termination state: `kubectl describe pod` shows OOMKilled clearly. Then look at actual memory usage over time — usually via Prometheus. If the app hits limit briefly and dies, either the app has a memory leak, or the limit is too low for the working set, or (for JVM apps) the container-aware flags aren't set and the JVM is claiming more than the limit. Fix depends on which. Long-term: monitor `container_memory_working_set_bytes` and alert on approaches to the limit.

Say the words: **requests = scheduling reservation**, **limits = kernel-enforced ceiling**, **CFS throttling**, **QoS eviction order**, **HPA formula against requests**, **fast scale-up slow scale-down**, **metrics-server / custom metrics adapter**.
