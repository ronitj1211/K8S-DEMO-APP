# Kubernetes Services

## What is a Service?

A **Service** is a stable network endpoint for a set of Pods.

Pods are mortal: they're created, destroyed, and rescheduled with new IPs all the time. You can't hardcode a Pod IP. A **Service** gives you a fixed name and virtual IP that always routes to the **healthy** Pods behind it.

```
client ──> Service (stable IP + DNS name) ──load-balances──> Pod, Pod, Pod
```

The Service uses a **label selector** to decide which Pods belong to it. As Pods come and go, the Service's backend list updates automatically.

### Two jobs a Service does

1. **Service discovery** — gives Pods a DNS name (`backend.default.svc.cluster.local`) so they don't need to know each other's IPs.
2. **Load balancing** — spreads traffic across all matching, healthy Pods.

---

## Types of Services

| Type | Reachable from | Use for |
|------|----------------|---------|
| **ClusterIP** *(default)* | Inside the cluster only | Internal service-to-service traffic. |
| **NodePort** | Outside, via `<NodeIP>:<nodePort>` (30000–32767) | Quick external access during development. |
| **LoadBalancer** | Outside, via a cloud LB | Production external traffic on managed K8s (AWS/GCP/Azure). |
| **ExternalName** | Returns a CNAME to an external DNS name | Aliasing an external service (e.g. RDS) as a K8s name. |
| **Headless** *(`clusterIP: None`)* | DNS returns Pod IPs directly | StatefulSets, custom client-side load balancing. |

### How they nest

`LoadBalancer` is a `NodePort` is a `ClusterIP`. Each adds capability on top:

```
LoadBalancer  ⊃  NodePort  ⊃  ClusterIP
```

When you create a LoadBalancer Service, K8s also allocates a NodePort and a ClusterIP. They all still work.

---

## Key fields explained

```yaml
spec:
  type: ClusterIP
  selector:
    app: backend         # match Pods with this label
  ports:
    - port: 80           # the Service's port (what clients hit)
      targetPort: 3000   # the container's port (where traffic is sent)
      nodePort: 30080    # only for NodePort/LoadBalancer; static port on every node
```

- **`port`**: the port on the Service itself.
- **`targetPort`**: the port the Pod's container is listening on.
- **`nodePort`**: the port exposed on each cluster node (NodePort/LoadBalancer only).

---

## DNS inside the cluster

From any Pod, you can reach a Service by name:

```
<service-name>.<namespace>.svc.cluster.local
```

Short forms also work (same namespace):

```
<service-name>
<service-name>.<namespace>
```

So the frontend Pod calls the backend by simply doing `fetch('http://backend-clusterip')`. No IPs.

---

## What's in this folder

```
kubernetes-services/
├── backend/
│   ├── server.js, package.json, Dockerfile
│   ├── backend-deployment.yaml
│   ├── backend-clusterip-service.yaml      # internal only
│   ├── backend-nodeport-service.yaml       # external via node port
│   └── backend-loadbalancer-service.yaml   # cloud LB / minikube tunnel
└── frontend/
    ├── index.html, Dockerfile
    └── frontend-deployment.yaml            # Deployment + NodePort Service
```

---

## Prerequisites

Docker, a local cluster, `kubectl`.

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

### 2. Deploy the backend + all three Service types

```bash
kubectl apply -f backend/backend-deployment.yaml
kubectl apply -f backend/backend-clusterip-service.yaml
kubectl apply -f backend/backend-nodeport-service.yaml
kubectl apply -f backend/backend-loadbalancer-service.yaml
```

### 3. Deploy the frontend (Deployment + NodePort in one file)

```bash
kubectl apply -f frontend/frontend-deployment.yaml
```

### 4. Inspect

```bash
kubectl get services
kubectl get endpoints backend-clusterip      # shows the Pod IPs the Service selects
kubectl describe service backend-nodeport
```

### 5. Try each Service type

**ClusterIP** (only works from inside the cluster):

```bash
kubectl run debug --rm -it --image=curlimages/curl -- sh
# then inside:
curl http://backend-clusterip
```

**NodePort** (from your laptop):

```bash
minikube ip                             # get node IP, e.g. 192.168.49.2
curl http://<node-ip>:30080

# Or with minikube directly:
minikube service backend-nodeport --url
```

**LoadBalancer** (needs `minikube tunnel` running in another terminal):

```bash
minikube tunnel
kubectl get service backend-lb          # EXTERNAL-IP will become a real IP
curl http://<external-ip>
```

### 6. See load balancing

```bash
for i in $(seq 1 10); do curl -s http://<node-ip>:30080 | grep hostname; done
```

You should see the hostname rotating across the 3 backend Pods.

### 7. Open the frontend

```
http://<node-ip>:30081
```

In the input box, use `http://<node-ip>:30080` as the backend URL. Click **Call 20x** to see the Service distribute requests.

---

## Useful commands

```bash
kubectl get svc
kubectl get endpoints                       # which Pods are behind each Service
kubectl describe svc backend-clusterip
kubectl port-forward svc/backend-clusterip 8080:80
```

---

## Cleanup

```bash
kubectl delete -f backend/
kubectl delete -f frontend/
```

---

## Key takeaways

1. A **Service** is the stable address for a moving target — a set of Pods.
2. Pods are selected by **labels**, not by name.
3. **ClusterIP** is internal-only, **NodePort** opens a port on each node, **LoadBalancer** provisions a cloud LB.
4. Services load-balance across **healthy** Pods (readiness probe matters!).
5. In-cluster DNS lets Pods talk to each other by Service name — no IPs needed.

**Previous:** [kubernetes-deployment](../kubernetes-deployment/) · **Next:** [kubernetes-ingress](../kubernetes-ingress/)
