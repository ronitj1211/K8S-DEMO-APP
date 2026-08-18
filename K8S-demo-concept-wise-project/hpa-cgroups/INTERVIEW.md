# Interview Q&A — HPA, cgroups, resources & autoscaling

40 questions with the scenarios that show you've actually operated this.

---

## Requests, limits & cgroups

**Q1. Difference between requests and limits?**
**Requests** are what the **scheduler** reserves when placing the pod — bin-packing is entirely based on requests. **Limits** are the ceiling the **kernel** enforces at runtime via cgroups. Different consumers, different times: requests matter once at scheduling, limits matter continuously.

*Scenario:* A pod requesting 200m and limited to 500m is placed on a node with 200m free. It may burst to 500m when the node is idle, but the scheduler only ever reserved 200m for it.

**Q2. What happens if you exceed a CPU limit? A memory limit?**
CPU is **compressible** — you get **throttled** (slowed), never killed. Memory is **incompressible** — there's no way to "slow down" memory, so the kernel **OOMKills** the container with SIGKILL, exit code 137.

**Q3. How is a CPU limit actually enforced?**
Through the Linux CFS bandwidth controller. `limits.cpu: 500m` becomes `cpu.max = "50000 100000"` — 50,000µs of CPU per 100,000µs (100ms) period. When the quota is exhausted, every thread in the cgroup is stopped until the next period starts.

*Scenario:* You can read this yourself: `cat /sys/fs/cgroup/cpu.max` inside the container returns `50000 100000`, and `cpu.stat` shows `nr_throttled` counting how many periods were cut short.

**Q4. What's the difference between CPU shares and CPU quota?**
**Shares** (`cpu.weight`, from the *request*) are relative and only apply **when the CPU is contended** — two pods with weights 100 and 200 split a busy CPU 1:2, but on an idle node both run flat out. **Quota** (`cpu.max`, from the *limit*) is an **absolute ceiling** enforced regardless of contention.

*Scenario:* A 500m-limited pod on a completely idle 64-core node still only gets 500m. That surprises people who expect "limits only matter under pressure."

**Q5. Should you set CPU limits?**
Often **no**. CPU is compressible, so requests alone give fair sharing plus burst headroom, and CPU limits are a common cause of latency spikes at low apparent utilisation. Set them when you need predictable performance regardless of neighbours, are enforcing multi-tenant fairness, or are billing by capacity. **Always** set memory limits, though — an unbounded leak takes down the node.

**Q6. Why does my app get throttled when `kubectl top` shows 50% CPU?**
Because averages hide bursts. Throttling is decided per **100ms period**; `kubectl top` averages over much longer. A multi-threaded app can burn its entire 50ms quota in 12ms of wall time, then sit stalled for 88ms. Average looks calm, p99 is terrible.

*Scenario:* A Go service with `GOMAXPROCS` defaulting to the node's 64 cores, limited to 500m. 64 threads exhaust the quota almost instantly every period. Fixing `GOMAXPROCS=1` (or `automaxprocs`) removed the latency spikes with no change to the limit.

**Q7. What is `oom_score_adj` and how does Kubernetes use it?**
A per-process bias (-1000 to 1000) the kernel's OOM killer adds when scoring kill candidates. Kubernetes sets it from QoS: BestEffort gets **1000** (kill me first), Guaranteed gets **-997** (kill me last), Burstable is scaled in between based on its request relative to node capacity. That's the mechanism by which QoS becomes real.

**Q8. cgroup v1 vs v2?**
v1 has a separate hierarchy per controller (`/sys/fs/cgroup/cpu/`, `/memory/`); v2 has a single **unified** hierarchy. Files renamed (`cpu.cfs_quota_us`+`cfs_period_us` → `cpu.max`; `memory.limit_in_bytes` → `memory.max`). v2 adds **PSI** pressure metrics and, most usefully, **`memory.high`** — a throttle-before-kill threshold that lets an app shed load instead of being SIGKILLed outright.

**Q9. My container is OOMKilled at 128Mi but the app only uses 100Mi. Why?**
`memory.current` counts more than your heap: page cache for files you read/write, kernel memory (socket buffers, dentries), and **tmpfs — including `emptyDir: {medium: Memory}`**. For the JVM it also counts metaspace, thread stacks, and native allocations outside the heap.

*Scenario:* A service writing logs quickly accumulated page cache charged to its cgroup, and got OOMKilled hours after starting with a flat heap graph. Rule of thumb: limit ≈ 1.5× observed p99 working set; for JVM use `-XX:MaxRAMPercentage=70` rather than `-Xmx` equal to the limit.

**Q10. What's exit code 137? 143?**
**137** = 128 + 9 = SIGKILL — almost always OOMKilled (no graceful shutdown at all). **143** = 128 + 15 = SIGTERM — a normal shutdown, often a failed liveness probe or a rolling update.

**Q11. Why does my container see the node's CPU count instead of its limit?**
Because CPU count comes from `/proc/cpuinfo`, which is **not namespaced**. cgroups limit what you may *use*, not what you can *see*. Any runtime sizing thread pools from "CPU count" over-provisions massively.

| Runtime | Fix |
|---|---|
| Go | `automaxprocs`, or set `GOMAXPROCS` |
| Java | JDK 11+ is container-aware; `-XX:MaxRAMPercentage` |
| Python | `len(os.sched_getaffinity(0))` |
| Node.js | set `UV_THREADPOOL_SIZE` explicitly |
| Nginx | pin `worker_processes`, don't use `auto` |

---

## QoS & eviction

**Q12. What are the QoS classes and how are they assigned?**
**Guaranteed** — every container has requests == limits for *both* CPU and memory. **Burstable** — at least one request or limit set, but not matching. **BestEffort** — nothing set. You never set QoS; Kubernetes derives it.

**Q13. Eviction order under node memory pressure?**
BestEffort → Burstable exceeding its request → Burstable under its request → Guaranteed last. Within a tier, the kubelet prefers pods using the most above their request.

**Q14. Eviction vs OOMKill — what's the difference?**
**OOMKill**: *this container* exceeded *its own* `memory.max`. Kernel action, SIGKILL, exit 137, pod restarts in place. The node may have plenty of free memory.
**Eviction**: the *node* is under memory/disk pressure. Kubelet action, chooses a victim by QoS, pod status becomes `Evicted` and it's rescheduled elsewhere.

*Scenario:* "Pods keep dying" — `kubectl describe pod` showing `OOMKilled/137` means fix the limit; `kubectl get events` showing `Evicted ... node had memory pressure` means the node is oversubscribed and requests are too low across the board.

**Q15. Preemption vs eviction?**
**Preemption** is the **scheduler** at *scheduling* time removing a lower-**priority** pod to make room. **Eviction** is the **kubelet** at *runtime* removing a pod because of node **pressure**, chosen by **QoS**. Different component, different trigger, different selection criterion.

**Q16. Why is BestEffort dangerous?**
The scheduler thinks the pod needs nothing, so it packs it anywhere and the node becomes oversubscribed; it has no cgroup limits so it can consume the whole node; and it's first to be evicted. It's the worst of every world. A **LimitRange** with `defaultRequest` eliminates it namespace-wide.

**Q17. What are LimitRange and ResourceQuota?**
**LimitRange** works per **container** at admission: inject `default`/`defaultRequest`, enforce `min`/`max`, and cap `maxLimitRequestRatio`. **ResourceQuota** works per **namespace**: total requests/limits and object counts.

*Scenario:* `maxLimitRequestRatio: 4` stops a team requesting 100m while setting a 4-core limit — which would let them reserve almost nothing yet burst enormously, wrecking scheduling accuracy and destabilising nodes.

**Q18. What happens if a namespace has a ResourceQuota and a pod omits resources?**
It's **rejected** — with a quota on `requests.cpu`/`limits.cpu`, every pod must specify them. Pair the quota with a LimitRange so defaults are injected automatically instead of developers hitting errors.

---

## HPA

**Q19. What is the HPA formula?**
```
desiredReplicas = ceil( currentReplicas × (currentMetricValue / desiredMetricValue) )
```
*Scenario:* 3 pods averaging 180m with a target of 100m per pod → `ceil(3 × 1.8)` = **6 replicas**.

**Q20. Utilisation is a percentage of what?**
Of the pod's **`requests`** — never the limit, never the node's capacity. A pod requesting 200m and using 200m is at 100% even on an idle node.

**Q21. What happens if a pod has no CPU request and you create a CPU HPA?**
The HPA can't compute a percentage and reports `<unknown>`; it will never scale. **Requests are mandatory for resource-based HPAs.**

**Q22. What is the tolerance?**
A default 10% dead zone — the HPA does nothing if the ratio is within 10% of target. Without it you'd get constant ±1 replica flapping.

**Q23. How does the HPA get metrics?**
Three aggregated APIs:
- `metrics.k8s.io` — **metrics-server**, for CPU/memory (`type: Resource`)
- `custom.metrics.k8s.io` — **Prometheus Adapter** etc., for in-cluster metrics (`type: Pods`/`Object`)
- `external.metrics.k8s.io` — **KEDA** etc., for things outside the cluster (`type: External`)

**Q24. metrics-server vs Prometheus?**
metrics-server is a lightweight in-memory aggregator that stores **nothing** — it exists only to serve `kubectl top` and the HPA. Prometheus is a full TSDB for history, dashboards and alerting. They are not substitutes: you need metrics-server even with Prometheus running, unless you use the adapter for everything.

**Q25. Multi-metric HPA — how are they combined?**
A desired replica count is computed for **each** metric independently and the **maximum** wins. Any one metric can scale you up; **all** must be low to scale down. Deliberately conservative.

**Q26. Why is memory-based autoscaling usually a bad idea?**
Most runtimes grow their heap and never return it. Memory stays high after load passes, so the HPA scales up but **never scales back down**. Worse, adding replicas doesn't reduce per-pod memory the way it reduces per-pod CPU. Use it only when memory genuinely tracks concurrent work.

**Q27. What does `behavior` do?**
Independently controls scale-up and scale-down rate:
- `stabilizationWindowSeconds` — look back over this window and use the most conservative recommendation. Scale-down defaults to 300s; scale-up to 0.
- `policies` — `Percent` or `Pods` per period.
- `selectPolicy` — `Max`, `Min` or `Disabled` (which freezes that direction entirely).

*Scenario:* "Scale up fast, scale down slow" — 100%/15s up with a 0s window, 25%/60s down with a 300s window. Spikes are absorbed immediately; a brief dip doesn't cause a scale-down that must be undone.

**Q28. Two HPAs targeting one Deployment?**
They fight — both patch the same replica count and the workload oscillates. Kubernetes doesn't prevent it. **One HPA per workload.**

**Q29. HPA + `kubectl scale` together?**
The HPA overwrites your manual change on its next sync (~15s). To pin a replica count you must delete or suspend the HPA. Similarly, keeping `replicas:` in a Git-managed Deployment fights the HPA on every sync — remove the field (or set Argo CD to ignore it).

**Q30. Can the HPA scale to zero?**
Not by default — `minReplicas` must be ≥1. Scale-to-zero requires the `HPAScaleToZero` feature gate with an external/custom metric, or **KEDA**, which handles it natively.

**Q31. HPA scaled up but pods are Pending. What's wrong?**
No node capacity. HPA adds *pods*; it cannot add *nodes*. You need **Cluster Autoscaler** or **Karpenter** watching for Pending pods. Configuring only one of the two axes is the classic incomplete setup.

**Q32. How fast is autoscaling end to end?**
Metric scrape (15–60s) → HPA sync (15s) → pod scheduling (~1s) → image pull + start (5–60s) → readiness probe → endpoint registration. Realistically **1–3 minutes** with existing node capacity, plus **60–90s** if a new node must boot. That's why over-provisioning with low-priority pause pods exists.

---

## VPA, KEDA & cluster autoscaling

**Q33. What is VPA and how does it differ from HPA?**
HPA changes the **number** of pods; VPA changes their **size** (requests/limits) based on observed usage. Modes: `Off` (recommend only — the safe production choice), `Initial` (apply to new pods), `Auto`/`Recreate` (evict and resize running pods).

**Q34. Can VPA and HPA run together?**
Not on the **same metric**. VPA raises the request → the HPA's utilisation percentage instantly drops → the HPA scales *in* → load per pod rises → VPA raises the request again. The safe combination is **VPA on memory, HPA on CPU** (via `controlledResources`), or keep VPA in `Off` mode and apply its recommendations by hand.

**Q35. What is KEDA and when do you need it?**
Event-driven autoscaling. Two things a plain HPA can't do: **scale to zero**, and scale on **external event sources** (SQS depth, Kafka consumer lag, Redis list length, cron, 50+ scalers). KEDA doesn't replace the HPA — it *creates* one and feeds it through the external metrics API.

*Scenario:* A worker consuming SQS. CPU is near zero while messages pile up, so a CPU HPA never reacts. KEDA on queue depth scales 0→20 as messages arrive and back to 0 when drained.

**Q36. Cluster Autoscaler vs Karpenter?**
**Cluster Autoscaler** adjusts the desired size of pre-defined node groups/ASGs — you must define the instance shapes up front. **Karpenter** provisions right-sized EC2 instances directly from pod requirements, in seconds rather than minutes, picks from a broad instance-type set, handles Spot interruption, and **consolidates** by replacing underused nodes with cheaper ones.

**Q37. What is the over-provisioning pattern?**
Deploy low-priority `pause` pods that reserve real capacity and do nothing. When a real pod needs space, they're preempted **instantly**, so scale-up doesn't wait 60–90s for a node to boot. You trade a small constant cost for much faster response.

**Q38. How do PDBs interact with autoscaling?**
Scale-down, node drains and Karpenter consolidation are all **voluntary** disruptions, and the eviction API honours the PDB — so it sets a floor those operations cannot cross. Use `maxUnavailable: 1` rather than `minAvailable`, which stays correct as replicas change; `minAvailable: 2` on a 2-replica Deployment blocks eviction entirely and hangs node drains forever. PDBs do **not** protect against involuntary disruption (hardware failure, Spot reclamation).

---

## Scenario questions

**Q39. "Our service is slow but every dashboard shows CPU at 40%. Walk me through it."**

> First I'd check **CPU throttling**, because that's exactly what this pattern looks like:
> ```promql
> rate(container_cpu_cfs_throttled_periods_total[5m]) / rate(container_cpu_cfs_periods_total[5m])
> ```
> Anything sustained above ~5% is hurting. The reason average CPU looks fine is that throttling is enforced per **100ms period** — a multi-threaded runtime can burn its whole quota in the first 12ms and stall for the remaining 88ms, which averages out to a calm-looking graph and a terrible p99.
>
> I'd confirm inside the container by reading `cpu.stat` for `nr_throttled`, and check whether the runtime is container-aware — a Go binary with `GOMAXPROCS` set to the node's core count, or a JVM sizing its thread pools from `availableProcessors()`, is the usual root cause.
>
> Fixes in order: make the runtime container-aware; raise the CPU limit; or remove the CPU limit and keep only the request, so the pod can use idle capacity. I'd also check whether latency correlates with *neighbouring* pods' activity, which points at the request being too low rather than the limit being too tight.

**Q40. "You're asked to set resources for a new service. How?"**

> I wouldn't guess. Deploy to staging with generous limits, drive realistic load, then measure:
> ```promql
> quantile_over_time(0.95, rate(container_cpu_usage_seconds_total[5m])[24h:])
> max_over_time(container_memory_working_set_bytes[24h])
> ```
> Then:
> - **CPU request** = p95 usage. That's what the scheduler reserves.
> - **CPU limit** — start with none (request only) unless I need isolation; if required, ≥2× the request to allow bursts.
> - **Memory request** = p99 working set + ~20% headroom.
> - **Memory limit** = request, giving Guaranteed QoS for anything important — or ~1.5× p99 if the workload is genuinely bursty.
>
> Then I'd run **VPA in `Off` mode** for a week and compare its recommendation against my numbers, set a **LimitRange** so nothing lands without resources, and revisit after real production traffic. Getting requests right matters more than limits — they drive scheduling, HPA maths, QoS and eviction order all at once.
