# HPA & cgroups — how Kubernetes decides *how many* and *how big*

Two questions, two completely different mechanisms:

- **How big may one pod be?** → `requests`/`limits` → enforced by the **Linux kernel** through **cgroups**.
- **How many pods should there be?** → **HPA** → a control loop in the **controller-manager**.

They're linked by one number: **the HPA's percentages are computed against `requests`.** Get requests wrong and both scheduling and autoscaling are wrong.

> **Related folder:** [autoscaling-resources/](../autoscaling-resources/) introduces HPA, requests/limits and QoS. **This** folder is the hands-on deep dive — reading the actual cgroup files inside a running container, measuring CFS throttling, custom-metric HPA via Prometheus, KEDA, VPA, preemption and quotas.

---

## Diagram 1 — the two mechanisms, and where each one lives

```
                        YOUR YAML
                 resources:
                   requests: {cpu: 200m, memory: 64Mi}
                   limits:   {cpu: 500m, memory: 128Mi}
                        │              │
        ┌───────────────┘              └───────────────┐
        │ requests                              limits │
        ▼                                              ▼
┌───────────────────────┐                  ┌───────────────────────────┐
│    kube-scheduler     │                  │      kubelet → CRI        │
│                       │                  │      → containerd         │
│ "which node has 200m  │                  │      → runc               │
│  CPU + 64Mi free?"    │                  │      → CGROUP FILES       │
│                       │                  │                           │
│ Bin-packing decision. │                  │  cpu.max     = 50000 100000
│ Happens ONCE, at      │                  │  memory.max  = 134217728  │
│ scheduling time.      │                  │                           │
└───────────────────────┘                  │  Enforced by the KERNEL,  │
        │                                  │  continuously, forever.   │
        │                                  └───────────────────────────┘
        │                                              │
        │                                    ┌─────────┴─────────┐
        │                                    ▼                   ▼
        │                            CPU over limit      Memory over limit
        │                            = THROTTLED         = OOMKILLED
        │                            (slowed down)       (SIGKILL, exit 137)
        ▼
┌───────────────────────┐
│  HorizontalPodAutoscaler │  utilisation % = usage / REQUEST
│  "how many replicas?"    │  ...never / limit, never / node capacity
└───────────────────────┘
```

**The single most misunderstood point:** a pod requesting `200m` and using `200m` is at **100% utilisation** to the HPA — even if the node is 95% idle and the pod's limit is `500m`.

---

## Diagram 2 — how a limit becomes a kernel rule

```
 1. You write        resources.limits.cpu: 500m
                          │
 2. API server           │  stored in etcd as part of the Pod spec
                          ▼
 3. kubelet on the node reads the Pod spec
                          │
 4. kubelet computes the cgroup values:
                          │     500m  = 0.5 CPU
                          │     period = 100000µs (100ms, the CFS default)
                          │     quota  = 0.5 × 100000 = 50000µs
                          ▼
 5. CRI (containerd) → runc → writes the cgroup filesystem:

    /sys/fs/cgroup/kubepods.slice/…/<container>/
        cpu.max      "50000 100000"      ← 50ms of CPU per 100ms period
        cpu.weight   20                  ← derived from the REQUEST (shares)
        memory.max   134217728           ← 128Mi in bytes
        memory.low   67108864            ← derived from the request
                          │
 6. The Linux CFS scheduler and memory controller enforce these
    on every scheduling period, with no Kubernetes involvement at all.
```

**You can see every one of these values from inside the container** — that's what `/cgroup` in this project's app does, and what [CGROUPS.md](CGROUPS.md) walks through.

---

## Diagram 3 — CPU throttling, on a timeline

A container with `limits.cpu: 500m` gets **50ms of CPU in every 100ms period**. What happens next depends on how it uses it:

```
 SINGLE-THREADED app needing 30ms of work per period — never throttled
 period 1 |■■■■■■■□□□□□□□□□□□□□| 30ms used, 20ms unused
 period 2 |■■■■■■■□□□□□□□□□□□□□|
                                        ✓ runs at full speed

 SINGLE-THREADED app needing 80ms of work per period — throttled
 period 1 |■■■■■■■■■■■✗--------| quota gone at 50ms, STALLED for 50ms
 period 2 |■■■■■■■■■■■✗--------|
                                        ✗ ~2x slower, 100% throttled

 4-THREADED app, each thread needing 20ms (80ms total) — THE TRAP
 period 1 |■■■■■■■■■■■✗--------| 4 threads × 20ms = 80ms of quota
          |  4 threads burn the 50ms quota in 12.5ms of WALL time,
          |  then ALL of them stall for the remaining 87.5ms
                                        ✗ latency spike, node looks IDLE
```

**That third case is why CPU limits cause mysterious p99 latency spikes.** The more threads a runtime spawns, the faster it burns its quota. A Go binary defaulting `GOMAXPROCS` to the *node's* 64 cores, in a container limited to 500m, throttles constantly while every dashboard shows low CPU.

**Measure it, don't guess:**

```promql
rate(container_cpu_cfs_throttled_periods_total[5m])
  / rate(container_cpu_cfs_periods_total[5m])
```

Anything above ~5% sustained means the limit is hurting you. Fixes: raise the limit, remove the CPU limit entirely (keep the request), or make the runtime container-aware (`GOMAXPROCS`, `-XX:ActiveProcessorCount`, `UV_THREADPOOL_SIZE`).

---

## Diagram 4 — QoS classes and who dies first

QoS is **derived**, never set by you:

```
              Does every container have
              requests == limits for BOTH
                  cpu AND memory?
                        │
             ┌── yes ───┴─── no ───┐
             ▼                     ▼
        GUARANTEED         Any requests or limits
                                set at all?
                                   │
                        ┌── yes ───┴─── no ───┐
                        ▼                     ▼
                    BURSTABLE            BEST EFFORT
```

When a node runs out of memory, the kubelet evicts in this order:

```
   1. BestEffort            ────────────────▶ killed first
   2. Burstable OVER its request
   3. Burstable UNDER its request
   4. Guaranteed            ────────────────▶ killed last (only if the
                                               node is truly desperate)
```

Under the hood this is `oom_score_adj`: BestEffort gets **1000** (maximum kill preference), Guaranteed gets **-997**, and Burstable is scaled in between based on how much it requested relative to node capacity.

> Two different things can kill your pod, driven by different components:
> - **Kubelet eviction** — node under memory/disk pressure, chooses by **QoS**. Pod status `Evicted`.
> - **Kernel OOMKill** — *this container* exceeded *its own* `memory.max`. Exit code **137**, `Reason: OOMKilled`. The node may have plenty of free memory.

---

## Diagram 5 — the HPA control loop

```
   ┌──────────────────────────────────────────────────────────────┐
   │  every 15s (--horizontal-pod-autoscaler-sync-period)          │
   └───────────────────────────┬──────────────────────────────────┘
                               ▼
            ┌──────────────────────────────────┐
            │  1. Read current replica count   │
            │     from the scale subresource   │
            └──────────────┬───────────────────┘
                           ▼
            ┌──────────────────────────────────────────────────┐
            │  2. Fetch metrics                                │
            │     Resource  → metrics.k8s.io  (metrics-server) │
            │     Pods/Object → custom.metrics.k8s.io (adapter)│
            │     External  → external.metrics.k8s.io (KEDA)   │
            └──────────────┬───────────────────────────────────┘
                           ▼
            ┌──────────────────────────────────────────────────┐
            │  3. desired = ceil( current × (metric / target) ) │
            │     …per metric, then take the MAXIMUM            │
            └──────────────┬───────────────────────────────────┘
                           ▼
            ┌──────────────────────────────────────────────────┐
            │  4. Within 10% tolerance? → DO NOTHING            │
            │     (stops constant ±1 replica flapping)          │
            └──────────────┬───────────────────────────────────┘
                           ▼
            ┌──────────────────────────────────────────────────┐
            │  5. Apply `behavior` policies                     │
            │     scaleUp:   stabilization 0s, +100%/15s        │
            │     scaleDown: stabilization 300s, -25%/60s       │
            └──────────────┬───────────────────────────────────┘
                           ▼
            ┌──────────────────────────────────────────────────┐
            │  6. Clamp to [minReplicas, maxReplicas]           │
            └──────────────┬───────────────────────────────────┘
                           ▼
            ┌──────────────────────────────────────────────────┐
            │  7. PATCH the Deployment's replica count          │
            └──────────────┬───────────────────────────────────┘
                           ▼
              ReplicaSet controller creates pods
                           ▼
              Scheduler places them ─────── no room? ──▶ PENDING
                           ▼                                │
              kubelet starts them                           ▼
                           ▼                        Cluster Autoscaler /
              Readiness probe passes                Karpenter adds a NODE
                           ▼                                │
              Added to Service endpoints ◀──────────────────┘
```

**Two autoscalers, two axes.** HPA adds *pods*; Cluster Autoscaler/Karpenter adds *nodes*. Configure only one and a scale-up event just produces `Pending` pods with nowhere to go.

---

## Diagram 6 — which autoscaler for which problem

```
                    What needs to change?
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
   NUMBER of pods      SIZE of pods        NUMBER of nodes
        │                   │                   │
        ▼                   ▼                   ▼
   ┌─────────┐         ┌─────────┐      ┌────────────────┐
   │   HPA   │         │   VPA   │      │ Cluster        │
   │         │         │         │      │ Autoscaler  or │
   │ CPU/mem │         │ right-  │      │ Karpenter      │
   │ custom  │         │ sizing  │      │                │
   │ metrics │         │ requests│      │ triggered by   │
   └────┬────┘         └─────────┘      │ PENDING pods   │
        │                               └────────────────┘
        │ can't scale to 0
        │ can't read external events
        ▼
   ┌─────────┐
   │  KEDA   │  queue depth, Kafka lag, cron, 50+ scalers
   │         │  scale to ZERO
   └─────────┘   (creates an HPA under the hood)
```

| | HPA | VPA | Cluster Autoscaler / Karpenter | KEDA |
|---|---|---|---|---|
| Changes | replica count | requests/limits | node count | replica count (incl. 0) |
| Triggered by | metrics | observed usage history | Pending pods | external events |
| Scale to zero | ✗ | — | ✓ (nodes) | ✓ |
| Disruptive | no | **yes** in Auto mode | yes (drains) | no |
| Conflicts with | VPA on the same metric | HPA on the same metric | — | — |

---

## Diagram 7 — what actually happens when memory runs out

```
   Container allocates memory
             │
             ▼
   Does it exceed the CONTAINER's memory.max?
             │
      ┌── yes ┴── no ──┐
      ▼                ▼
 Kernel tries      Is the NODE running low
 to reclaim        on allocatable memory?
 page cache             │
      │           ┌─ yes ┴─ no ─┐
      ▼           ▼             ▼
 Still over?  kubelet        all fine
      │       EVICTION
      ▼            │
  OOMKILL          ▼
      │      Pick victim by QoS:
      │      BestEffort → Burstable-over-request → Guaranteed
      ▼            │
 SIGKILL (9)       ▼
 exit code 137   Pod status: Evicted
 Reason:         (rescheduled elsewhere;
 OOMKilled        the NODE is the problem,
      │           not the pod)
      ▼
 kubelet restarts it per restartPolicy
      │
      ▼
 Repeats → CrashLoopBackOff
 (10s, 20s, 40s… capped at 5min)
```

**Diagnosing which one hit you:**

```bash
kubectl describe pod <pod> | grep -A5 "Last State"
#   Reason: OOMKilled, Exit Code: 137   -> container exceeded ITS limit
kubectl get events -n <ns> | grep -i evict
#   Evicted ... node had memory pressure -> the NODE ran out
```

---

## What's in this folder

| Path | Purpose |
|---|---|
| [app/server.js](app/server.js) | Workload with `/cgroup` (reads its own cgroup files), `/burn-cpu`, `/alloc-mem`, `/queue` |
| [manifests/10-workload.yaml](manifests/10-workload.yaml) | The Deployment with deliberately tight limits |
| [manifests/20-qos-classes.yaml](manifests/20-qos-classes.yaml) | Three pods → the three QoS classes |
| [manifests/21-limitrange-quota.yaml](manifests/21-limitrange-quota.yaml) | LimitRange + ResourceQuota governance |
| [manifests/30-hpa-cpu.yaml](manifests/30-hpa-cpu.yaml) | Basic CPU HPA with tuned `behavior` |
| [manifests/31-hpa-multi-metric.yaml](manifests/31-hpa-multi-metric.yaml) | Multi-metric HPA (max wins) |
| [manifests/32-hpa-custom-metric.yaml](manifests/32-hpa-custom-metric.yaml) | Custom metric via Prometheus Adapter |
| [manifests/40-priorityclass-preemption.yaml](manifests/40-priorityclass-preemption.yaml) | PriorityClasses + over-provisioning pods |
| [manifests/50-vpa-keda-pdb.yaml](manifests/50-vpa-keda-pdb.yaml) | VPA, KEDA ScaledObject, PodDisruptionBudget |

| Doc | Contents |
|---|---|
| [CGROUPS.md](CGROUPS.md) | Hands-on: read the cgroup files, prove enforcement, measure throttling, v1 vs v2 |
| [RUN-STEPS.md](RUN-STEPS.md) | Walkthrough — trigger throttling, cause an OOMKill, drive the HPA, watch preemption |
| [INTERVIEW.md](INTERVIEW.md) | 40 Q&A with scenarios |

---

## Prerequisites

- A cluster (Colima+k3s, minikube, kind) and `kubectl`
- **metrics-server** — required for *any* HPA:
  ```bash
  kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
  # local clusters need this patch (self-signed kubelet certs):
  kubectl patch -n kube-system deploy metrics-server --type=json \
    -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'
  kubectl top nodes          # must work before any HPA will
  ```
- Optional: Prometheus Adapter (custom metrics), KEDA, VPA — see the comments in each manifest.

---

## The five rules worth memorising

1. **Always set requests.** They drive scheduling, HPA maths, QoS, and eviction order. A pod without requests is invisible to the scheduler and first to die.
2. **Always set memory limits.** Memory is incompressible — no limit means one leak takes down the whole node.
3. **Think hard before setting CPU limits.** CPU is compressible; the limit only throttles you. Many teams set the request and omit the limit, letting pods use idle capacity. Set one when you need predictable, isolated performance or are enforcing tenant fairness.
4. **Set memory request == memory limit** for anything important. That's `Guaranteed` QoS and last-to-be-evicted.
5. **Scale up fast, scale down slow.** Asymmetric `behavior` policies absorb spikes without thrashing.
