# Concepts — from zero, in order

Read this before [README.md](README.md) if the vocabulary is new. Order: **what it is → the terms → how it works → how to configure → which file**.

---

# PART 1 — What it is

## The problem being solved

A Kubernetes node is one machine with a fixed amount of CPU and memory. Many containers from many teams share it. Three things can go wrong:

1. **A greedy container starves its neighbours.** One process with a memory leak consumes all the RAM, and unrelated pods on that node die.
2. **The scheduler packs blindly.** If nobody says how much a pod needs, Kubernetes puts 50 pods on a node that can only run 10.
3. **Capacity doesn't match demand.** Traffic triples at 9am and your fixed 3 replicas fall over; at 3am those same 3 replicas idle and waste money.

Kubernetes solves these with **two independent systems**, and keeping them separate in your head is the single most useful thing you can do:

| Question | System | Enforced by |
|---|---|---|
| **How big may one pod be?** | `requests` and `limits` | The **Linux kernel**, via cgroups |
| **How many pods should exist?** | **HPA** (HorizontalPodAutoscaler) | A **control loop** in Kubernetes |

They meet at one number: **the HPA measures usage as a percentage of `requests`**. So requests are load-bearing for both systems at once — get them wrong and scheduling *and* autoscaling are both wrong.

---

# PART 2 — The terms

Skim this, then come back when a word confuses you later.

## Units

**Millicore (`m`)** — the unit of CPU. `1000m` = `1` = one full CPU core. `500m` = half a core. `100m` = a tenth of a core. It means "CPU time", not "a specific core" — `500m` can be served by any core, or spread across several.

**Mi / Gi vs M / G** — memory units. `Mi` is **binary** (1 Mi = 1,048,576 bytes); `M` is **decimal** (1 M = 1,000,000 bytes). Always use `Mi`/`Gi` — mixing them causes limits that are ~5% smaller than you intended.

**Allocatable** — a node's total capacity *minus* what the OS, the kubelet, and system daemons reserve. An 8 GB node might only offer ~7.2 GB allocatable to pods. Check with `kubectl describe node`.

## The two resource fields

**Request** — what the **scheduler reserves** for a container. It's a *promise*: "this much will always be available to me." The scheduler adds up the requests of all pods on a node and refuses to place another if the total would exceed allocatable. It is **not** a cap — a container may use more if it's free.

**Limit** — the **hard ceiling** the kernel enforces at runtime. It is a cap: you may never exceed it.

```yaml
resources:
  requests:          # reserved for me, guaranteed
    cpu: 200m
    memory: 64Mi
  limits:            # my ceiling, enforced by the kernel
    cpu: 500m
    memory: 128Mi
```

**Compressible vs incompressible** — the reason CPU and memory behave completely differently:
- **CPU is compressible.** You can always give a process *less* CPU; it just runs slower. Exceeding a CPU limit → **throttled**.
- **Memory is incompressible.** You can't give a process "less memory" — the bytes are either there or they aren't. Exceeding a memory limit → **killed**.

## cgroups and the kernel

**cgroup (control group)** — a Linux kernel feature that limits and accounts for the resource usage of a group of processes. It's exposed as files: you configure the kernel by writing numbers into `/sys/fs/cgroup/...` and read usage back out. **Kubernetes never enforces a limit itself** — it writes cgroup values and the kernel does the work.

**CFS (Completely Fair Scheduler)** — the Linux CPU scheduler. It divides time into **periods** and hands out **quota** within each one.

**Period** — the CFS accounting window, **100ms (100,000µs)** by default. CPU budgets are refilled at the start of every period.

**Quota** — how much CPU time your cgroup may consume **per period**. This is what `limits.cpu` becomes:

```
limits.cpu: 500m  →  0.5 cores  →  quota = 0.5 × 100ms = 50ms per 100ms period
                     written as cpu.max = "50000 100000"
```

**Throttling** — when a cgroup exhausts its quota mid-period, **every thread in it is frozen** until the next period begins. The container isn't killed; it's paused. This is what makes CPU limits cause latency spikes.

**Shares / weight** — derived from `requests.cpu`, this is a **relative priority** used only **when the CPU is contended**. Two pods with weights 100 and 200 split a busy CPU roughly 1:2. On an idle node, weights are irrelevant and both run flat out.

> **Quota vs shares is the distinction people miss.** Quota is an absolute ceiling enforced always, even on a completely idle machine. Shares only matter when there's competition. `limits` → quota; `requests` → shares.

**OOMKill (Out Of Memory Kill)** — when a container exceeds its memory limit, the kernel sends **SIGKILL**. No graceful shutdown, no cleanup, no chance to flush. Exit code **137** (= 128 + 9, where 9 is SIGKILL).

**Working set** — the memory actually charged to your cgroup. It's **more than your heap**: it includes page cache for files you read/write, kernel memory like socket buffers, and any in-memory tmpfs. This is why a container "using 100Mi" can be OOMKilled at a 128Mi limit.

## QoS

**QoS class (Quality of Service)** — a label Kubernetes **derives** from your resources block. You never set it. It determines **who gets killed first** when a node runs out of memory.

| Class | Condition | Meaning |
|---|---|---|
| **Guaranteed** | Every container has `requests == limits` for **both** CPU and memory | Most protected. Killed last. |
| **Burstable** | At least one request or limit set, but not matching | Can use spare capacity, but it isn't reserved. |
| **BestEffort** | No requests and no limits at all | Zero protection. Killed first. Never use in production. |

**oom_score_adj** — the number that makes QoS real. A per-process bias (−1000 to 1000) the kernel adds when scoring OOM kill candidates. Kubernetes sets **1000** for BestEffort ("kill me first") and **−997** for Guaranteed ("kill me last").

**Eviction** — the **kubelet** removing pods because the **node** is short on memory or disk. Victims are chosen by **QoS**. Pod status becomes `Evicted` and it's rescheduled elsewhere.

**Preemption** — the **scheduler** removing a lower-**priority** pod to make room for a higher-priority one at *scheduling* time.

> **Three different things can kill your pod:**
> | | Who | Why | Chosen by |
> |---|---|---|---|
> | **OOMKill** | Kernel | *This container* exceeded *its own* limit | n/a — it's you |
> | **Eviction** | Kubelet | The *node* is under pressure | **QoS class** |
> | **Preemption** | Scheduler | A more important pod needs the room | **PriorityClass** |

**PriorityClass** — a named integer priority. Higher-priority pods can preempt lower ones. `preemptionPolicy: Never` means "I wait my turn, I never displace anyone."

## Governance

**LimitRange** — a **per-container** admission-time policy in a namespace. It can *inject* defaults when you omit resources, and *reject* pods outside allowed bounds.

**maxLimitRequestRatio** — a LimitRange field capping how far a limit may exceed its request. A ratio of `4` means requesting `100m` forbids a limit above `400m`. It stops teams reserving almost nothing while claiming the right to burst enormously — which wrecks scheduling accuracy.

**ResourceQuota** — a **per-namespace** ceiling on totals: summed requests/limits, and object counts (`pods`, `services`, `pvc`). LimitRange governs *each container*; ResourceQuota governs *the whole namespace*.

## Autoscaling

**Replica** — one running copy of a pod. "Scaling" a Deployment means changing the replica count.

**HPA (HorizontalPodAutoscaler)** — a control loop that adjusts the replica count based on metrics. **Horizontal** = more copies. (**Vertical** = bigger copies — that's VPA.)

**Utilization** — the HPA's percentage. **Critically: it is usage ÷ `requests`.** Never ÷ limits, never ÷ node capacity. A pod requesting `200m` and using `200m` is at **100%**, even if its limit is `500m` and the node is idle.

**Target** — the utilization or value you want to hold. `averageUtilization: 50` means "keep average CPU at 50% of request."

**Tolerance** — a built-in 10% dead zone. If current is within 10% of target, the HPA does nothing. Without it you'd get endless ±1 replica flapping.

**Stabilization window** — how far back the HPA looks before acting, using the most conservative recommendation in that period. Scale-**down** defaults to **300s** (5 minutes); scale-**up** defaults to 0. That asymmetry is deliberate: react to spikes instantly, shrink cautiously.

**Scaling policy** — a rate limit, e.g. "at most +100% every 15s" or "at most −25% every 60s".

**metrics-server** — a lightweight cluster component that collects CPU/memory from each kubelet and serves it via the `metrics.k8s.io` API. It stores **nothing** — it exists purely for `kubectl top` and the HPA. **Without it, every HPA reports `<unknown>` and never scales.** It is *not* Prometheus and Prometheus does not replace it.

**Custom / external metrics** — scaling on something other than CPU/memory. *Custom* = an in-cluster metric (requests/sec, queue depth) served by the **Prometheus Adapter**. *External* = something outside the cluster (SQS depth, Kafka lag), usually served by **KEDA**.

**VPA (VerticalPodAutoscaler)** — adjusts `requests`/`limits` — the pod's **size** — based on observed usage.

**KEDA** — event-driven autoscaling. Does the two things a plain HPA can't: **scale to zero**, and scale on external event sources. It doesn't replace the HPA; it creates one and feeds it.

**Cluster Autoscaler / Karpenter** — add and remove **nodes** when pods can't be scheduled. HPA adds *pods*; these add *machines*. You need both.

**PDB (PodDisruptionBudget)** — a floor on how many pods may be voluntarily removed at once (by scale-down, node drains, or consolidation).

---

# PART 3 — How it works

## Stage 1 — You declare intent

```yaml
resources:
  requests: { cpu: 200m, memory: 64Mi }
  limits:   { cpu: 500m, memory: 128Mi }
```

Nothing has happened yet. This is just data in etcd.

## Stage 2 — The scheduler places the pod (requests only)

The scheduler looks **only at `requests`**, never limits. It finds nodes where `sum(requests of existing pods) + this pod's requests ≤ allocatable`, scores the candidates, and binds the pod to the winner.

> **This is why over-committing happens.** Limits are ignored here, so a node can host pods whose *limits* total 300% of its capacity. That's usually fine — most pods don't peak simultaneously — but it's why a node can be "full" by requests while sitting idle, and why it can also be driven into memory pressure.

## Stage 3 — The kubelet translates limits into cgroup values

```
limits.cpu: 500m
   → 0.5 cores × 100,000µs period
   → cpu.max = "50000 100000"

limits.memory: 128Mi
   → memory.max = 134217728

requests.cpu: 200m
   → cpu.weight (relative share when contended)
```

The kubelet passes these to the container runtime (containerd → runc), which writes them into the cgroup filesystem. From this moment the **kernel** is enforcing them, with no further Kubernetes involvement.

You can read them back:

```bash
kubectl exec -n loadlab deploy/load-lab -- cat /sys/fs/cgroup/cpu.max
# 50000 100000
```

## Stage 4 — Kubernetes derives the QoS class

Looking at the same resources block:

```
requests == limits for BOTH cpu and memory?  → Guaranteed
otherwise, anything set at all?              → Burstable
nothing set?                                 → BestEffort
```

This sets `oom_score_adj` on the container's processes, deciding kill order under node pressure.

## Stage 5 — The kernel enforces, continuously

**CPU:** every 100ms the quota refills. Use it up and every thread freezes until the next period.

```
period 1 |■■■■■■■■■■■✗--------|  50ms quota used, 50ms STALLED
period 2 |■■■■■■■■■■■✗--------|
```

**Memory:** every allocation is charged to the cgroup. Cross `memory.max` and the kernel tries to reclaim page cache; if that isn't enough, **SIGKILL**.

## Stage 6 — The HPA loop runs (every 15 seconds)

```
1. Read current replicas
2. Fetch metrics (metrics-server / adapter / KEDA)
3. desired = ceil( current × (currentMetric / targetMetric) )
4. Within 10% tolerance? → do nothing
5. Apply behavior policies (rate limits + stabilization windows)
6. Clamp to [minReplicas, maxReplicas]
7. Patch the Deployment's replica count
```

**Worked example.** `requests.cpu: 200m`, target `50%` → target usage is **100m per pod**. 3 pods averaging 180m:

```
desired = ceil( 3 × (180 / 100) ) = ceil(5.4) = 6 replicas
```

## Stage 7 — New pods need somewhere to go

More replicas → the scheduler needs capacity. If there is none, pods sit **`Pending`**, and only a **Cluster Autoscaler or Karpenter** can fix that by adding a node.

```
HPA adds pods ──▶ no room? ──▶ Pending ──▶ Cluster Autoscaler adds a node
```

Configure only the HPA and a traffic spike gives you `Pending` pods and no extra capacity.

---

# PART 4 — How to configure it, and in which file

## The rule for *where*

| What you're configuring | Goes in | Why |
|---|---|---|
| requests / limits | The **workload** manifest (Deployment/StatefulSet/Pod), under each container | It's a property of the container |
| QoS class | **Nowhere** — derived from requests/limits | You cannot set it directly |
| Replica scaling | A separate **HorizontalPodAutoscaler** object | Different lifecycle from the Deployment |
| Namespace defaults & bounds | **LimitRange** | Applies to every container in the namespace |
| Namespace totals | **ResourceQuota** | Applies to the namespace as a whole |
| Scheduling priority | **PriorityClass** (cluster-scoped) + `priorityClassName` on the pod | Priorities are shared cluster-wide |
| Disruption floor | **PodDisruptionBudget** | Consulted by the eviction API |

---

## 1. requests and limits → the workload manifest

**File:** [manifests/10-workload.yaml](manifests/10-workload.yaml)
**Path:** `spec.template.spec.containers[].resources`

```yaml
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
        - name: load-lab
          resources:              # ← HERE, per container
            requests:
              cpu: 200m
              memory: 64Mi
            limits:
              cpu: 500m
              memory: 128Mi
```

**It must be inside `spec.template.spec.containers[]`** — on the *pod template*, not on the Deployment itself. Putting it at the Deployment level silently does nothing.

Verify:
```bash
kubectl get deploy load-lab -n loadlab \
  -o jsonpath='{.spec.template.spec.containers[0].resources}'
```

## 2. QoS class → you don't declare it

**File:** none. It's computed. To *get* a particular class, shape your resources:

```yaml
# Guaranteed — requests == limits, both resources
resources:
  requests: { cpu: 200m, memory: 128Mi }
  limits:   { cpu: 200m, memory: 128Mi }

# Burstable — request < limit
resources:
  requests: { cpu: 100m, memory: 64Mi }
  limits:   { cpu: 500m, memory: 256Mi }

# BestEffort — omit the block entirely (don't)
```

See all three side by side in [manifests/20-qos-classes.yaml](manifests/20-qos-classes.yaml). Check the result:
```bash
kubectl get pod <pod> -n loadlab -o jsonpath='{.status.qosClass}'
```

## 3. HPA → its own object

**File:** [manifests/30-hpa-cpu.yaml](manifests/30-hpa-cpu.yaml)
**Kind:** `HorizontalPodAutoscaler`, `apiVersion: autoscaling/v2`

```yaml
apiVersion: autoscaling/v2          # ← v2, not v1. v1 only does CPU.
kind: HorizontalPodAutoscaler
metadata:
  name: load-lab-cpu
  namespace: loadlab                # ← must match the target's namespace
spec:
  scaleTargetRef:                   # ← WHAT to scale
    apiVersion: apps/v1
    kind: Deployment
    name: load-lab
  minReplicas: 1                    # ← floor
  maxReplicas: 10                   # ← ceiling
  metrics:                          # ← WHEN to scale
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 50    # 50% of requests.cpu
  behavior:                         # ← HOW FAST to scale
    scaleUp:
      stabilizationWindowSeconds: 0
      policies:
        - { type: Percent, value: 100, periodSeconds: 15 }
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
        - { type: Percent, value: 25, periodSeconds: 60 }
```

Three prerequisites, all of which people forget:
1. **metrics-server must be installed** or targets read `<unknown>` forever.
2. **The target container must have a CPU request** — no request, no percentage, no scaling.
3. **Remove `replicas:` from the Deployment** if it's GitOps-managed, or Argo CD/Flux will fight the HPA every sync.

Verify:
```bash
kubectl get hpa -n loadlab          # TARGETS must show a number, not <unknown>
kubectl describe hpa -n loadlab load-lab-cpu
```

## 4. Namespace defaults and bounds → LimitRange

**File:** [manifests/21-limitrange-quota.yaml](manifests/21-limitrange-quota.yaml)

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  namespace: loadlab                # ← namespaced
spec:
  limits:
    - type: Container
      default:                      # injected if limits omitted
        { cpu: 500m, memory: 256Mi }
      defaultRequest:               # injected if requests omitted
        { cpu: 100m, memory: 64Mi }
      min: { cpu: 50m, memory: 32Mi }     # reject below this
      max: { cpu: "2", memory: 1Gi }      # reject above this
      maxLimitRequestRatio: { cpu: "4" }  # limit ≤ 4 × request
```

> **It only affects pods created *after* it exists.** Applying a LimitRange does not retrofit running pods — you must recreate them.

## 5. Namespace totals → ResourceQuota

Same file. Once a quota exists on `requests.cpu`, **every pod in the namespace must declare that resource** or be rejected — which is why you almost always pair it with a LimitRange that supplies defaults.

```yaml
apiVersion: v1
kind: ResourceQuota
spec:
  hard:
    requests.cpu: "2"
    requests.memory: 2Gi
    limits.cpu: "4"
    limits.memory: 4Gi
    pods: "20"
```

```bash
kubectl describe resourcequota -n loadlab loadlab-quota   # see consumption
```

## 6. Priority → PriorityClass + a pod field

**File:** [manifests/40-priorityclass-preemption.yaml](manifests/40-priorityclass-preemption.yaml)

Two parts. The class is **cluster-scoped**:

```yaml
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: high-priority               # no namespace — cluster-wide
value: 1000000
preemptionPolicy: PreemptLowerPriority
```

Then reference it **on the pod spec** (not in `containers`):

```yaml
spec:
  template:
    spec:
      priorityClassName: high-priority     # ← pod level
      containers: [...]
```

## 7. Custom-metric HPA → same HPA object, different `metrics` block

**File:** [manifests/32-hpa-custom-metric.yaml](manifests/32-hpa-custom-metric.yaml)

```yaml
metrics:
  - type: Pods                      # averaged across pods
    pods:
      metric: { name: app_queue_depth }
      target:
        type: AverageValue
        averageValue: "30"
```

Requires the **Prometheus Adapter**. Confirm the metric is being served *before* creating the HPA:
```bash
kubectl get --raw "/apis/custom.metrics.k8s.io/v1beta1" | grep queue
```

## 8. VPA / KEDA / PDB

**File:** [manifests/50-vpa-keda-pdb.yaml](manifests/50-vpa-keda-pdb.yaml)

VPA (`autoscaling.k8s.io/v1`) and KEDA (`keda.sh/v1alpha1`) are **CRDs** — their operators must be installed or `kubectl apply` fails with `no matches for kind`. The PDB (`policy/v1`) is built in and always works.

---

## Complete cheat sheet — concept → file → field

| Concept | Kind | File | Field path |
|---|---|---|---|
| CPU/memory reservation | Deployment | [10-workload.yaml](manifests/10-workload.yaml) | `spec.template.spec.containers[].resources.requests` |
| CPU/memory ceiling | Deployment | [10-workload.yaml](manifests/10-workload.yaml) | `...resources.limits` |
| QoS class | — | *derived* | — |
| Replica autoscaling | HorizontalPodAutoscaler | [30-hpa-cpu.yaml](manifests/30-hpa-cpu.yaml) | `spec.metrics`, `spec.behavior` |
| Min/max replicas | HorizontalPodAutoscaler | [30-hpa-cpu.yaml](manifests/30-hpa-cpu.yaml) | `spec.minReplicas` / `maxReplicas` |
| Scale speed | HorizontalPodAutoscaler | [30-hpa-cpu.yaml](manifests/30-hpa-cpu.yaml) | `spec.behavior.scaleUp` / `scaleDown` |
| Custom metric | HorizontalPodAutoscaler | [32-hpa-custom-metric.yaml](manifests/32-hpa-custom-metric.yaml) | `spec.metrics[].type: Pods/Object/External` |
| Namespace defaults | LimitRange | [21-limitrange-quota.yaml](manifests/21-limitrange-quota.yaml) | `spec.limits[].default` / `defaultRequest` |
| Per-container bounds | LimitRange | [21-limitrange-quota.yaml](manifests/21-limitrange-quota.yaml) | `spec.limits[].min` / `max` |
| Limit:request ratio cap | LimitRange | [21-limitrange-quota.yaml](manifests/21-limitrange-quota.yaml) | `spec.limits[].maxLimitRequestRatio` |
| Namespace totals | ResourceQuota | [21-limitrange-quota.yaml](manifests/21-limitrange-quota.yaml) | `spec.hard` |
| Priority definition | PriorityClass | [40-priorityclass-preemption.yaml](manifests/40-priorityclass-preemption.yaml) | `value`, `preemptionPolicy` |
| Priority assignment | Deployment | [40-priorityclass-preemption.yaml](manifests/40-priorityclass-preemption.yaml) | `spec.template.spec.priorityClassName` |
| Right-sizing | VerticalPodAutoscaler | [50-vpa-keda-pdb.yaml](manifests/50-vpa-keda-pdb.yaml) | `spec.updatePolicy.updateMode` |
| Event scaling / scale-to-zero | ScaledObject (KEDA) | [50-vpa-keda-pdb.yaml](manifests/50-vpa-keda-pdb.yaml) | `spec.triggers` |
| Disruption floor | PodDisruptionBudget | [50-vpa-keda-pdb.yaml](manifests/50-vpa-keda-pdb.yaml) | `spec.maxUnavailable` |

---

## The five things that trip everyone up

1. **`resources` goes on the container, inside `spec.template.spec.containers[]`** — not on the Deployment.
2. **HPA utilization is a % of `requests`**, not of limits and not of node capacity.
3. **No CPU request → the HPA never works.** It shows `<unknown>` forever.
4. **metrics-server is mandatory** and is not the same thing as Prometheus.
5. **A LimitRange only affects pods created after it exists.** Apply it first, or recreate the pods.

Next: [README.md](README.md) for the diagrams, [CGROUPS.md](CGROUPS.md) to read the kernel's view, [RUN-STEPS.md](RUN-STEPS.md) to prove all of it on a cluster.
