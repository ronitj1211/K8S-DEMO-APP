# DaemonSets

## What is a DaemonSet?

A **DaemonSet** is a controller that ensures **one Pod runs on every node** (or every node matching a selector). When a new node joins the cluster, the DaemonSet automatically adds a Pod there. When a node leaves, the Pod is garbage-collected.

You don't choose how many replicas — Kubernetes does, based on how many nodes there are.

```
Deployment  → "run N Pods, anywhere"
DaemonSet   → "run 1 Pod on every node"
```

### When do you need a DaemonSet?

When the workload is per-node, not per-traffic. Typical examples:

- **Log collectors** — Fluent Bit, Filebeat, Vector. Read `/var/log` from each node and ship it.
- **Metrics agents** — node_exporter, Datadog agent, New Relic infra agent.
- **Storage / network plugins** — CSI drivers, CNI agents (Calico, Cilium), kube-proxy.
- **Security agents** — Falco, Wiz, runtime scanners.

These all need to be **on the node** to see what's happening on that node.

---

## How DaemonSet differs from Deployment

| Feature | Deployment | DaemonSet |
|---------|------------|-----------|
| Replicas | You set the count | One per node (automatic) |
| Scheduling | Anywhere it fits | Every matching node |
| New node joins | Nothing happens | A new Pod is added |
| Use case | Stateless apps | Per-node agents |
| Update strategy | RollingUpdate / Recreate | RollingUpdate / OnDelete |

DaemonSets also commonly use:

- **`hostPath` volumes** — to read node-local files like `/var/log` or `/proc`.
- **`hostNetwork: true`** — to share the node's network (e.g. kube-proxy).
- **`hostPort`** — to expose a port on the node's IP.
- **Tolerations** — to also schedule on tainted nodes (control plane, GPU nodes).

---

## Update strategies

```yaml
spec:
  updateStrategy:
    type: RollingUpdate          # default
    rollingUpdate:
      maxUnavailable: 1          # how many nodes can be without the agent during update
```

- `RollingUpdate` — replace Pods node by node. Default.
- `OnDelete` — only replace when you delete the old Pod manually. Used when an upgrade is risky.

---

## What's in this folder

We pretend the backend is a **node agent**: it reads `/var/log` from the node and serves a sample to whoever calls it. The frontend lets you call it repeatedly so you can see `nodeName` rotate across the cluster's nodes.

```
daemonsets/
├── backend/
│   ├── server.js                       # node agent
│   ├── package.json, Dockerfile
│   ├── node-agent-daemonset.yaml       # the DaemonSet itself
│   └── node-agent-service.yaml         # NodePort Service in front of it
└── frontend/
    ├── index.html, Dockerfile
    └── frontend.yaml                   # Deployment + NodePort Service
```

> Note: on a single-node cluster (minikube / kind default), the DaemonSet creates exactly one Pod, so you won't see `nodeName` rotate. Create a multi-node cluster to see the effect (see commands below).

---

## Prerequisites

- Docker, `kubectl`, local cluster.
- To see the "per node" behavior, a **multi-node** cluster helps:

```bash
# kind: create a 3-node cluster
cat <<EOF | kind create cluster --name daemon-demo --config=-
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
- role: control-plane
- role: worker
- role: worker
EOF

# minikube: start with 3 nodes
minikube start --nodes=3 -p daemon-demo
```

---

## How to run

### 1. Build images

```bash
# point shell at the cluster's Docker if using minikube:
eval $(minikube docker-env -p daemon-demo)

cd backend  && docker build -t k8s-demo-node-agent:1.0 .
cd ../frontend && docker build -t k8s-demo-frontend:1.0 .
```

For kind multi-node:

```bash
kind load docker-image k8s-demo-node-agent:1.0 --name daemon-demo
kind load docker-image k8s-demo-frontend:1.0   --name daemon-demo
```

### 2. Apply

```bash
kubectl apply -f backend/node-agent-daemonset.yaml
kubectl apply -f backend/node-agent-service.yaml
kubectl apply -f frontend/frontend.yaml
```

### 3. Check the per-node Pods

```bash
kubectl get nodes
kubectl get pods -l app=node-agent -o wide
```

You should see **one node-agent Pod per worker node**, each scheduled on a different node.

```
NAME                READY   STATUS    NODE
node-agent-abcde    1/1     Running   daemon-demo-worker
node-agent-fghij    1/1     Running   daemon-demo-worker2
```

### 4. Hit the agents

```bash
NODE_IP=$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}')

curl http://$NODE_IP:30084
# Repeat — the Service load-balances across nodes:
for i in $(seq 1 10); do curl -s http://$NODE_IP:30084 | grep nodeName; done
```

### 5. Open the frontend

```
http://<node-ip>:30085
```

Set the input to `http://<node-ip>:30084` and click **Call 20x** — `nodeName` should rotate across your nodes.

### 6. Watch auto-scaling with the cluster

Add a node and watch a new Pod appear:

```bash
# kind
kind get clusters
# (kind doesn't add nodes to a running cluster easily; recreate to test)

# minikube
minikube node add -p daemon-demo
kubectl get pods -l app=node-agent -o wide -w
```

---

## Useful commands

```bash
kubectl get daemonset
kubectl describe ds node-agent
kubectl get pods -l app=node-agent -o wide       # see which node each Pod is on
kubectl rollout status ds/node-agent
kubectl rollout history ds/node-agent
kubectl rollout undo    ds/node-agent
```

---

## Cleanup

```bash
kubectl delete -f frontend/frontend.yaml
kubectl delete -f backend/node-agent-service.yaml
kubectl delete -f backend/node-agent-daemonset.yaml

# If you created a dedicated cluster:
# minikube delete -p daemon-demo
# kind delete cluster --name daemon-demo
```

---

## Key takeaways

1. A **DaemonSet** runs **one Pod per node** — count is derived from cluster size.
2. Use it for **per-node agents**: log shippers, metrics agents, CNI/CSI plugins.
3. Combined with `hostPath`, `hostNetwork`, or `hostPort`, it gives Pods deep access to the node.
4. Add tolerations to also run on tainted nodes (control-plane, GPU, etc).
5. New nodes get the Pod automatically — that's the whole point.

**Previous:** [configmap-secrets](../configmap-secrets/) · **Next:** [helm](../helm/)
