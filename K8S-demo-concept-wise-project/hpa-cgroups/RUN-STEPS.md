# Run Steps — HPA & cgroups lab

Nine experiments, each proving one mechanism. Concepts are in [README.md](README.md); the cgroup file reference is in [CGROUPS.md](CGROUPS.md).

---

## 0. Prerequisites

```bash
kubectl get nodes

# metrics-server is MANDATORY for any HPA
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
kubectl patch -n kube-system deploy metrics-server --type=json \
  -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'

# Must return data before continuing — an HPA with no metrics shows <unknown>
kubectl top nodes
```

---

## 1. Build and deploy

```bash
cd K8S-demo-concept-wise-project/hpa-cgroups/app
docker build -t load-lab:1.0 .

cd ..
kubectl apply -f manifests/00-namespace.yaml
kubectl apply -f manifests/10-workload.yaml
kubectl -n loadlab rollout status deploy/load-lab
```

Apply the governance objects **after** the workload — a LimitRange only affects pods created *after* it exists:

```bash
kubectl apply -f manifests/21-limitrange-quota.yaml
```

---

## 2. See what the kernel is actually enforcing

```bash
kubectl exec -n loadlab deploy/load-lab -- wget -qO- localhost:3000/cgroup | python3 -m json.tool
```

Compare the two halves of the output:

| | Value | Meaning |
|---|---|---|
| `runtime_view.os_cpus` | e.g. 8 | What `os.cpus()` reports — **the node's** cores |
| `cgroup_view.cpu.limit_cores` | 0.5 | What you may actually use |
| `runtime_view.os_total_mem_mib` | e.g. 7962 | The node's RAM |
| `cgroup_view.memory.limit_mib` | 128 | Your ceiling |

**That mismatch is the root of a whole class of production bugs** — runtimes sizing thread pools and heaps from the node's capacity instead of their own limit.

Cross-check against the raw files:

```bash
kubectl exec -n loadlab deploy/load-lab -- sh -c \
  'cat /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max 2>/dev/null || \
   cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us /sys/fs/cgroup/memory/memory.limit_in_bytes'
# 50000 100000        <- 50ms per 100ms = 500m
# 134217728           <- 128Mi
```

---

## 3. Experiment: cause CPU throttling

```bash
# Baseline — should be 0
kubectl exec -n loadlab deploy/load-lab -- wget -qO- localhost:3000/cgroup \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['cgroup_view']['cpu'])"

# Demand ~20x more CPU than the 500m limit permits
for i in $(seq 1 20); do
  kubectl exec -n loadlab deploy/load-lab -- wget -qO- "localhost:3000/burn-cpu?ms=1000" >/dev/null &
done; wait

# Now look
kubectl exec -n loadlab deploy/load-lab -- wget -qO- localhost:3000/cgroup \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['cgroup_view']['cpu'])"
```

`nr_throttled` and `throttled_seconds` will have jumped. Meanwhile:

```bash
kubectl top pod -n loadlab
```

may report something around 500m — looking "at the limit but fine". **The average hides the stalls.** Throttling is per-100ms-period; a burst exhausts the quota early and the process sits blocked for the rest of the period.

**Now prove the limit is the cause** — remove it and repeat:

```bash
kubectl set resources -n loadlab deploy/load-lab --limits=cpu=0    # remove CPU limit
kubectl -n loadlab rollout status deploy/load-lab
# re-run the burn loop — nr_throttled stays 0, and the same work finishes faster
kubectl set resources -n loadlab deploy/load-lab --limits=cpu=500m,memory=128Mi   # restore
```

---

## 4. Experiment: cause an OOMKill

```bash
kubectl get pods -n loadlab -w &      # watch in the background

# Limit is 128Mi; the app already uses ~40Mi
kubectl exec -n loadlab deploy/load-lab -- wget -qO- "localhost:3000/alloc-mem?mib=40"
kubectl exec -n loadlab deploy/load-lab -- wget -qO- "localhost:3000/alloc-mem?mib=40"
kubectl exec -n loadlab deploy/load-lab -- wget -qO- "localhost:3000/alloc-mem?mib=60"
```

The pod dies and restarts. Confirm the cause:

```bash
kubectl describe pod -n loadlab -l app=load-lab | grep -A6 "Last State"
#   Reason: OOMKilled
#   Exit Code: 137          <- 128 + 9 (SIGKILL)

kubectl exec -n loadlab deploy/load-lab -- cat /sys/fs/cgroup/memory.events | grep oom
```

Key observations:

- **No SIGTERM.** No graceful shutdown, no flush. The process is killed instantly.
- **The node had plenty of free memory** — this container exceeded *its own* ceiling. That's different from an *eviction*, which happens when the **node** is under pressure and the kubelet picks a victim by QoS.
- Repeat it a few times and you get `CrashLoopBackOff` with the backoff growing 10s → 20s → 40s, capped at 5 minutes.

---

## 5. Experiment: the three QoS classes

```bash
kubectl apply -f manifests/20-qos-classes.yaml
kubectl get pods -n loadlab -l demo=qos \
  -o custom-columns=NAME:.metadata.name,QOS:.status.qosClass,NODE:.spec.nodeName
```

You set no QoS field anywhere — Kubernetes **derived** it from the resources block. See how it became real in the kernel:

```bash
for p in qos-guaranteed qos-burstable qos-besteffort; do
  printf "%-16s oom_score_adj=" $p
  kubectl exec -n loadlab $p -- cat /proc/1/oom_score_adj
done
# qos-guaranteed   oom_score_adj=-997     <- kill me last
# qos-burstable    oom_score_adj=<varies>
# qos-besteffort   oom_score_adj=1000     <- kill me first
```

Note that `qos-besteffort` has **no cgroup limits at all** (`cpu.max: max`, `memory.max: max`) — it can consume the entire node until the kubelet evicts it.

```bash
kubectl delete -f manifests/20-qos-classes.yaml
```

---

## 6. Experiment: LimitRange defaults and rejection

The LimitRange from step 1 is already active. Create a pod with **no** resources:

```bash
kubectl run no-resources -n loadlab --image=load-lab:1.0 --restart=Never
kubectl get pod no-resources -n loadlab -o jsonpath='{.spec.containers[0].resources}' | python3 -m json.tool
```

It comes out with `requests: {cpu: 100m, memory: 64Mi}` and `limits: {cpu: 500m, memory: 256Mi}` — **injected at admission**. QoS is `Burstable`, not `BestEffort`. That one object eliminates BestEffort pods from the namespace.

Now try to violate the bounds:

```bash
kubectl run too-big -n loadlab --image=load-lab:1.0 --restart=Never \
  --overrides='{"spec":{"containers":[{"name":"too-big","image":"load-lab:1.0","resources":{"requests":{"cpu":"4"},"limits":{"cpu":"4"}}}]}}'
# Error ... maximum cpu usage per Container is 2, but limit is 4
```

Rejected at admission — it never reaches the scheduler. And the ratio rule:

```bash
kubectl run bad-ratio -n loadlab --image=load-lab:1.0 --restart=Never \
  --overrides='{"spec":{"containers":[{"name":"bad-ratio","image":"load-lab:1.0","resources":{"requests":{"cpu":"100m"},"limits":{"cpu":"2"}}}]}}'
# Error ... cpu max limit to request ratio per Container is 4, but provided ratio is 20
```

Check quota consumption:

```bash
kubectl describe resourcequota -n loadlab loadlab-quota
kubectl delete pod no-resources -n loadlab --ignore-not-found
```

---

## 7. Experiment: drive the HPA

```bash
kubectl apply -f manifests/30-hpa-cpu.yaml
kubectl get hpa -n loadlab -w &
```

Wait until the TARGETS column shows a real percentage rather than `<unknown>` (needs metrics-server plus ~30s).

```bash
# Sustained load from inside the cluster
kubectl run -n loadlab loadgen --image=busybox:1.36 --restart=Never -- \
  /bin/sh -c 'while true; do wget -q -O /dev/null "http://load-lab.loadlab.svc:3000/burn-cpu?ms=500"; done'
```

Watch the sequence:

```
NAME           REFERENCE             TARGETS   MINPODS MAXPODS REPLICAS
load-lab-cpu   Deployment/load-lab   12%/50%   1       10      1
load-lab-cpu   Deployment/load-lab   240%/50%  1       10      1     <- load lands
load-lab-cpu   Deployment/load-lab   240%/50%  1       10      2     <- doubling (behavior)
load-lab-cpu   Deployment/load-lab   180%/50%  1       10      4
load-lab-cpu   Deployment/load-lab   95%/50%   1       10      8
load-lab-cpu   Deployment/load-lab   48%/50%   1       10      8     <- settled
```

**Check the arithmetic yourself.** `requests.cpu` is 200m and the target is 50%, so the target usage is **100m per pod**. At 1 replica showing 240%:

```
desired = ceil( 1 × (240 / 50) ) = ceil(4.8) = 5
```

…but `behavior.scaleUp` caps growth at +100% per 15s, so it goes 1 → 2 → 4 → 8 instead of jumping straight to 5+. Read the decisions:

```bash
kubectl describe hpa -n loadlab load-lab-cpu | tail -20
```

Now stop the load and watch the **asymmetry**:

```bash
kubectl delete pod -n loadlab loadgen
```

Scale-down does not begin for **5 minutes** (`stabilizationWindowSeconds: 300`), then shrinks 25% at a time. That's deliberate: scale up fast to protect users, scale down slowly to avoid thrashing.

---

## 8. Experiment: two HPAs fighting

```bash
kubectl apply -f manifests/31-hpa-multi-metric.yaml   # second HPA, same target
kubectl get hpa -n loadlab
```

Both now write to the same Deployment's replica count, and they will oscillate against each other. Kubernetes does **not** prevent this.

```bash
kubectl describe hpa -n loadlab load-lab-multi | grep -A5 Events
kubectl delete hpa -n loadlab load-lab-multi        # keep only one
```

**One HPA per workload, always.**

---

## 9. Experiment: preemption

```bash
kubectl apply -f manifests/40-priorityclass-preemption.yaml
kubectl get pods -n loadlab -l app=overprovisioning
```

These low-priority `pause` pods hold real capacity and do nothing. Now demand that capacity with a high-priority pod:

```bash
kubectl run urgent -n loadlab --image=load-lab:1.0 --restart=Never \
  --overrides='{"spec":{"priorityClassName":"high-priority","containers":[{"name":"urgent","image":"load-lab:1.0","resources":{"requests":{"cpu":"200m","memory":"128Mi"}}}]}}'

kubectl get events -n loadlab --sort-by=.lastTimestamp | grep -i preempt
kubectl get pods -n loadlab
```

On a full node, an `overprovisioning` pod is evicted to make room, and `urgent` schedules in **seconds** instead of waiting ~60–90s for a new node. That's the over-provisioning pattern — trade a little constant cost for fast scale-up.

> **Preemption ≠ eviction.** Preemption is the **scheduler** removing a lower-**priority** pod at scheduling time. Eviction is the **kubelet** removing a pod under node **pressure**, chosen by **QoS**. Different component, different trigger.

```bash
kubectl delete pod urgent -n loadlab --ignore-not-found
```

---

## 10. Optional: custom-metric HPA

Requires the [prometheus-grafana](../prometheus-grafana/) stack plus the Prometheus Adapter.

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm install prometheus-adapter prometheus-community/prometheus-adapter -n monitoring \
  --set prometheus.url=http://prometheus.monitoring.svc --set prometheus.port=9090

# The metric must be served BEFORE the HPA can use it
kubectl get --raw "/apis/custom.metrics.k8s.io/v1beta1" | python3 -m json.tool | grep queue

kubectl apply -f manifests/32-hpa-custom-metric.yaml

# Drive it by hand — no message broker needed
kubectl exec -n loadlab deploy/load-lab -- wget -qO- --post-data='' localhost:3000/queue/300
kubectl get hpa -n loadlab load-lab-queue -w
# target is 30 per pod, so 300 queued -> 10 replicas
```

---

## 11. Optional: VPA recommendations

```bash
# install VPA first (see manifests/50-vpa-keda-pdb.yaml comments)
kubectl apply -f manifests/50-vpa-keda-pdb.yaml
sleep 300                      # VPA needs history before it recommends
kubectl describe vpa -n loadlab load-lab-vpa
```

```
Recommendation:
  Container Recommendations:
    Container Name:  load-lab
    Lower Bound:     cpu: 87m,  memory: 52Mi
    Target:          cpu: 152m, memory: 71Mi     <- what it suggests
    Upper Bound:     cpu: 421m, memory: 197Mi
```

`updateMode: "Off"` means it only advises. That's the right production setting — read the numbers, then change the manifest in Git deliberately.

---

## 12. Cleanup

```bash
kubectl delete -f manifests/ --ignore-not-found
kubectl delete ns loadlab --ignore-not-found
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| HPA TARGETS shows `<unknown>` | metrics-server missing/unhealthy, or the pod has **no CPU request** | `kubectl top pods`; add requests |
| HPA never scales up | Already at `maxReplicas`, or within the 10% tolerance | `kubectl describe hpa` |
| HPA never scales down | 5-minute stabilization window; or memory metric staying high | Wait; or drop the memory metric |
| Replicas oscillate | Two HPAs on one target, or too-short stabilization | One HPA per workload |
| `nr_throttled` climbing but CPU looks low | Bursty work exhausting quota per 100ms period | Raise/remove the CPU limit |
| OOMKilled well below the limit | Page cache, tmpfs, or JVM native memory counted | Limit ≈ 1.5× p99 working set |
| Pod `Pending` after HPA scales | No node capacity | Cluster Autoscaler / Karpenter |
| LimitRange not applying | Only affects pods created **after** it | Recreate the pods |
| VPA + HPA fighting | Both on the same metric | VPA on memory, HPA on CPU |
