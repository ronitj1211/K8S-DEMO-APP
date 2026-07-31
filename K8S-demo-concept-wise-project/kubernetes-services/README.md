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

## Service discovery in practice — a two-Service example

The clearest way to see what service discovery *does* is to look at two services talking to each other.

Say we have a mini e-commerce backend:

- **`orders`** — receives HTTP requests to create an order, then calls `payments` to charge the customer.
- **`payments`** — charges the card, replies with success/failure.

Both live in the `default` namespace. Each has its own Deployment (with multiple replica Pods for availability) and its own Service (giving it a stable name + virtual IP).

### The manifests

**Orders — Deployment + Service:**

```yaml
# orders-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: orders
spec:
  replicas: 3
  selector: { matchLabels: { app: orders } }
  template:
    metadata: { labels: { app: orders } }
    spec:
      containers:
        - name: orders
          image: my-org/orders:1.2.0
          env:
            # Note: no IP. Just the Service's DNS name.
            - name: PAYMENTS_URL
              value: http://payments/charge
---
# orders-service.yaml
apiVersion: v1
kind: Service
metadata: { name: orders }
spec:
  type: ClusterIP
  selector: { app: orders }             # match Pods with app=orders
  ports:
    - port: 80
      targetPort: 8080
```

**Payments — Deployment + Service:**

```yaml
# payments-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payments
spec:
  replicas: 2
  selector: { matchLabels: { app: payments } }
  template:
    metadata: { labels: { app: payments } }
    spec:
      containers:
        - name: payments
          image: my-org/payments:2.0.1
---
# payments-service.yaml
apiVersion: v1
kind: Service
metadata: { name: payments }
spec:
  type: ClusterIP
  selector: { app: payments }           # match Pods with app=payments
  ports:
    - port: 80
      targetPort: 9000
```

### How the app code looks

Inside an `orders` Pod, the application does:

```js
// From orders/server.js — pseudocode
const PAYMENTS_URL = process.env.PAYMENTS_URL;   // "http://payments/charge"

app.post('/orders', async (req, res) => {
  const orderId = crypto.randomUUID();
  const result = await fetch(PAYMENTS_URL, {     // ← the magic line
    method: 'POST',
    body: JSON.stringify({ orderId, amount: req.body.amount }),
  });
  res.json({ orderId, paymentStatus: result.status });
});
```

Notice what's **not** there:

- No IP address.
- No hardcoded Pod names.
- No lookup table.
- No service-registry client library.

Just `fetch('http://payments/charge')` — as if `payments` were a regular DNS name on the internet.

### What actually happens at request time

When an orders Pod's code calls `http://payments/charge`:

1. **DNS lookup**: the OS asks CoreDNS to resolve `payments`. Because the Pod's `/etc/resolv.conf` has `search default.svc.cluster.local svc.cluster.local cluster.local`, CoreDNS tries `payments.default.svc.cluster.local` first. Match — returns the Service's ClusterIP (say `10.43.55.12`).
2. **TCP connect**: the OS opens a connection to `10.43.55.12:80`.
3. **kube-proxy iptables DNAT**: on the node's kernel, the packet destined for `10.43.55.12:80` is rewritten to a real payments Pod IP + port (e.g. `10.42.0.42:9000`), chosen by iptables' random selection across the 2 payments Pods.
4. **Payments Pod handles the request**, replies.
5. **Reverse-NAT** on the return path makes the response appear to come from `10.43.55.12:80` — orders' code sees a normal HTTP response from `payments`.

The orders code never learned anything about payments' Pods. If payments' Pods restart, get replaced, scale to 10, or move to a different node — orders still just calls `http://payments/charge`. The Service is the stable rendezvous.

### The critical property — resilience to change

Now play out these three scenarios and think about what would break WITHOUT a Service:

| Scenario | Without a Service (hardcoded IPs) | With the Service |
|---|---|---|
| A payments Pod dies and gets replaced | Orders code calls a dead IP → 100% failures until config is manually updated | Service's Endpoints list drops the dead IP within seconds; new Pod's IP is added; orders traffic keeps flowing to healthy backends |
| Payments scales from 2 → 10 replicas | Orders code only knows the old 2 IPs; misses the 8 new Pods | Service's Endpoints list grows; all 10 Pods get their share of traffic |
| Payments moves to a different node | Pod IP changes; orders code is stuck on the old IP | Service selector still matches by label; endpoints update; orders keeps working |

That's what service discovery gives you: **decoupling code from location**.

### Cross-namespace calls

If `payments` lived in a different namespace (say `payments-team`), the orders code would use:

```
http://payments.payments-team.svc.cluster.local/charge

# Or the short form — often enough:
http://payments.payments-team/charge
```

The `<service>.<namespace>` shortcut is the pattern most apps use for cross-namespace calls. Same-namespace calls can just use `payments`.

### Quick check: is your Service discoverable?

```bash
# 1. Confirm the Service exists and picked up backing Pods
kubectl get svc payments
kubectl get endpoints payments

# 2. From an orders Pod, resolve the name
kubectl exec deployment/orders -- nslookup payments

# 3. Curl it
kubectl exec deployment/orders -- wget -qO- http://payments/charge -X POST
```

If step 2 returns an IP but step 3 fails, the Service is discoverable but the routing/backend has a problem (Pods not Ready, wrong port).
If step 2 fails, the Service doesn't exist or DNS is broken.

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
