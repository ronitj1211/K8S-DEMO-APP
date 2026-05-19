# Autoscaling (HPA) & Resource Management

Two tightly-related concepts:

- **Resource requests & limits** — how big each Pod is allowed to be.
- **HorizontalPodAutoscaler (HPA)** — how many Pods to run.

HPA can't work without resource **requests**, so they belong together.

---

# 1. Resource requests & limits

Every container can declare:

```yaml
resources:
  requests:                 # what the scheduler RESERVES for me
    cpu: 100m               # 100 milli-CPU = 0.1 vCPU
    memory: 64Mi
  limits:                   # the CEILING — I cannot exceed this
    cpu: 500m
    memory: 128Mi
```

### Units

- **CPU**: `1` = one vCPU. `500m` = half a vCPU. CPU is **compressible**: if you hit the limit you get **throttled** (slowed), not killed.
- **Memory**: bytes, with suffixes `Ki Mi Gi` (binary) or `K M G` (decimal). Memory is **incompressible**: if you exceed the limit you get **OOMKilled**.

### Why both?

| Field | What it controls |
|-------|------------------|
| **request** | What the scheduler reserves on a node. **Bin-packing is based on requests.** |
| **limit** | The hard ceiling at runtime. |

If you don't set a **request**, the scheduler thinks your Pod needs nothing and may pack too many Pods onto a node. If you don't set a **limit**, one bad Pod can starve neighbors.

### Common pitfalls

- Setting **CPU limit too tight** → your Pod gets throttled at low utilization and feels slow. Often it's safer to set CPU `request` and skip the CPU `limit`.
- Setting **memory request too low** → eviction during memory pressure.
- Setting **memory limit too tight** → mystery OOMKills under bursty traffic.

---

# 2. Quality of Service (QoS) classes

Kubernetes auto-assigns each Pod a **QoS class** based on its requests/limits. It uses this to decide who to evict first when a node runs out of memory.

| QoS class | When you get it | Eviction priority (under pressure) |
|-----------|-----------------|-------------------------------------|
| **Guaranteed** | Every container has `requests == limits` for **both** CPU and memory. | Last to be evicted. |
| **Burstable** | At least one request set, but not all `requests == limits`. | Evicted before Guaranteed. |
| **BestEffort** | No requests or limits anywhere. | First to be evicted. |

Production tip: run critical workloads as **Guaranteed**; let dev/test be **Burstable**; never run anything important as **BestEffort**.

See [`backend/03-qos-examples.yaml`](./backend/03-qos-examples.yaml) for one Pod of each class.

---

# 3. The HorizontalPodAutoscaler (HPA)

The HPA changes the **`spec.replicas`** of a Deployment (or StatefulSet, or ReplicaSet) based on observed metrics.

```
   metrics-server  ──reports CPU/mem per Pod──►  HPA  ──updates──►  Deployment.replicas
```

### How the math works

For CPU utilization with `averageUtilization: 50`:

- Each Pod's CPU **request** is 100m.
- Target = 50% of 100m = **50m per Pod**.
- Current average usage across Pods = 250m.
- Desired replicas = ceil(current_total / target_per_pod) = ceil(250m / 50m) = **5**.

The HPA recomputes this every 15 seconds.

### Why requests matter for the HPA

`averageUtilization` is a **percentage of the request**. If you don't set a CPU request, the HPA cannot compute utilization and will refuse to scale.

### Types of metrics

| Source | Example |
|--------|---------|
| **Resource** (CPU / memory) | `averageUtilization: 50` |
| **Pods** (custom per-Pod metric) | requests-per-second per Pod (needs Prometheus Adapter or similar) |
| **Object** (a single object's metric) | queue depth on one SQS / Kafka topic |
| **External** | a cloud metric not associated with a K8s object |

For everything beyond CPU/memory you'll typically install **Prometheus Adapter** or **KEDA**.

### autoscaling/v1 vs v2

- `autoscaling/v1` — CPU only.
- `autoscaling/v2` — multiple metrics, custom metrics, `behavior` block. **Use v2.**

---

# 4. Other autoscalers (briefly)

| Name | What it scales | Notes |
|------|----------------|-------|
| **HPA** | Pod **count** | This folder. |
| **VPA** (Vertical) | Pod **size** (requests/limits) | Recommend / auto-apply. Conflicts with HPA on the same Pod for CPU/mem. |
| **Cluster Autoscaler** | **Node count** | Adds/removes VMs from the cloud provider when Pods can't be scheduled. |
| **KEDA** | Pod count on **event-driven** metrics | Kafka lag, SQS depth, Redis list size, custom Prometheus. Builds on HPA. |
| **Karpenter** | Modern node provisioner on AWS/etc. | Replaces Cluster Autoscaler. Picks the best node shape per workload. |

---

## What's in this folder

```
autoscaling-resources/
├── backend/
│   ├── server.js                # /burn?ms=500 endpoint that burns CPU
│   ├── package.json, Dockerfile
│   ├── 01-deployment.yaml       # Deployment with cpu/memory requests + limits + Service
│   ├── 02-hpa.yaml              # HPA v2: 50% CPU, 1-5 replicas, with scale-up/down tuning
│   └── 03-qos-examples.yaml     # 3 Pods, one per QoS class
├── frontend/
│   ├── index.html, Dockerfile   # "Drive load" button to slam the backend
│   └── frontend.yaml
└── README.md
```

---

## Prerequisites

- Docker, `kubectl`, local cluster.
- **`metrics-server`** must be installed in the cluster — that's what HPA reads from.

### Install metrics-server

**minikube:**
```bash
minikube addons enable metrics-server
```

**kind / generic:**
```bash
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
# For local clusters, you'll usually need to add --kubelet-insecure-tls:
kubectl -n kube-system patch deploy metrics-server --type=json \
  -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'
```

Verify:

```bash
kubectl top nodes
kubectl top pods -A
```

If `kubectl top` works, the HPA will work.

---

## How to run

### 1. Build images

```bash
eval $(minikube docker-env)   # minikube only

cd backend  && docker build -t cpu-burner:1.0 .
cd ../frontend && docker build -t cpu-burner-ui:1.0 .
```

(kind: `kind load docker-image ...`)

### 2. Deploy + HPA

```bash
kubectl apply -f backend/01-deployment.yaml
kubectl apply -f backend/02-hpa.yaml
kubectl apply -f frontend/frontend.yaml
```

### 3. Check HPA + baseline

```bash
kubectl get hpa
kubectl describe hpa cpu-burner
kubectl get pods -l app=cpu-burner
kubectl top pods -l app=cpu-burner
```

At idle, the HPA will show `<unknown> / 50%` for ~30s, then a low percentage.

### 4. Drive load and watch it scale

In one terminal:

```bash
kubectl get hpa cpu-burner -w
```

In another:

```bash
kubectl get pods -l app=cpu-burner -w
```

In a third — generate load (option A: CLI):

```bash
NODE_IP=$(minikube ip)
while true; do
  for i in $(seq 1 20); do curl -s "http://$NODE_IP:30097/burn?ms=500" >/dev/null & done
  wait
done
```

(or option B: the UI at `http://$NODE_IP:30098` — click **Drive load**.)

Within ~60 seconds the HPA's `TARGETS` column will climb past 50% and `REPLICAS` will increase up to the cap of 5. Stop the load and (after the 5-minute stabilization window) replicas drop back to 1.

### 5. Inspect the QoS classes

```bash
kubectl apply -f backend/03-qos-examples.yaml
kubectl get pod qos-guaranteed qos-burstable qos-besteffort \
  -o custom-columns=NAME:.metadata.name,QOS:.status.qosClass
```

You should see:

```
NAME              QOS
qos-guaranteed    Guaranteed
qos-burstable     Burstable
qos-besteffort    BestEffort
```

---

## Useful commands

```bash
# HPA
kubectl get hpa
kubectl describe hpa cpu-burner
kubectl get hpa cpu-burner -w
kubectl autoscale deployment cpu-burner --cpu-percent=50 --min=1 --max=5   # imperative create

# metrics-server
kubectl top nodes
kubectl top pods
kubectl top pods --containers

# Resources
kubectl describe pod <name> | grep -A5 Resources
kubectl get pod <name> -o jsonpath='{.status.qosClass}'

# Scale manually (HPA may overwrite if it has its own opinion)
kubectl scale deployment cpu-burner --replicas=3
```

---

## Cleanup

```bash
kubectl delete -f backend/03-qos-examples.yaml
kubectl delete -f backend/02-hpa.yaml
kubectl delete -f backend/01-deployment.yaml
kubectl delete -f frontend/frontend.yaml
```

---

## Key takeaways

1. **`requests`** = guaranteed reservation + the basis for HPA's percentage; **`limits`** = ceiling.
2. CPU is **throttled** at the limit; memory is **OOMKilled**. Set limits with that in mind.
3. **QoS class** is derived from requests/limits, not declared directly. It decides eviction order under pressure.
4. **HPA scales Pod count** based on metrics — most commonly CPU utilization vs request. Use `autoscaling/v2`.
5. Without `metrics-server` running and **CPU requests set**, the HPA can't scale.
6. For event-driven scaling (queue depth etc.), reach for **KEDA**; for node-level scaling, **Cluster Autoscaler** or **Karpenter**.

**Back to** [course index](../README.md)
