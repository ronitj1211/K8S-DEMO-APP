# Run Steps — Helm on Colima (k3s)

Concrete commands to install this chart on **Colima + k3s**. See [README.md](README.md) for the concepts.

> **Status of this session:** images built and CORS fix applied; the live `helm install` / `helm upgrade` steps were **not** executed in the session that produced this file because Helm CLI installation needed your separate approval. The commands below are the ones to run once `helm` is on your `PATH`.

---

## 0. Pre-check

```bash
helm version                   # needs Helm v3.x
```

If `command not found`, install:

```bash
brew install helm              # macOS
```

---

## 1. CORS fix on the backend (one-time)

Same browser-CORS gotcha as the previous folders. Already applied to [backend/server.js](backend/server.js):

```js
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});
```

---

## 2. Build images

```bash
cd K8S-demo-concept-wise-project/helm/backend
docker build -t k8s-demo-backend:1.0 .

cd ../frontend
docker build -t k8s-demo-frontend:1.0 .
```

Already done in this session — images are present in the docker daemon and visible to k3s.

---

## 3. Lint and preview the chart

```bash
cd K8S-demo-concept-wise-project/helm

helm lint ./chart
helm template demo ./chart                       # render with default values
helm template demo ./chart -f chart/values-prod.yaml   # render with prod overrides
```

`helm template` renders YAML to stdout without touching the cluster — useful for inspecting what `helm install` *would* do.

---

## 4. Install the dev release

```bash
helm install demo ./chart
```

What Helm prints (from `templates/NOTES.txt`):

```
Backend Service:  demo-backend  (NodePort 30086)
Frontend Service: demo-frontend (NodePort 30087)
```

> NOTES.txt mentions `minikube ip` — on Colima ignore that, the NodePorts are reachable directly on `localhost`.

Inspect:

```bash
helm list
helm status demo
kubectl get all -l app.kubernetes.io/instance=demo
```

Hit it:

```bash
curl http://localhost:30086/                     # backend (GREETING="hello from dev")
curl -o /dev/null -w "%{http_code}\n" http://localhost:30087/    # frontend
```

---

## 5. Install a SECOND release with prod values

```bash
helm install demo-prod ./chart -f chart/values-prod.yaml
```

Two releases, same chart, side-by-side:

```bash
helm list
curl http://localhost:30086/                     # demo (dev)    GREETING="hello from dev"
curl http://localhost:30186/                     # demo-prod      GREETING="hello from PROD"
kubectl get pods -l app.kubernetes.io/instance=demo-prod   # 4 backend, 2 frontend
```

---

## 6. Upgrade with an inline override

```bash
helm upgrade demo ./chart --set backend.replicas=5
kubectl get pods -l app.kubernetes.io/instance=demo,app.kubernetes.io/name=backend     # 5 Pods
```

`helm history demo` now shows two revisions.

---

## 7. Rollback

```bash
helm history demo
helm rollback demo 1                             # back to original 2 replicas
kubectl get pods -l app.kubernetes.io/instance=demo,app.kubernetes.io/name=backend
```

---

## 8. Uninstall

```bash
helm uninstall demo
helm uninstall demo-prod
```

This deletes every resource Helm created for those releases (Deployments, Services, etc.). Manifests applied outside Helm are untouched.

---

## Notes specific to this setup

- **No `eval $(minikube docker-env)` / `kind load`.** Colima's k3s reuses the host docker daemon — `docker build` is enough.
- **NodePorts:** `demo` uses 30086/30087, `demo-prod` uses 30186/30187 (so both releases coexist). Both are within Colima's exposed range so `localhost:<nodePort>` works.
- **CORS fix is in `backend/server.js`** — required because the frontend (port 30087) calls the backend (port 30086) cross-origin. With Ingress (next folder) both share a hostname and CORS goes away.
- **`helm template` is your friend** — render before installing, especially when modifying templates.
