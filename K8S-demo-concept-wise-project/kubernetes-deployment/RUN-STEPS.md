# Run Steps — Deployment on Colima (k3s)

This is the concrete sequence of commands used to bring up this folder's Deployments on the local cluster. The main [README.md](README.md) covers the concepts; this file logs **exactly what we ran** on a **Colima + k3s** setup.

> Cluster context: `colima` (Kubernetes provided by k3s, container runtime `docker`).
> On this setup, images built with `docker build` are visible to k3s — no `kind load` / `minikube docker-env` step is needed.

---

## 0. Pre-check / cleanup from previous folder

If you came from `kubernetes-pods`, tear it down first so resources don't collide:

```bash
kubectl get pods                                  # expect: no resources
pkill -f "kubectl port-forward"                   # stop any stale port-forwards
```

Verify the cluster:

```bash
kubectl config current-context        # expect: colima
kubectl get nodes                     # expect: 1 node Ready
```

---

## 1. CORS fix on the backend (one-time)

The Deployment frontend calls `http://localhost:3000` from a page served at `http://localhost:8080`. That's cross-origin, so the browser will block the response unless the backend returns `Access-Control-Allow-Origin`.

Add this middleware near the top of [backend/server.js](backend/server.js) before any route:

```js
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});
```

Without this you get **`Error: Failed to fetch`** in the browser even though the Pods are healthy.

---

## 2. Build the images

The manifests reference `k8s-demo-backend:1.0` and `k8s-demo-frontend:1.0`. Note this **shares the tag** with the `kubernetes-pods` folder — whichever was built last wins. Rebuild here so you're running this folder's source:

```bash
cd K8S-demo-concept-wise-project/kubernetes-deployment/backend
docker build -t k8s-demo-backend:1.0 .

cd ../frontend
docker build -t k8s-demo-frontend:1.0 .
```

---

## 3. Apply the Deployments

```bash
kubectl apply -f backend/backend-deployment.yaml
kubectl apply -f frontend/frontend-deployment.yaml

kubectl rollout status deployment/backend-deployment
kubectl rollout status deployment/frontend-deployment
```

Inspect what got created:

```bash
kubectl get deployments
kubectl get rs                         # one ReplicaSet per revision
kubectl get pods -o wide               # 3 backend + 2 frontend Pods
```

Pod names follow the pattern `<deployment>-<rs-hash>-<pod-hash>`.

---

## 4. Port-forward and test the app

In one terminal:

```bash
kubectl port-forward deployment/backend-deployment 3000:3000
```

In another:

```bash
kubectl port-forward deployment/frontend-deployment 8080:80
```

> `kubectl port-forward deployment/...` attaches to **one** Pod chosen from the Deployment. To see traffic balanced across all replicas you need a Service — that's the next folder.

Hit them:

```bash
curl http://localhost:3000/                    # JSON with hostname + version
curl -I http://localhost:3000/ | grep -i access-control   # confirms CORS header
```

Open <http://localhost:8080> in a browser and click **Call backend** — you should see the JSON response. The **Call 20x** button will hit the backend repeatedly; with port-forward all calls go to the same Pod (hence one hostname), but with a Service you'd see the hostname rotate across replicas.

---

## 5. Self-healing demo

Delete one backend Pod and watch the ReplicaSet replace it:

```bash
POD=$(kubectl get pods -l app=backend -o jsonpath='{.items[0].metadata.name}')
kubectl delete pod "$POD"
kubectl get pods -l app=backend -w           # Ctrl-C to stop
```

A new Pod with a different hash suffix appears within seconds — replica count stays at 3.

> ⚠️ Heads-up: `kubectl port-forward deployment/...` attaches to **one specific Pod** under the hood. If you delete that Pod (which the self-healing demo does), the port-forward exits with `lost connection to pod` and must be restarted. A Service (next folder) avoids this entirely.

---

## 6. Rolling update

Bump `APP_VERSION` in [backend/backend-deployment.yaml](backend/backend-deployment.yaml):

```yaml
env:
  - name: APP_VERSION
    value: "v2"        # was "v1"
```

Apply and watch:

```bash
kubectl apply -f backend/backend-deployment.yaml
kubectl rollout status deployment/backend-deployment
kubectl get rs                                 # old RS scales to 0, new RS to 3
```

With `maxSurge: 1, maxUnavailable: 0` (set in the manifest), Pods are added one at a time so traffic never dips below 3 ready Pods.

---

## 7. Rollback

```bash
kubectl rollout history deployment/backend-deployment
kubectl rollout undo deployment/backend-deployment
kubectl rollout status deployment/backend-deployment
```

`APP_VERSION` flips back to `v1`.

---

## 8. Scale

```bash
kubectl scale deployment/backend-deployment --replicas=5
kubectl get pods -l app=backend

kubectl scale deployment/backend-deployment --replicas=3   # back to normal
```

---

## 9. Cleanup

```bash
kubectl delete -f backend/backend-deployment.yaml
kubectl delete -f frontend/frontend-deployment.yaml

# Stop port-forwards (in whichever terminals they're running).
pkill -f "kubectl port-forward"
```

---

## Notes specific to this setup

- **CORS again.** Same root cause as in `kubernetes-pods` — frontend and backend are different origins via port-forward. The next folder (`kubernetes-services`) puts both behind cluster-internal DNS; `kubernetes-ingress` puts them behind a single hostname, after which CORS goes away.
- **Tag collision with the pods folder.** Both folders use `k8s-demo-backend:1.0` / `k8s-demo-frontend:1.0`. Whichever you built last is what k3s runs. Rebuild when switching folders.
- **`port-forward deployment/...` hits one Pod, not all of them.** Useful for sanity checks; not a substitute for a Service when demoing load distribution.
- **`imagePullPolicy: IfNotPresent`** in the manifests is what lets k3s use the locally-built image instead of trying to pull from a registry.
