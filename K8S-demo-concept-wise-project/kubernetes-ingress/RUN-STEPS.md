# Run Steps — Ingress on Colima (k3s)

Concrete commands to demo HTTP routing via Ingress on **Colima + k3s**. See [README.md](README.md) for the concepts.

> **Status of this session:** images built and ready. The ingress-nginx controller install was **deferred** — installing it pulls an external manifest into the shared cluster, which the safety classifier flagged. Once you approve the install command in step 2, the rest works as written.

> **Why ingress-nginx specifically:** the [ingress.yaml](ingress.yaml) pins `ingressClassName: nginx` and uses `nginx.ingress.kubernetes.io/rewrite-target`, which is an ingress-nginx-specific annotation. The default k3s install does **not** include an ingress controller (Traefik was disabled on this Colima cluster), so you have to install one.

---

## 0. Pre-check

```bash
kubectl get pods -n ingress-nginx       # should not exist yet
kubectl get ingressclass                # also empty
```

---

## 1. Build images

```bash
cd K8S-demo-concept-wise-project/kubernetes-ingress/backend
docker build -t k8s-demo-backend:1.0 .

cd ../frontend
docker build -t k8s-demo-frontend:1.0 .
```

Already done in this session.

---

## 2. Install ingress-nginx (baremetal variant — exposes NodePort)

```bash
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.11.2/deploy/static/provider/baremetal/deploy.yaml

# Wait for controller to be ready
kubectl wait --namespace ingress-nginx \
  --for=condition=ready pod \
  --selector=app.kubernetes.io/component=controller \
  --timeout=180s
```

Get the NodePort it picked:

```bash
kubectl get svc -n ingress-nginx ingress-nginx-controller
# TYPE=NodePort, PORT(S)=80:3xxxx/TCP,443:3xxxx/TCP
HTTP_PORT=$(kubectl get svc -n ingress-nginx ingress-nginx-controller -o jsonpath='{.spec.ports[?(@.name=="http")].nodePort}')
echo "Ingress HTTP on localhost:$HTTP_PORT"
```

> The **baremetal** variant uses NodePort (reachable on Colima's localhost). The **cloud** variant uses LoadBalancer — works on k3s (klipper-lb gives it an EXTERNAL-IP) but the IP isn't reachable from macOS, so baremetal is friendlier here.

---

## 3. Apply backend, frontend, and the Ingress

```bash
cd K8S-demo-concept-wise-project/kubernetes-ingress

kubectl apply -f backend/backend.yaml         # Deployment + ClusterIP Service (no NodePort!)
kubectl apply -f frontend/frontend.yaml       # Deployment + ClusterIP Service
kubectl apply -f ingress.yaml                 # routes / -> frontend, /api -> backend

kubectl rollout status deployment/backend
kubectl rollout status deployment/frontend
kubectl describe ingress demo-ingress         # Address: <pod-IP-of-controller>
```

Note the Services here are **ClusterIP**, not NodePort. Ingress fronts ClusterIP Services — that's the whole point.

---

## 4. Make `demo.local` resolve to your Mac

The Ingress is host-based (`host: demo.local`). Either add to `/etc/hosts`:

```bash
echo "127.0.0.1 demo.local" | sudo tee -a /etc/hosts
```

…or pass the Host header in curl:

```bash
curl -sH "Host: demo.local" http://localhost:$HTTP_PORT/api/hello | python3 -m json.tool
# { "from": "backend", "hostname": "backend-..." }

curl -sH "Host: demo.local" -o /dev/null -w "%{http_code}\n" http://localhost:$HTTP_PORT/
# 200 -- the frontend index.html
```

With `/etc/hosts` set, you can also use the browser: <http://demo.local:$HTTP_PORT> (replace `$HTTP_PORT` with the actual number).

---

## 5. Routing — what's happening under the hood

The single Ingress is doing two jobs:

```yaml
rules:
  - host: demo.local
    http:
      paths:
        - path: /api(/|$)(.*)         # capture everything after /api/
          backend: { service: { name: backend, port: { number: 80 } } }
          # rewrite-target /$2 strips /api before forwarding
        - path: /                     # everything else
          backend: { service: { name: frontend, port: { number: 80 } } }
```

So:
- `http://demo.local:$HTTP_PORT/` → frontend
- `http://demo.local:$HTTP_PORT/api/hello` → backend (sees `/hello` after rewrite)

The frontend's `index.html` calls `fetch('/api/hello')` — **same origin, no CORS**. That's the headline benefit over NodePort-per-service.

---

## 6. Cleanup

```bash
cd K8S-demo-concept-wise-project/kubernetes-ingress
kubectl delete -f ingress.yaml -f frontend/frontend.yaml -f backend/backend.yaml
```

If you also want to remove ingress-nginx (it's harmless to leave running):

```bash
kubectl delete -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.11.2/deploy/static/provider/baremetal/deploy.yaml
```

And remove the `demo.local` line from `/etc/hosts`.

---

## Notes specific to this setup

- **k3s on Colima does NOT ship Traefik here.** Some k3s installs include Traefik by default; this one was started without it (only coredns, local-path-provisioner, metrics-server in `kube-system`). You have to install an ingress controller before the Ingress resource has any effect.
- **`ingress-nginx` ≠ `nginx-ingress`.** Two different projects. The annotations in [ingress.yaml](ingress.yaml) (`nginx.ingress.kubernetes.io/...`) are for the Kubernetes community project `ingress-nginx`, which is what the install URL above pulls.
- **`pathType: ImplementationSpecific`** with the `rewrite-target` annotation is the canonical way to strip a path prefix on ingress-nginx. The regex captures (`$1` = `/` or empty, `$2` = the suffix), and `/$2` becomes the forwarded path.
- **Same-origin = no CORS.** The Ingress lets both frontend and backend appear under `demo.local:<port>`, so `fetch('/api/hello')` works without an `Access-Control-Allow-Origin` header. With NodePort-per-service (previous folders) you needed CORS; here you don't.
