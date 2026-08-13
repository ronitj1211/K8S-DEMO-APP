# Kubernetes Ingress — Hands-On Practice

A step-by-step practice log for deploying a frontend + backend app behind an NGINX Ingress controller, updating it, and cleaning up.

---

## 1. Create a Namespace

```bash
kubectl create namespace ingress-practice
```

Verify:
```bash
kubectl get namespace ingress-practice
```

(Optional) Set it as your default context namespace so you don't need `-n` every time:
```bash
kubectl config set-context --current --namespace=ingress-practice
```

---

## 2. Build the App Images

**Backend:**
```bash
cd kubernetes-ingress/backend
docker build -t k8s-demo-backend:1.0 .
```

**Frontend:**
```bash
cd ../frontend
docker build -t k8s-demo-frontend:1.0 .
```

> These are local images — no registry push. Fine for local practice (Docker Desktop / Rancher Desktop share the local Docker daemon with the cluster). If using minikube, build inside its Docker env first: `eval $(minikube docker-env)`.

---

## 3. Install the NGINX Ingress Controller

```bash
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.11.2/deploy/static/provider/baremetal/deploy.yaml
```

Wait for the controller pod to be ready:
```bash
kubectl wait --namespace ingress-nginx \
  --for=condition=ready pod \
  --selector=app.kubernetes.io/component=controller \
  --timeout=180s
```

Get the exposed NodePort:
```bash
kubectl get svc -n ingress-nginx ingress-nginx-controller

HTTP_PORT=$(kubectl get svc -n ingress-nginx ingress-nginx-controller \
  -o jsonpath='{.spec.ports[?(@.name=="http")].nodePort}')
echo "Ingress HTTP on localhost:$HTTP_PORT"
```

---

## 4. Deploy the App into the Namespace

**Important:** always pass `-n ingress-practice` — otherwise resources silently land in `default`, and the Ingress won't find Services in a different namespace.

```bash
kubectl apply -f backend/backend.yaml -n ingress-practice
kubectl apply -f frontend/frontend.yaml -n ingress-practice
```

---

## 5. Apply the Ingress

`ingress.yaml`:
```yaml
# Single Ingress that routes:
#   demo.local/        -> frontend Service
#   demo.local/api     -> backend  Service (path rewritten to /)
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: demo-ingress
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /$2
spec:
  ingressClassName: nginx
  rules:
    - host: demo.local
      http:
        paths:
          - path: /api(/|$)(.*)
            pathType: ImplementationSpecific
            backend:
              service:
                name: backend
                port:
                  number: 80
          - path: /
            pathType: Prefix
            backend:
              service:
                name: frontend
                port:
                  number: 80
```

```bash
kubectl apply -f ingress.yaml -n ingress-practice
```

Verify:
```bash
kubectl get ingress -n ingress-practice
kubectl describe ingress demo-ingress -n ingress-practice
```
Check that the "Rules" section shows valid endpoints (not `<none>`) for `backend` and `frontend`.

---

## 6. Access the App

**Map `demo.local` to your cluster's node IP** — add to `/etc/hosts`:
```
127.0.0.1   demo.local
```
(Docker Desktop / Rancher Desktop → `127.0.0.1`. minikube → `minikube ip`.)

**Hit it via the NodePort:**
```bash
curl http://demo.local:$HTTP_PORT/
curl http://demo.local:$HTTP_PORT/api
```
Or open in a browser:
```
http://demo.local:<HTTP_PORT>/
http://demo.local:<HTTP_PORT>/api
```

---

## 7. Roll Out a Frontend Change

### Local/dev approach
1. Edit `index.html`.
2. Rebuild with a **new tag** (never reuse the old tag):
   ```bash
   cd frontend
   docker build -t k8s-demo-frontend:1.1 .
   ```
3. Update the image tag in `frontend.yaml` to `k8s-demo-frontend:1.1`.
4. Re-apply:
   ```bash
   kubectl apply -f frontend.yaml -n ingress-practice
   ```
5. Watch the rollout:
   ```bash
   kubectl rollout status deployment/frontend -n ingress-practice
   kubectl get pods -n ingress-practice -l app=frontend
   ```
6. Hard-refresh the browser at `http://demo.local:<HTTP_PORT>/`.

### Alternative: same tag, force restart
```bash
docker build -t k8s-demo-frontend:1.0 .
kubectl rollout restart deployment/frontend -n ingress-practice
```

### Production practice (how this differs)
- **CI/CD builds & pushes** the image to a registry (ECR/GCR/Docker Hub/GHCR) — no local `docker build` on someone's laptop.
- **Immutable, unique tags** — git SHA or semver+build number, never `:latest`. Pin by digest (`image@sha256:...`) for full immutability.
- **GitOps** (ArgoCD/FluxCD) or Helm/Kustomize templating updates the manifest — no hand-edited YAML with `vi`.
- Use the atomic update command instead of re-applying a whole file:
  ```bash
  kubectl set image deployment/frontend frontend=myregistry.io/org/frontend:1.1 -n ingress-practice
  ```
- Define an explicit rolling strategy:
  ```yaml
  spec:
    strategy:
      type: RollingUpdate
      rollingUpdate:
        maxUnavailable: 0
        maxSurge: 1
  ```
- Add readiness/liveness probes so traffic isn't routed to a pod before it's ready:
  ```yaml
  readinessProbe:
    httpGet:
      path: /
      port: 80
    initialDelaySeconds: 3
    periodSeconds: 5
  ```
- Roll back fast if something breaks:
  ```bash
  kubectl rollout undo deployment/frontend -n ingress-practice
  ```

---

## 8. Clean Up

### Delete everything inside the namespace, keep the namespace
```bash
kubectl delete all --all -n ingress-practice
kubectl delete ingress --all -n ingress-practice
kubectl delete configmap --all -n ingress-practice
kubectl delete secret --all -n ingress-practice
kubectl delete pvc --all -n ingress-practice
```

### Or delete the whole namespace (simplest)
```bash
kubectl delete namespace ingress-practice
```
Recreate later with:
```bash
kubectl create namespace ingress-practice
```

### Verify cleanup
```bash
kubectl get all -n ingress-practice
kubectl get namespace ingress-practice
```

---

## Key Gotchas Hit During This Practice

- Forgetting `-n <namespace>` on `kubectl apply` puts resources in `default` — Ingress can't reference Services in a different namespace than itself.
- Local images with a reused tag (`:1.0`) won't trigger a rollout — Kubernetes doesn't know the content changed. Bump the tag or `rollout restart`.
- `kubectl delete all --all` doesn't cover Ingress, ConfigMaps, Secrets, or PVCs — delete those explicitly.
