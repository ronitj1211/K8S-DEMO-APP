# Kubernetes Pods

## What is a Pod?

A **Pod** is the smallest deployable unit in Kubernetes. It is **one or more containers** that share:

- A **network namespace** (same IP and port space — they can talk over `localhost`)
- **Storage volumes** (shared mounts)
- A **lifecycle** (started and stopped together, scheduled to the same node)

You almost never deploy "a container" in Kubernetes — you deploy a Pod that wraps it. A Pod is a logical host for tightly-coupled containers.

### Mental model

Think of a Pod as a **lightweight VM**:
- The VM is the Pod.
- The processes running inside that VM are the containers.
- The VM has one IP; processes share localhost.

### Why Pods, not just containers?

So Kubernetes can co-schedule helper containers (sidecars, log shippers, proxies) with your app on the same node, sharing the same network and disk, without you wiring it up manually.

---

## Types of Pods

| Type | Description | When to use |
|------|-------------|-------------|
| **Single-container Pod** | One container per Pod. Most common. | Your normal app. |
| **Multi-container Pod** | Multiple containers in one Pod, sharing network + volumes. | Sidecar patterns: log shipper, proxy, adapter. |
| **Init container Pod** | Containers that run **before** main containers, in order, to completion. | Migrations, downloading config, waiting for a dependency. |
| **Static Pod** | Managed directly by the kubelet on a node (not via the API server). | Control-plane components like `kube-apiserver`. You rarely write these. |
| **Ephemeral / Naked Pod** | A Pod created directly via `kubectl run` or a `Pod` manifest, not via a Deployment. | Only for one-off debugging. Not for real workloads — see below. |

### Important: don't ship naked Pods to production

A standalone Pod will **not be restarted** if its node dies. For production you wrap Pods in a controller — usually a **Deployment** (see the `kubernetes-deployment` folder next). This folder uses raw Pods on purpose, so you can see the underlying primitive.

---

## What's in this folder

```
kubernetes-pods/
├── backend/
│   ├── server.js                 # Node.js Express returning a JSON hello
│   ├── package.json
│   ├── Dockerfile
│   ├── backend-pod.yaml          # Single-container Pod
│   └── multi-container-pod.yaml  # App + sidecar log shipper
├── frontend/
│   ├── index.html                # Plain HTML that calls the backend
│   ├── Dockerfile
│   └── frontend-pod.yaml         # Single-container Pod (nginx)
└── README.md
```

---

## Prerequisites

- Docker installed
- A local Kubernetes cluster: **minikube**, **kind**, or **Docker Desktop's Kubernetes**
- `kubectl` configured to talk to that cluster

Verify:

```bash
kubectl version --client
kubectl cluster-info
```

---

## How to run

### 1. Build the images

If using minikube, point your shell at minikube's Docker daemon so images are available inside the cluster:

```bash
eval $(minikube docker-env)   # minikube only — skip for kind / Docker Desktop
```

Build:

```bash
cd backend
docker build -t k8s-demo-backend:1.0 .

cd ../frontend
docker build -t k8s-demo-frontend:1.0 .
```

For **kind**, load images into the kind cluster instead:

```bash
kind load docker-image k8s-demo-backend:1.0
kind load docker-image k8s-demo-frontend:1.0
```

### 2. Apply the Pods

```bash
kubectl apply -f backend/backend-pod.yaml
kubectl apply -f frontend/frontend-pod.yaml
```

Check status:

```bash
kubectl get pods
kubectl describe pod backend-pod
```

You should see both pods in `Running` state.

### 3. Access the backend (port-forward)

A raw Pod has no Service, so you reach it with `port-forward`:

```bash
kubectl port-forward pod/backend-pod 3000:3000
```

In another terminal:

```bash
curl http://localhost:3000
```

You should see JSON with the Pod's hostname.

### 4. Access the frontend

```bash
kubectl port-forward pod/frontend-pod 8080:80
```

Open <http://localhost:8080> in your browser. Click **Call backend** — note: since the frontend talks to `http://localhost:3000`, keep the backend port-forward running too.

### 5. Try the multi-container Pod

```bash
kubectl apply -f backend/multi-container-pod.yaml
kubectl get pods
kubectl logs backend-with-sidecar -c backend
kubectl logs backend-with-sidecar -c log-sidecar
```

Notice you must pass `-c <container>` to pick which container's logs to view. Both containers share the same Pod IP.

---

## Useful commands to explore

```bash
kubectl get pods -o wide                       # show IP, node
kubectl describe pod backend-pod               # full state, events
kubectl logs backend-pod                       # logs (single-container)
kubectl logs backend-with-sidecar -c backend   # logs of a specific container
kubectl exec -it backend-pod -- sh             # shell into the Pod
kubectl delete pod backend-pod                 # delete a Pod (it does NOT come back — naked Pod)
```

Watch a Pod's lifecycle live:

```bash
kubectl get pods -w
```

---

## Cleanup

```bash
kubectl delete -f backend/backend-pod.yaml
kubectl delete -f backend/multi-container-pod.yaml
kubectl delete -f frontend/frontend-pod.yaml
```

---

## Key takeaways

1. A Pod is **one or more containers** that share network + storage + lifecycle.
2. Containers in a Pod talk to each other over `localhost`.
3. A naked Pod is **not self-healing** — when its node dies, it's gone. Always use a Deployment for real workloads.
4. `kubectl port-forward` is the simplest way to reach a Pod from your laptop while learning.

**Next:** [kubernetes-deployment](../kubernetes-deployment/) — wrap Pods in a controller that handles replicas, rollouts, and self-healing.
