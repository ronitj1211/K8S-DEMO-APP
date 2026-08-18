# cgroups — seeing the enforcement for yourself

"Limits are enforced by cgroups" is repeated everywhere and demonstrated almost nowhere. This document opens the files.

---

## What a cgroup actually is

A **control group** is a kernel feature that limits, accounts for, and isolates resource usage of a set of processes. It's exposed as a **filesystem**: you configure the kernel by writing numbers into files, and you read usage back out of other files.

A container is not a kernel object. "Container" = **namespaces** (isolation: what you can *see*) + **cgroups** (limits: what you can *use*) + a filesystem image. Kubernetes never enforces a limit itself — it writes cgroup values and the kernel does the rest.

```
   Kubernetes Pod spec  ──▶  kubelet  ──▶  CRI  ──▶  runc  ──▶  cgroup files
                                                                     │
                                                                     ▼
                                                          Linux CFS scheduler
                                                          Linux memory controller
```

---

## cgroup v1 vs v2

| | v1 | v2 |
|---|---|---|
| Layout | One hierarchy **per controller** (`/sys/fs/cgroup/cpu/`, `/memory/`, …) | **Unified** single hierarchy (`/sys/fs/cgroup/`) |
| CPU limit file | `cpu.cfs_quota_us` + `cpu.cfs_period_us` | `cpu.max` (both values, one line) |
| CPU shares | `cpu.shares` (2–262144) | `cpu.weight` (1–10000) |
| Memory limit | `memory.limit_in_bytes` | `memory.max` |
| Memory usage | `memory.usage_in_bytes` (includes cache) | `memory.current` |
| Soft limit | `memory.soft_limit_in_bytes` | `memory.low` / `memory.high` |
| Pressure info | — | **PSI** (`cpu.pressure`, `memory.pressure`, `io.pressure`) |
| OOM behaviour | Kills a process in the group | Can kill the whole group (`memory.oom.group`) |

Detect which you're on:

```bash
# In the container:
[ -f /sys/fs/cgroup/cgroup.controllers ] && echo v2 || echo v1
# On the node:
stat -fc %T /sys/fs/cgroup      # cgroup2fs = v2, tmpfs = v1
```

v2 is the default on modern distros (RHEL 9, Ubuntu 22.04+, Amazon Linux 2023, Bottlerocket) and required for some newer features. **`memory.high` is the big v2 win** — it throttles allocation *before* killing, giving the app a chance to shed load rather than being SIGKILLed outright.

---

## Reading it from inside the container

The app in this project exposes `/cgroup`, which reads these files and returns JSON:

```bash
kubectl exec -n loadlab deploy/load-lab -- wget -qO- localhost:3000/cgroup
```

```json
{
  "pod": "load-lab-7d9f8c-x4k2p",
  "runtime_view": {
    "os_cpus": 8,                    ← the NODE has 8 cores...
    "os_total_mem_mib": 7962         ← ...and 8 GB of RAM
  },
  "cgroup_view": {
    "cgroup_version": "v2",
    "cpu": {
      "raw": "50000 100000",
      "limit_cores": 0.5,            ← ...but you may use 0.5 of a core
      "nr_periods": 4821,
      "nr_throttled": 0,
      "throttled_seconds": 0,
      "throttled_pct": 0
    },
    "memory": {
      "limit_mib": 128,              ← ...and 128 MiB of the 8 GB
      "current_mib": 41
    }
  }
}
```

**The gap between `runtime_view` and `cgroup_view` is the whole problem.** `os.cpus()` returns **8** — the node's core count — while the container may only use **0.5**. Any runtime that sizes thread pools from the "CPU count" will create 8 workers to share half a core, burn its CFS quota almost instantly, and stall.

| Runtime | Wrong default | Fix |
|---|---|---|
| Go | `GOMAXPROCS` = node cores | `GOMAXPROCS` from limit, or `automaxprocs` |
| Java (pre-8u191) | Heap from node RAM | JDK 11+: `-XX:MaxRAMPercentage=70` |
| Node.js | `UV_THREADPOOL_SIZE` = 4, `os.cpus()` for clustering | set explicitly from the limit |
| Python | `multiprocessing.cpu_count()` | `len(os.sched_getaffinity(0))` |
| Nginx | `worker_processes auto` = node cores | pin it to the CPU limit |

---

## Reading it on the node directly

```bash
# Get onto the node (Colima)
colima ssh

# cgroup v2 — find the pod's slice
sudo find /sys/fs/cgroup/kubepods.slice -name "*load-lab*" -maxdepth 3 | head

cd /sys/fs/cgroup/kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod<UID>.slice

cat cpu.max          # "50000 100000"  = quota_us period_us
cat cpu.weight       # derived from requests.cpu
cat cpu.stat         # usage_usec, nr_periods, nr_throttled, throttled_usec
cat memory.max       # 134217728 (=128Mi)
cat memory.current   # bytes charged right now
cat memory.events    # low/high/max/oom/oom_kill counters
cat pids.max         # process-count limit
```

### The exact translation

| Pod spec | cgroup v2 file | Value | Meaning |
|---|---|---|---|
| `limits.cpu: 500m` | `cpu.max` | `50000 100000` | 50ms of CPU per 100ms period |
| `limits.cpu: "2"` | `cpu.max` | `200000 100000` | 200ms per 100ms — i.e. 2 full cores |
| *(no cpu limit)* | `cpu.max` | `max 100000` | unlimited |
| `requests.cpu: 200m` | `cpu.weight` | `~8` | relative share **only when contended** |
| `limits.memory: 128Mi` | `memory.max` | `134217728` | hard ceiling; exceed → OOMKill |
| `requests.memory: 64Mi` | `memory.low` | `67108864` | reclaim protection, not a guarantee |

**`cpu.weight` (shares) vs `cpu.max` (quota) is the distinction people miss:**

- **Shares** only matter when the CPU is **contended**. Two pods with weights 100 and 200 on a busy node get roughly 1:2. On an idle node, both run as fast as they like.
- **Quota** is an **absolute ceiling**, enforced whether or not anyone else wants the CPU. A 500m-limited pod on a completely idle 64-core node still gets 500m.

That's why *requests* alone give you fair sharing with burst headroom, while *limits* give you predictable but capped performance.

---

## Proving CPU throttling

```bash
# 1. Baseline
kubectl exec -n loadlab deploy/load-lab -- wget -qO- localhost:3000/cgroup \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['cgroup_view']['cpu'])"
# nr_throttled: 0

# 2. Ask for far more CPU than the 500m limit allows
for i in $(seq 1 20); do
  kubectl exec -n loadlab deploy/load-lab -- wget -qO- "localhost:3000/burn-cpu?ms=1000" &
done; wait

# 3. Look again
kubectl exec -n loadlab deploy/load-lab -- wget -qO- localhost:3000/cgroup \
  | python3 -c "import json,sys; c=json.load(sys.stdin)['cgroup_view']['cpu']; print(c)"
# nr_throttled: 1847, throttled_seconds: 92.4, throttled_pct: 38.3
```

`throttled_pct` above ~5% sustained means the CPU limit is actively costing you latency. In Prometheus:

```promql
rate(container_cpu_cfs_throttled_periods_total{namespace="loadlab"}[5m])
  / rate(container_cpu_cfs_periods_total{namespace="loadlab"}[5m])
```

> **The counter-intuitive part:** a container can be throttled while `kubectl top pod` shows it using only ~50% CPU. Average utilisation is measured over seconds; throttling happens per **100ms period**. Bursty work exhausts its quota early in each period and stalls for the remainder, so the average looks calm while p99 latency is terrible.

---

## Proving an OOMKill

```bash
# The limit is 128Mi. Walk memory up past it.
kubectl exec -n loadlab deploy/load-lab -- wget -qO- "localhost:3000/alloc-mem?mib=40"
kubectl exec -n loadlab deploy/load-lab -- wget -qO- "localhost:3000/alloc-mem?mib=40"
kubectl exec -n loadlab deploy/load-lab -- wget -qO- "localhost:3000/alloc-mem?mib=60"   # boom

kubectl get pods -n loadlab -w
# load-lab-...  0/1  OOMKilled  0  2m
# load-lab-...  1/1  Running    1  2m     ← restarted

kubectl describe pod -n loadlab -l app=load-lab | grep -A6 "Last State"
#   Last State:  Terminated
#     Reason:    OOMKilled
#     Exit Code: 137
```

**Exit code 137 = 128 + 9 = SIGKILL.** There is no graceful shutdown, no `SIGTERM`, no chance to flush anything. The process is simply gone.

On cgroup v2 you can also read the counter directly:

```bash
kubectl exec -n loadlab deploy/load-lab -- cat /sys/fs/cgroup/memory.events
# low 0
# high 0
# max 14        ← times it hit the ceiling and had to reclaim
# oom 1
# oom_kill 1    ← times a process was actually killed
```

### Why "my app only uses 100Mi but gets OOMKilled at 128Mi"

`memory.current` counts more than your heap:

- RSS (your actual allocations)
- **page cache** for files the container reads/writes
- kernel memory: socket buffers, dentries, inodes
- tmpfs mounts — **an `emptyDir: {medium: Memory}` counts against your limit**

The usual culprits: a log file being written quickly (page cache), a JVM whose heap is set to the container limit with no headroom for metaspace/stacks/native, or a runtime that never returns freed memory to the OS. Rule of thumb: **limit ≈ 1.5× observed p99 working set**, and for the JVM set `-XX:MaxRAMPercentage=70` rather than a fixed `-Xmx` equal to the limit.

---

## Comparing the three QoS classes side by side

```bash
kubectl apply -f manifests/20-qos-classes.yaml

kubectl get pods -n loadlab -l demo=qos \
  -o custom-columns=NAME:.metadata.name,QOS:.status.qosClass
# qos-guaranteed   Guaranteed
# qos-burstable    Burstable
# qos-besteffort   BestEffort

# The cgroup values differ accordingly:
for p in qos-guaranteed qos-burstable qos-besteffort; do
  echo "--- $p"
  kubectl exec -n loadlab $p -- sh -c 'cat /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max' 2>/dev/null
done
# guaranteed: 20000 100000  /  134217728
# burstable:  50000 100000  /  268435456
# besteffort: max 100000    /  max          ← no ceiling at all
```

And the kill preference the kernel was given:

```bash
kubectl exec -n loadlab qos-besteffort -- cat /proc/1/oom_score_adj   # 1000
kubectl exec -n loadlab qos-guaranteed -- cat /proc/1/oom_score_adj   # -997
```

That single number is how QoS becomes real: under node memory pressure, the kernel's OOM killer scores every process and `oom_score_adj` biases the choice. BestEffort volunteers itself.

---

## Other cgroup controllers Kubernetes uses

| Controller | Kubernetes exposure | Notes |
|---|---|---|
| `cpu` | requests → weight, limits → quota | The main one |
| `cpuset` | `static` CPU Manager policy | Pins Guaranteed pods with integer CPU to dedicated cores — removes scheduler jitter for latency-critical work |
| `memory` | requests → `memory.low`, limits → `memory.max` | |
| `pids` | `--pod-max-pids` on the kubelet | Guards against fork bombs |
| `io` | not exposed by core Kubernetes | Disk I/O isolation needs a CSI/runtime feature |
| `hugetlb` | `hugepages-2Mi` resource | For DPDK/databases |

**CPU Manager** is worth knowing for interviews: with `--cpu-manager-policy=static`, a **Guaranteed** pod requesting a **whole number** of CPUs gets exclusive cores via `cpuset`, rather than time-sliced quota. Fractional requests (`500m`) never qualify.

---

## Quick reference — every file worth knowing

```bash
# cgroup v2, from inside a container
/sys/fs/cgroup/cpu.max            # "quota period" — the CPU limit
/sys/fs/cgroup/cpu.weight         # relative share, from the request
/sys/fs/cgroup/cpu.stat           # nr_periods, nr_throttled, throttled_usec
/sys/fs/cgroup/cpu.pressure       # PSI: how long tasks stalled waiting for CPU
/sys/fs/cgroup/memory.max         # hard memory ceiling
/sys/fs/cgroup/memory.high        # throttle-before-kill threshold (v2 only)
/sys/fs/cgroup/memory.current     # bytes charged now
/sys/fs/cgroup/memory.events      # low/high/max/oom/oom_kill counters
/sys/fs/cgroup/memory.stat        # detailed breakdown incl. page cache
/sys/fs/cgroup/pids.max           # process limit

# cgroup v1 equivalents
/sys/fs/cgroup/cpu/cpu.cfs_quota_us
/sys/fs/cgroup/cpu/cpu.cfs_period_us
/sys/fs/cgroup/cpu/cpu.shares
/sys/fs/cgroup/cpu/cpu.stat
/sys/fs/cgroup/memory/memory.limit_in_bytes
/sys/fs/cgroup/memory/memory.usage_in_bytes
/sys/fs/cgroup/memory/memory.failcnt
```
