# Run Steps — GitOps with Argo CD on Colima (k3s)

Concrete commands to install Argo CD and run the demo on **Colima + k3s**. See [README.md](README.md) and [HOW_IT_CONNECTS.md](HOW_IT_CONNECTS.md) for the concepts.

> **Status of this session:** images built and CORS fix applied; the live install was **not** executed in the session that produced this file because installing Argo CD pulls an external manifest into a shared cluster — that needed your separate approval. The commands below are correct for Colima/k3s once you say go.

---

## 0. Pre-check

```bash
kubectl get ns | grep argocd      # should be empty before install
```

---

## 1. CORS fix on the backend

Already applied to [backend/server.js](backend/server.js):

```js
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});
```

---

## 2. Build the demo app images

```bash
cd K8S-demo-concept-wise-project/argocd/backend
docker build -t argocd-demo-backend:1.0 .

cd ../frontend
docker build -t argocd-demo-frontend:1.0 .
```

> No `kind load` / `minikube docker-env` needed — k3s on Colima sees the host docker daemon.

---

## 3. Install Argo CD

```bash
kubectl create namespace argocd
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
```

Wait for the core pods to come up (~60–90 s):

```bash
kubectl get pods -n argocd
# expect: argocd-server, argocd-repo-server, argocd-application-controller,
#         argocd-redis, argocd-dex-server, argocd-applicationset-controller,
#         argocd-notifications-controller all Running 1/1
```

(Optional) Install the CLI on macOS:

```bash
brew install argocd
argocd version --client
```

---

## 4. Access the Argo CD UI

```bash
kubectl port-forward svc/argocd-server -n argocd 8080:443
```

Open <https://localhost:8080> — accept the self-signed cert.

Initial admin password:

```bash
kubectl -n argocd get secret argocd-initial-admin-secret \
  -o jsonpath="{.data.password}" | base64 -d ; echo
```

Login: `admin` / `<password from above>`.

---

## 5. Register the demo Application

The `apps/*.yaml` files point at **this exact Git repo** (`https://github.com/ronitj1211/K8S-DEMO-APP.git`, branch `main`). Argo CD will clone it.

```bash
cd K8S-demo-concept-wise-project/argocd

# Option A: single Application
kubectl apply -f apps/demo-app.yaml

# Option B: app-of-apps (the root manages a folder of Applications)
kubectl apply -f apps/app-of-apps.yaml
```

In the UI you should see `demo-app` (and `root-app` if Option B) appear within a few seconds. Sync status will go `OutOfSync → Syncing → Synced` and Health `Missing → Progressing → Healthy`.

CLI alternative:

```bash
argocd login localhost:8080 --username admin --password '<from above>' --insecure
argocd app list
argocd app get demo-app
argocd app sync demo-app          # manual sync (the manifest enables auto-sync too)
```

---

## 6. Verify the demo

After Argo CD finishes syncing:

```bash
kubectl get all -n argocd-demo
# 2 backend pods, 1 frontend pod, 2 NodePort Services

curl -s http://localhost:30110/ | python3 -m json.tool
# { "message": "Hello from a GitOps-deployed backend", "version": "v1", ... }

open http://localhost:30111/    # frontend
```

---

## 7. GitOps round-trip: change → push → see it sync

The headline demo of GitOps. In a working branch:

```bash
# 1. Edit manifests/10-backend.yaml -- change APP_VERSION from "v1" to "v2"
# 2. Edit manifests/10-backend.yaml -- change replicas from 2 to 3
# 3. git commit, git push
```

Within ~3 min (the default refresh interval) Argo CD detects drift and reconciles:

```bash
argocd app get demo-app                       # sync status flips back to Synced
kubectl get pods -n argocd-demo               # 3 pods, new image hash
curl -s http://localhost:30110/ | python3 -m json.tool
# "version": "v2"
```

Or force an immediate refresh from the UI / `argocd app sync demo-app`.

---

## 8. Self-healing demo

Argo CD is configured with `selfHeal: true`. Manually mutate a managed resource:

```bash
kubectl scale -n argocd-demo deployment/backend --replicas=10
kubectl get pods -n argocd-demo -w
```

Within ~3 min Argo CD reverts you back to whatever Git says (2 by default). Git is the source of truth; in-cluster changes are drift to be corrected.

---

## 9. Cleanup

Delete the Applications first — `resources-finalizer.argocd.argoproj.io` ensures Argo CD also deletes the synced workloads (backend, frontend, namespace) when you remove the Application:

```bash
cd K8S-demo-concept-wise-project/argocd
kubectl delete -f apps/app-of-apps.yaml --ignore-not-found
kubectl delete -f apps/demo-app.yaml    --ignore-not-found

# Wait for argocd-demo namespace to fully terminate, then uninstall Argo CD itself
kubectl get ns argocd-demo
kubectl delete ns argocd
```

If you skip the finalizer step (delete `argocd` namespace first), the demo workloads are orphaned and you have to clean them up manually.

---

## Notes specific to this setup

- **Argo CD `svc/argocd-server` exposes HTTPS on 443 internally.** The port-forward maps that to localhost:8080 — open `https://`, not `http://`.
- **No webhook by default.** Argo CD polls Git every 3 minutes (`timeoutSeconds` setting). To make pushes appear instantly, configure a GitHub webhook → `https://localhost:8080/api/webhook` (needs a publicly reachable Argo CD or `ngrok`).
- **NodePorts:** demo backend 30110, demo frontend 30111. Reachable directly on `localhost`.
- **The `Application` manifests pin `repoURL: https://github.com/ronitj1211/K8S-DEMO-APP.git`** — fork the repo and edit the URL if you want to demo GitOps on your own branch.
- **`syncPolicy.automated: { prune: true, selfHeal: true }`** is enabled. That means: delete from Git → cluster delete; manual `kubectl scale` → Argo CD reverts. Disable both for a more conservative manual-approval style.
- **Argo CD itself is ~7 pods, ~500 MB RAM.** Not light but well under Colima default. ELK + Argo CD together is where Colima's defaults start to strain.
