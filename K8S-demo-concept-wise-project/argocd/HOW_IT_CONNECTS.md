# How Argo CD & the Demo App Connect

This document traces **every link** in the ArgoCD demo — which component talks to which, **what address** it uses, and **where in the YAML** that address lives. If you've ever wondered "how does Argo CD know which manifests to apply, and where?" — this is the answer.

---

## 1. The two mechanisms behind it all

### Mechanism A: Git as the source of truth

Argo CD clones a Git repo and reads manifests from a specific path. The mapping is:

```
Application CRD (spec.source.repoURL + spec.source.path)
        │
        ▼
Git repo → folder of YAML files
        │
        ▼
Argo CD renders them and applies to spec.destination.namespace
```

No Service DNS involved. This is pure Git → cluster.

### Mechanism B: Service DNS (for the demo app itself)

Inside the cluster, every `Service` gets a DNS name:

```
<service-name>.<namespace>.svc.cluster.local
```

The demo app's frontend calls the backend via `http://localhost:30110` from the **browser** (your laptop), not from inside the cluster — because the HTML runs in your browser, not in a Pod.

---

## 2. The big picture

```
  ┌─────────────────────────────────────────────────────────────────────────┐
  │  Your laptop                                                            │
  │                                                                         │
  │  Developer pushes code/YAML  ──────►  GitHub repo                       │
  │         to Git                        (ronitj1211/K8S-DEMO-APP)         │
  │                                                │                        │
  │  Browser:                                      │ polls every 3 min      │
  │  https://localhost:8080  ──► Argo CD UI        │ (or webhook)           │
  │  http://localhost:30110  ──► backend API       │                        │
  │  http://localhost:30111  ──► frontend UI       │                        │
  └────────────────────────────────────────────────┼────────────────────────┘
                                                   │
  ╔════════════════════════ Kubernetes cluster ═════╪════════════════════════╗
  ║                                                │                        ║
  ║   namespace: argocd                            │                        ║
  ║   ┌────────────────────────────────────────────┼──────────────────┐     ║
  ║   │  Argo CD                                   ▼                  │     ║
  ║   │  ┌───────────────────┐   ┌──────────────────────┐            │     ║
  ║   │  │ repo-server       │   │ application-controller│            │     ║
  ║   │  │ (clones Git repo, │   │ (compares rendered    │            │     ║
  ║   │  │  renders YAML)    │──►│  YAML vs live cluster,│            │     ║
  ║   │  └───────────────────┘   │  applies diffs)       │            │     ║
  ║   │                          └──────────┬─────────────┘            │     ║
  ║   │  ┌───────────────────┐              │                         │     ║
  ║   │  │ argocd-server     │              │ kubectl apply/delete    │     ║
  ║   │  │ (UI + API)        │              │                         │     ║
  ║   │  └───────────────────┘              │                         │     ║
  ║   └─────────────────────────────────────┼─────────────────────────┘     ║
  ║                                         │                               ║
  ║                                         ▼                               ║
  ║   namespace: argocd-demo                                                ║
  ║   ┌─────────────────────────────────────────────────────────────┐      ║
  ║   │                                                             │      ║
  ║   │  ┌─────────────────────┐      ┌─────────────────────┐      │      ║
  ║   │  │ backend Deployment  │      │ frontend Deployment │      │      ║
  ║   │  │  (2 replicas)       │      │  (1 replica)        │      │      ║
  ║   │  │  image: argocd-demo-│      │  image: argocd-demo-│      │      ║
  ║   │  │  backend:1.0        │      │  frontend:1.0       │      │      ║
  ║   │  └────────┬────────────┘      └────────┬────────────┘      │      ║
  ║   │           │                            │                    │      ║
  ║   │  ┌────────┴────────────┐      ┌────────┴────────────┐      │      ║
  ║   │  │ Service: backend    │      │ Service: frontend   │      │      ║
  ║   │  │ NodePort 30110      │      │ NodePort 30111      │      │      ║
  ║   │  └─────────────────────┘      └─────────────────────┘      │      ║
  ║   │                                                             │      ║
  ║   └─────────────────────────────────────────────────────────────┘      ║
  ║                                                                         ║
  ╚═════════════════════════════════════════════════════════════════════════╝
```

Now let's walk every arrow in that diagram.

---

## 3. Argo CD → Git repo (polling for changes)

**Who:** the `argocd-repo-server` Pod.

**Address:** `https://github.com/ronitj1211/K8S-DEMO-APP.git`

**Configured in:**

- `spec.source.repoURL` in the Application: [apps/demo-app.yaml:18](./apps/demo-app.yaml#L18)
- `spec.source.targetRevision: main` — the branch: [apps/demo-app.yaml:19](./apps/demo-app.yaml#L19)
- `spec.source.path` — the folder of manifests: [apps/demo-app.yaml:20](./apps/demo-app.yaml#L20)

The repo-server clones this repo (via HTTPS, since it's public — for private repos, you register credentials with `argocd repo add`), checks out the `main` branch, and reads YAML files from the path. It refreshes every **3 minutes** by default, or instantly if a webhook is configured.

For the App of Apps root, the path is the `apps/` folder instead: [apps/app-of-apps.yaml:18](./apps/app-of-apps.yaml#L18).

---

## 4. Argo CD → Kubernetes API (applying manifests)

**Who:** the `argocd-application-controller` Pod.

**Address:** `https://kubernetes.default.svc:443`

**Configured in:**

- `spec.destination.server` in the Application: [apps/demo-app.yaml:26](./apps/demo-app.yaml#L26)

The value `https://kubernetes.default.svc` means "the cluster Argo CD is running in" — the in-cluster API endpoint. Argo CD uses its ServiceAccount token (auto-mounted by Kubernetes) to authenticate.

The controller applies manifests to the namespace specified in `spec.destination.namespace`: [apps/demo-app.yaml:27](./apps/demo-app.yaml#L27) — `argocd-demo`.

For multi-cluster setups, you register external clusters with `argocd cluster add`, and `spec.destination.server` would be a different API server URL.

---

## 5. App of Apps → demo-app (discovery)

**Who:** the application-controller, acting on the `root-app` Application.

**How:** The root-app's `spec.source.path` points at the `apps/` folder: [apps/app-of-apps.yaml:18](./apps/app-of-apps.yaml#L18). The controller finds `demo-app.yaml` inside that folder, sees it's a valid `Application` CRD, and **creates it in the argocd namespace**.

The created `demo-app` Application then triggers its own reconcile loop — watching the `manifests/` path and syncing to `argocd-demo`.

```
root-app watches:  apps/
  └── finds:       apps/demo-app.yaml
  └── creates:     Application "demo-app" in namespace "argocd"
        └── watches: manifests/
        └── syncs to: namespace argocd-demo
```

This is not a network connection — it's the controller creating one CRD from another. The key config is `directory.recurse: true`: [apps/app-of-apps.yaml:20](./apps/app-of-apps.yaml#L20).

---

## 6. Browser → Argo CD UI (your laptop → cluster)

**Who:** your browser.

**Address:** `https://localhost:8080`

**How:** `kubectl port-forward svc/argocd-server -n argocd 8080:443` tunnels your laptop's port 8080 to the `argocd-server` Service's port 443 (HTTPS).

The `argocd-server` Pod serves both the web UI (React SPA) and the gRPC/REST API that the UI and CLI talk to.

If you're on minikube and prefer NodePort:

```bash
kubectl patch svc argocd-server -n argocd -p '{"spec": {"type": "NodePort"}}'
# then access via http://<minikube-ip>:<assigned-nodeport>
```

---

## 7. Browser → backend (your laptop → demo app)

**Who:** your browser, when you click "Call backend" in the frontend UI.

**Address:** `http://localhost:30110`

**Configured in:**

- The frontend's `fetch()` call: [frontend/index.html:28](./frontend/index.html#L28)
- The backend Service (NodePort 30110): [manifests/10-backend.yaml:26-28](./manifests/10-backend.yaml#L26-L28)
- The backend Deployment (container port 3000): [manifests/10-backend.yaml:17](./manifests/10-backend.yaml#L17)

The flow: browser → NodePort 30110 on the node → Service `backend` (port 80) → Pod container port 3000.

The frontend HTML runs **in your browser**, not inside the cluster. That's why the address is `localhost:30110` (your machine), not `backend.argocd-demo.svc.cluster.local` (cluster DNS).

---

## 8. Browser → frontend (your laptop → static HTML)

**Who:** your browser.

**Address:** `http://localhost:30111`

**Configured in:**

- The frontend Service (NodePort 30111): [manifests/20-frontend.yaml:18-20](./manifests/20-frontend.yaml#L18-L20)
- The frontend container (nginx on port 80): [manifests/20-frontend.yaml:13](./manifests/20-frontend.yaml#L13)

nginx serves the static `index.html`. No backend connection from inside the Pod — everything happens in the browser.

---

## 9. Backend app — what it serves

**Who:** the Express.js server in the backend Pod.

**Endpoints:**

- `GET /` — returns `{ message, version, hostname, time }`: [backend/server.js:11-17](./backend/server.js#L11-L17)
- `GET /health` — returns `"ok"` (used by the readiness probe): [backend/server.js:19](./backend/server.js#L19)

**The `version` field** comes from `process.env.APP_VERSION`, which is set in the Deployment manifest: [manifests/10-backend.yaml:20-21](./manifests/10-backend.yaml#L20-L21). This is the field you change in Git to demo a GitOps rollout.

The `hostname` field returns `os.hostname()`, which in Kubernetes is the **Pod name** — useful for seeing which replica responds.

---

## 10. The readiness probe — how K8s knows the Pod is ready

**Who:** the kubelet on the node.

**Address:** `GET http://<pod-ip>:3000/health`

**Configured in:**

- The Deployment's readiness probe: [manifests/10-backend.yaml:22-25](./manifests/10-backend.yaml#L22-L25)

This is not a Service DNS call — the kubelet talks directly to the Pod IP on port 3000. If the probe fails, the Pod is removed from the Service's endpoint list (it won't receive traffic).

---

## 11. Sync policy — what automates the reconciliation

The sync policy in `demo-app.yaml` controls how aggressively Argo CD converges:

| Setting | Where | Effect |
|---------|-------|--------|
| `automated` | [demo-app.yaml:30](./apps/demo-app.yaml#L30) | Sync without manual trigger |
| `prune: true` | [demo-app.yaml:31](./apps/demo-app.yaml#L31) | Delete resources removed from Git |
| `selfHeal: true` | [demo-app.yaml:32](./apps/demo-app.yaml#L32) | Revert manual cluster changes |
| `CreateNamespace=true` | [demo-app.yaml:35](./apps/demo-app.yaml#L35) | Create `argocd-demo` if missing |
| `ServerSideApply=true` | [demo-app.yaml:37](./apps/demo-app.yaml#L37) | Server-side apply for safety |
| `retry.limit: 5` | [demo-app.yaml:38-43](./apps/demo-app.yaml#L38-L43) | Retry failed syncs with backoff |

Without `automated`, you'd have to click "Sync" in the UI (or run `argocd app sync demo-app`) every time you push to Git.

Without `selfHeal`, someone could `kubectl scale` or `kubectl edit` a resource and Argo CD would show `OutOfSync` but **not revert it** until the next Git push.

---

## 12. The finalizer — what happens when you delete the Application

The finalizer on the Application: [apps/demo-app.yaml:8](./apps/demo-app.yaml#L8)

```yaml
finalizers:
  - resources-finalizer.argocd.argoproj.io
```

When you `kubectl delete application demo-app -n argocd`, Argo CD sees the finalizer and **deletes all the resources it created** (the backend Deployment, Service, frontend Deployment, Service, and namespace). Without the finalizer, deleting the Application would only remove the Application CRD — the workloads would keep running as orphans.

---

## 13. Cheat sheet — addresses used in this demo

| From | To | Address | Where it's set |
|------|----|---------|----------------|
| Argo CD repo-server | GitHub | `https://github.com/ronitj1211/K8S-DEMO-APP.git` | [`demo-app.yaml:18`](./apps/demo-app.yaml#L18) |
| Argo CD controller | Kubernetes API | `https://kubernetes.default.svc` | [`demo-app.yaml:26`](./apps/demo-app.yaml#L26) |
| Browser | Argo CD UI | `https://localhost:8080` | port-forward to `svc/argocd-server` |
| Browser | Backend API | `http://localhost:30110` | NodePort in [`10-backend.yaml:28`](./manifests/10-backend.yaml#L28) |
| Browser | Frontend UI | `http://localhost:30111` | NodePort in [`20-frontend.yaml:20`](./manifests/20-frontend.yaml#L20) |
| Frontend (browser JS) | Backend API | `http://localhost:30110` | [`frontend/index.html:28`](./frontend/index.html#L28) |
| Kubelet | Backend Pod | `http://<pod-ip>:3000/health` | readiness probe in [`10-backend.yaml:22-25`](./manifests/10-backend.yaml#L22-L25) |

---

## 14. Key takeaways

1. **Argo CD connects two worlds: Git and the cluster.** The `Application` CRD is the bridge — `spec.source` is where to read, `spec.destination` is where to write.
2. **The repo-server pulls from Git; the application-controller pushes to the cluster.** No CI pipeline needs cluster credentials.
3. **App of Apps** is just an Application whose source path contains other Application YAMLs. The controller recurses — one `kubectl apply` bootstraps everything.
4. **Self-heal + prune** make the cluster converge fully to Git. Without them, Argo CD reports drift but doesn't fix it.
5. The demo app's frontend runs in **your browser**, not in the cluster — so it uses `localhost:<NodePort>` to reach the backend, not cluster DNS.
6. The **finalizer** ensures `kubectl delete application` also cleans up the workloads. Without it, deleting the Application leaves orphaned resources.

**Back to** [argocd README](./README.md) · [course index](../README.md)
