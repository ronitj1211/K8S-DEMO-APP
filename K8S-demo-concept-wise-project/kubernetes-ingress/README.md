# Kubernetes Ingress

## What is an Ingress?

An **Ingress** is a set of HTTP/HTTPS routing rules that send external traffic to Services inside the cluster — typically based on **hostname** and **URL path**.

It's the "router" or "reverse proxy" of Kubernetes. One public entry point, many backends.

```
Internet ─► Ingress Controller ─► Ingress rules ─► Services ─► Pods
            (nginx, traefik,
             haproxy, etc.)
```

### Why not just use a Service of type LoadBalancer per app?

You could — but you'd pay for one cloud LB per service and you'd have no way to route by path or hostname. Ingress lets you:

- Front many Services with **one** public LB
- Route by **host**: `api.example.com` → backend, `app.example.com` → frontend
- Route by **path**: `/api` → backend, `/` → frontend
- Terminate **TLS** in one place
- Rewrite paths, set headers, enforce auth — depending on the controller

---

## Two things you need

Ingress has two parts:

1. **Ingress resource** — the YAML rules (this is what you write).
2. **Ingress controller** — the actual proxy that reads those rules and forwards traffic. **Kubernetes does not ship one by default.** You install one.

Without a controller, your Ingress YAML does nothing.

### Common Ingress controllers

| Controller | Notes |
|------------|-------|
| **NGINX Ingress** | Most common. The minikube addon uses this. |
| **Traefik** | Auto-discovery, nice dashboard, popular in dev. |
| **HAProxy** | High-performance, used at scale. |
| **AWS ALB / GCE / Azure** | Cloud-native controllers — Ingress becomes a managed cloud LB. |
| **Istio / Gateway API** | Modern alternative — uses the newer Gateway API spec. |

---

## Types / patterns of routing

### 1. Single-service Ingress
Send everything for a host to one Service.

### 2. Path-based fan-out
```
demo.local/        -> frontend
demo.local/api     -> backend
```
What this folder demonstrates.

### 3. Host-based fan-out
```
app.demo.local     -> frontend
api.demo.local     -> backend
```

### 4. TLS / HTTPS termination
The Ingress holds a TLS certificate (`Secret` of type `kubernetes.io/tls`) and serves HTTPS to clients, plain HTTP to Pods.

### 5. Default backend
Fallback Service for any request that matches no rule.

---

## Key fields explained

```yaml
spec:
  ingressClassName: nginx     # which controller should handle this Ingress
  rules:
    - host: demo.local        # match by Host header
      http:
        paths:
          - path: /api(/|$)(.*)
            pathType: ImplementationSpecific
            backend:
              service:
                name: backend
                port:
                  number: 80
```

**pathType** options:
- `Exact` — exact match.
- `Prefix` — `/foo` matches `/foo`, `/foo/`, `/foo/bar`.
- `ImplementationSpecific` — controller decides (needed for regex paths like above).

---

## What's in this folder

```
kubernetes-ingress/
├── backend/
│   ├── server.js, package.json, Dockerfile
│   └── backend.yaml         # Deployment + ClusterIP Service
├── frontend/
│   ├── index.html, Dockerfile
│   └── frontend.yaml        # Deployment + ClusterIP Service
├── ingress.yaml             # Path-based routing: / -> frontend, /api -> backend
└── README.md
```

Note that the backend and frontend Services are **ClusterIP** here — the Ingress is the only thing exposed externally.

---

## Prerequisites

- Docker, `kubectl`
- **An Ingress controller installed** in the cluster

### Install the NGINX Ingress controller

**minikube:**
```bash
minikube addons enable ingress
kubectl get pods -n ingress-nginx              # wait until Running
```

**kind:**
```bash
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml
kubectl wait --namespace ingress-nginx \
  --for=condition=ready pod \
  --selector=app.kubernetes.io/component=controller \
  --timeout=120s
```

**Docker Desktop:**
```bash
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/cloud/deploy.yaml
```

---

## How to run

### 1. Build images

```bash
eval $(minikube docker-env)   # minikube only

cd backend  && docker build -t k8s-demo-backend:1.0 .
cd ../frontend && docker build -t k8s-demo-frontend:1.0 .
```

(For kind: `kind load docker-image ...`)

### 2. Apply the manifests

```bash
kubectl apply -f backend/backend.yaml
kubectl apply -f frontend/frontend.yaml
kubectl apply -f ingress.yaml
```

### 3. Inspect

```bash
kubectl get ingress
kubectl describe ingress demo-ingress
kubectl get pods -n ingress-nginx              # the controller
```

`kubectl get ingress` will show the ADDRESS the controller is reachable at — usually the node IP for minikube/kind, or a LoadBalancer IP on a cloud cluster.

### 4. Point `demo.local` at the cluster

```bash
# Get the controller address:
INGRESS_IP=$(minikube ip)                      # minikube
# or for cloud / Docker Desktop:
# INGRESS_IP=$(kubectl get svc -n ingress-nginx ingress-nginx-controller -o jsonpath='{.status.loadBalancer.ingress[0].ip}')

echo "$INGRESS_IP demo.local" | sudo tee -a /etc/hosts
```

### 5. Open in the browser

- <http://demo.local/> → loads the frontend.
- Click the button — the frontend calls `/api/hello` on the **same origin**. The Ingress strips `/api` and forwards it to the backend Service.

Or with curl:

```bash
curl http://demo.local/
curl http://demo.local/api/hello
```

---

## Useful commands

```bash
kubectl get ingress
kubectl describe ingress demo-ingress
kubectl logs -n ingress-nginx -l app.kubernetes.io/component=controller -f
kubectl get pods -n ingress-nginx
```

---

## Cleanup

```bash
kubectl delete -f ingress.yaml
kubectl delete -f backend/backend.yaml
kubectl delete -f frontend/frontend.yaml
sudo sed -i.bak '/demo.local/d' /etc/hosts
```

---

## Key takeaways

1. An **Ingress** is HTTP routing rules; an **Ingress controller** is the proxy that enforces them.
2. You typically expose **one** Ingress per cluster (or one per environment) and route many apps through it.
3. Backend Services for Ingress are usually **ClusterIP** — the Ingress is the only public door.
4. Annotations on the Ingress unlock controller-specific features (rewrites, auth, rate-limit, TLS).
5. The newer **Gateway API** is gradually replacing Ingress for advanced use cases — same idea, more expressive.

**Previous:** [kubernetes-services](../kubernetes-services/) · **Next:** [configmap-secrets](../configmap-secrets/)
