# Kubernetes Deployment

## What is a Deployment?

A **Deployment** is a controller that manages a group of identical Pods for you. You declare:

- **What** Pod to run (the template)
- **How many** copies (replicas)
- **How** to update them (rollout strategy)

…and Kubernetes makes the cluster match. If a Pod dies, the Deployment creates a new one. If you change the image, the Deployment rolls Pods over to the new version without downtime.

### Why not just use Pods?

A naked Pod is **fragile**: if its node dies, it's gone. A Deployment gives you:

| Capability | What it does |
|------------|--------------|
| **Self-healing** | Replaces Pods that crash or get evicted. |
| **Replicas** | Runs N copies for load and availability. |
| **Rolling updates** | Replaces old Pods with new ones gradually. |
| **Rollback** | `kubectl rollout undo` flips back to the previous version. |
| **History** | Tracks revisions so you can see what changed. |

### How it works under the hood

```
Deployment  ──manages──>  ReplicaSet  ──manages──>  Pods
```

- The **Deployment** is the thing you write.
- It creates a **ReplicaSet** for each revision of your Pod template.
- The ReplicaSet ensures the right number of **Pods** exist.

You almost always interact with the Deployment, not the ReplicaSet directly.

---

## Types of workload controllers

A Deployment is one of several controllers. Each fits a different workload shape.

| Controller | Use for | Identity? | Order? |
|------------|---------|-----------|--------|
| **Deployment** | Stateless apps (web, API). | Interchangeable Pods. | No order. |
| **StatefulSet** | Stateful apps (DBs, queues). | Each Pod has a stable name + storage. | Ordered start/stop. |
| **DaemonSet** | One Pod per node (log agents, metrics). | One per node. | — |
| **Job** | Run-to-completion tasks. | Run once and exit. | — |
| **CronJob** | Scheduled jobs. | Run on a cron schedule. | — |

If your app is a typical web/API/microservice, use **Deployment**.

---

## Rolling-update strategies

```yaml
strategy:
  type: RollingUpdate          # default
  rollingUpdate:
    maxSurge: 1                # extra Pods allowed above replicas during rollout
    maxUnavailable: 0          # Pods allowed to be unavailable during rollout
```

- `RollingUpdate` (default) — gradually replace Pods. Zero-downtime if probes are set.
- `Recreate` — kill all old Pods, then create new ones. Brief downtime. Use when two versions can't run side-by-side (e.g. schema lock).

---

## What's in this folder

```
kubernetes-deployment/
├── backend/
│   ├── server.js
│   ├── package.json
│   ├── Dockerfile
│   └── backend-deployment.yaml      # 3 replicas, readiness + liveness probes
├── frontend/
│   ├── index.html                   # button to spam backend & show rotating hostnames
│   ├── Dockerfile
│   └── frontend-deployment.yaml     # 2 replicas
└── README.md
```

---

## Prerequisites

- Docker
- Local Kubernetes cluster (minikube / kind / Docker Desktop)
- `kubectl`

---

## How to run

### 1. Build images

```bash
eval $(minikube docker-env)   # minikube only

cd backend  && docker build -t k8s-demo-backend:1.0 .
cd ../frontend && docker build -t k8s-demo-frontend:1.0 .
```

For kind:

```bash
kind load docker-image k8s-demo-backend:1.0
kind load docker-image k8s-demo-frontend:1.0
```

### 2. Deploy

```bash
kubectl apply -f backend/backend-deployment.yaml
kubectl apply -f frontend/frontend-deployment.yaml
```

### 3. Watch the Deployment come up

```bash
kubectl get deployments
kubectl get rs                      # the ReplicaSet the Deployment created
kubectl get pods -l app=backend     # the 3 backend Pods
```

You'll see 3 backend Pods with names like `backend-deployment-<rs-hash>-<pod-hash>`.

### 4. Port-forward to test

A Deployment by itself doesn't expose a stable endpoint — that's a **Service**'s job (next folder). For now port-forward to one Pod:

```bash
kubectl port-forward deployment/backend-deployment 3000:3000
curl http://localhost:3000
```

`kubectl port-forward deployment/...` will pick **one** Pod from the Deployment.

### 5. See self-healing in action

```bash
# Delete a Pod manually
kubectl delete pod <one-backend-pod-name>

# Watch — the Deployment immediately creates a replacement
kubectl get pods -l app=backend -w
```

### 6. Do a rolling update

Edit the env in `backend/backend-deployment.yaml`:

```yaml
env:
  - name: APP_VERSION
    value: "v2"        # was "v1"
```

Apply and watch the rollout:

```bash
kubectl apply -f backend/backend-deployment.yaml
kubectl rollout status deployment/backend-deployment
```

You'll see Pods being replaced one by one (because `maxSurge: 1, maxUnavailable: 0`).

### 7. Rollback

```bash
kubectl rollout history deployment/backend-deployment
kubectl rollout undo deployment/backend-deployment
```

### 8. Scale

```bash
kubectl scale deployment/backend-deployment --replicas=5
kubectl get pods -l app=backend
```

---

## Useful commands

```bash
kubectl get deployments
kubectl describe deployment backend-deployment    # events, conditions
kubectl rollout status deployment/backend-deployment
kubectl rollout history deployment/backend-deployment
kubectl rollout undo deployment/backend-deployment --to-revision=1
kubectl scale deployment/backend-deployment --replicas=4
kubectl set image deployment/backend-deployment backend=k8s-demo-backend:2.0
```

---

## Cleanup

```bash
kubectl delete -f backend/backend-deployment.yaml
kubectl delete -f frontend/frontend-deployment.yaml
```

---

## Key takeaways

1. A **Deployment** is the standard way to run stateless workloads — it manages Pods for you.
2. It owns a **ReplicaSet**, which owns **Pods**. You operate on the Deployment.
3. Updates are **rolling** by default: zero-downtime when probes are set correctly.
4. **Readiness probe** decides when a Pod gets traffic; **liveness probe** decides when to restart it.
5. To reach Pods from outside the cluster reliably, you need a **Service** — that's next.

**Previous:** [kubernetes-pods](../kubernetes-pods/) · **Next:** [kubernetes-services](../kubernetes-services/)
