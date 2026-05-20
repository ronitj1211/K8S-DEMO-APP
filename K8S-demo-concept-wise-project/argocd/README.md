# GitOps with Argo CD

## What problem does this solve?

Without GitOps, deploying to Kubernetes usually means someone runs `kubectl apply` from their laptop, a CI script SSHes into a bastion to run it, or a pipeline pushes directly to the cluster. These approaches share the same problems:

- **No single source of truth.** "What's running in prod?" is answered by `kubectl get`, not by looking at a repo.
- **No audit trail.** Who changed what, when? You have to correlate CI logs with cluster events.
- **Drift.** Someone hotfixes a Deployment in the cluster; nobody commits it; the next `kubectl apply` from Git overwrites the fix — or worse, the fix lives in the cluster forever, invisible to the team.
- **No self-healing.** If a resource gets accidentally deleted, nothing brings it back until someone notices.

**GitOps** flips the model: a controller **inside** the cluster watches a Git repo and continuously reconciles the cluster to match it. Git becomes the source of truth. Push to Git → cluster updates. Manually change the cluster → the controller reverts it.

That controller is **Argo CD**.

---

## What is Argo CD?

Argo CD is a declarative, GitOps continuous delivery tool for Kubernetes. It:

1. **Watches** one or more Git repos (or Helm repos, or OCI registries).
2. **Compares** the desired state (Git) with the live state (cluster).
3. **Syncs** automatically or on demand — creating, updating, or deleting resources to match Git.
4. **Reports** sync status, health, and diff through a web UI, CLI, and API.

```
  Developer pushes to Git
         │
         ▼
  ┌──────────────┐      polls / webhook      ┌──────────────────┐
  │   Git Repo   │ ◄──────────────────────── │    Argo CD        │
  │  (manifests) │                            │  (in-cluster      │
  └──────────────┘                            │   controller)     │
                                              └────────┬─────────┘
                                                       │ kubectl apply
                                                       ▼
                                              ┌──────────────────┐
                                              │  Kubernetes       │
                                              │  Cluster          │
                                              └──────────────────┘
```

### Argo CD vs. plain CI/CD

| | Traditional CI/CD push | Argo CD (GitOps pull) |
|---|---|---|
| **Direction** | Pipeline pushes to cluster | Controller inside cluster pulls from Git |
| **Cluster credentials** | CI needs kubeconfig / token | Only Argo CD (in-cluster) needs access |
| **Drift detection** | None — cluster can diverge silently | Continuous — Argo CD flags OutOfSync |
| **Self-healing** | Manual intervention | `selfHeal: true` reverts manual changes |
| **Rollback** | Re-run pipeline / revert + redeploy | `git revert` + push, or one click in UI |

---

## Key concepts

| Term | Meaning |
|------|---------|
| **Application** | The core Argo CD CRD. Points at a Git path + a target namespace. One Application = one set of manifests to sync. |
| **AppProject** | A grouping / RBAC boundary for Applications. `default` project allows everything; create custom ones for multi-tenant clusters. |
| **Sync** | Making the cluster match Git. Can be automatic or manual. |
| **Sync Status** | `Synced` (cluster matches Git) or `OutOfSync` (they differ). |
| **Health Status** | `Healthy`, `Progressing`, `Degraded`, `Missing` — reflects the runtime state of the managed resources. |
| **Prune** | Deleting cluster resources that no longer exist in Git. Disabled by default for safety. |
| **Self-Heal** | Reverting manual cluster changes back to the Git-defined state. |
| **App of Apps** | A pattern where one Application manages a folder of other Application manifests. Apply one root → Argo CD discovers the rest. |
| **Refresh** | Re-reading Git to check for changes (default: every 3 minutes, or on webhook). |

---

## Data flow

```
   ┌─────────────┐
   │  Developer   │
   │  pushes to   │
   │  Git repo    │
   └──────┬──────┘
          │
          ▼
   ┌─────────────────────────────────────────────────────────────────────┐
   │  Git Repo (github.com/ronitj1211/K8S-DEMO-APP.git)                │
   │                                                                     │
   │  K8S-demo-concept-wise-project/argocd/                             │
   │  ├── apps/                                                          │
   │  │   ├── app-of-apps.yaml   ← root Application                     │
   │  │   └── demo-app.yaml      ← Application for the demo workloads   │
   │  └── manifests/                                                     │
   │      ├── 00-namespace.yaml                                          │
   │      ├── 10-backend.yaml    ← Deployment + Service                  │
   │      └── 20-frontend.yaml   ← Deployment + Service                  │
   └────────────────────────┬────────────────────────────────────────────┘
                            │
                polls every 3 min (or webhook)
                            │
                            ▼
   ╔═══════════════════ Kubernetes cluster ════════════════════════════╗
   ║                                                                   ║
   ║   namespace: argocd                                               ║
   ║   ┌──────────────────────────────────────────────────────────┐    ║
   ║   │  Argo CD                                                  │    ║
   ║   │  ┌──────────────────┐  ┌───────────────┐  ┌───────────┐ │    ║
   ║   │  │ Application      │  │ Repo Server   │  │ API Server│ │    ║
   ║   │  │ Controller       │  │ (clones Git,  │  │ (UI + CLI │ │    ║
   ║   │  │ (reconcile loop) │  │  renders)     │  │  backend) │ │    ║
   ║   │  └────────┬─────────┘  └───────────────┘  └───────────┘ │    ║
   ║   └───────────┼──────────────────────────────────────────────┘    ║
   ║               │ kubectl apply / delete                            ║
   ║               ▼                                                   ║
   ║   namespace: argocd-demo                                          ║
   ║   ┌──────────────────────────────────────────────────────┐       ║
   ║   │  backend Deployment (2 replicas)                      │       ║
   ║   │  backend Service (NodePort 30110)                     │       ║
   ║   │  frontend Deployment (1 replica)                      │       ║
   ║   │  frontend Service (NodePort 30111)                    │       ║
   ║   └──────────────────────────────────────────────────────┘       ║
   ║                                                                   ║
   ╚═══════════════════════════════════════════════════════════════════╝
```

### The reconciliation loop, step by step

1. **Refresh** — the repo-server clones the Git repo (or pulls the latest) and renders the manifests at the configured path.
2. **Compare** — the application-controller diffs the rendered manifests against the live cluster state.
3. **Sync** (if automated) — if there's a difference, the controller applies (creates / patches / deletes) resources to make the cluster match Git.
4. **Health check** — after sync, the controller watches the resources until they reach a healthy state (Pods Running, Deployments complete, etc.).
5. **Self-heal** (if enabled) — if someone manually edits a resource in the cluster, the controller detects the drift on the next refresh and reverts it back to the Git state.

---

## What's in this folder

```
argocd/
├── apps/                              # Argo CD Application manifests
│   ├── app-of-apps.yaml               # root Application — manages the apps/ folder
│   └── demo-app.yaml                  # Application for the demo workloads in manifests/
├── backend/                           # sample Express.js backend
│   ├── server.js                      # GET / (returns version, hostname, time), GET /health
│   ├── package.json
│   └── Dockerfile
├── frontend/                          # nginx frontend that calls the backend
│   ├── index.html                     # button to call backend, shows response
│   └── Dockerfile
├── manifests/                         # plain K8s manifests that Argo CD syncs
│   ├── 00-namespace.yaml              # argocd-demo namespace
│   ├── 10-backend.yaml                # backend Deployment (2 replicas) + NodePort Service
│   └── 20-frontend.yaml               # frontend Deployment (1 replica) + NodePort Service
├── README.md                          # ← you are here
└── HOW_IT_CONNECTS.md                 # traces every connection in the setup
```

The backend returns a `version` field read from the `APP_VERSION` env var — change it in Git, push, and Argo CD rolls out the new version. That's the core demo loop.

> This setup is for **learning on a laptop**. For production, use Argo CD's Helm chart or the Autopilot installer, with SSO, RBAC, and a real Git webhook instead of polling.

---

## Prerequisites

- Docker, `kubectl`, local cluster (minikube / kind / Docker Desktop).
- **Argo CD CLI** (optional but recommended):

```bash
# macOS
brew install argocd

# verify
argocd version --client
```

---

## How to run

### 1. Install Argo CD into the cluster

```bash
kubectl create namespace argocd
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
```

Wait for it to be ready:

```bash
kubectl get pods -n argocd -w
```

All Pods should be `Running` and `1/1` (takes ~60–90s). The key components:

| Pod | Role |
|-----|------|
| `argocd-application-controller` | The reconcile loop — compares Git vs. cluster, applies changes. |
| `argocd-repo-server` | Clones Git repos, renders manifests (plain YAML, Helm, Kustomize). |
| `argocd-server` | API + web UI. |
| `argocd-redis` | Internal cache. |
| `argocd-dex-server` | OIDC / SSO provider (optional). |

### 2. Access the Argo CD UI

```bash
kubectl port-forward svc/argocd-server -n argocd 8080:443
```

Open https://localhost:8080 in your browser (accept the self-signed cert warning).

Get the initial admin password:

```bash
# Argo CD >= 2.x stores it in a Secret
argocd admin initial-password -n argocd

# or without the CLI:
kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath="{.data.password}" | base64 -d
echo
```

Login: username `admin`, password from above.

### 3. Build the demo app images

```bash
eval $(minikube docker-env)   # minikube only

cd backend  && docker build -t argocd-demo-backend:1.0 .
cd ../frontend && docker build -t argocd-demo-frontend:1.0 .
```

For kind:

```bash
docker build -t argocd-demo-backend:1.0 ./backend
docker build -t argocd-demo-frontend:1.0 ./frontend
kind load docker-image argocd-demo-backend:1.0
kind load docker-image argocd-demo-frontend:1.0
```

### 4. Register the Application with Argo CD

You have two options:

**Option A — Apply the single demo Application:**

```bash
kubectl apply -f apps/demo-app.yaml
```

This creates one Argo CD Application that watches the `manifests/` folder and syncs it to the `argocd-demo` namespace.

**Option B — Use the App of Apps pattern:**

```bash
kubectl apply -f apps/app-of-apps.yaml
```

This creates a root Application that watches the `apps/` folder. It discovers `demo-app.yaml` (and any future Application YAMLs you add) and creates them automatically.

### 5. Watch Argo CD sync

In the UI (https://localhost:8080), you should see the `demo-app` Application. It will transition:

```
Missing → OutOfSync → Syncing → Synced + Healthy
```

From the CLI:

```bash
argocd app list
argocd app get demo-app
```

Or with kubectl:

```bash
kubectl get applications -n argocd
kubectl get pods -n argocd-demo
```

### 6. Access the demo app

```bash
# Backend API
curl http://$(minikube ip):30110
# or: kubectl port-forward -n argocd-demo svc/backend 30110:80

# Frontend
open http://$(minikube ip):30111
# or: kubectl port-forward -n argocd-demo svc/frontend 30111:80
```

Click "Call backend" in the UI — you'll see the backend's version, hostname (pod name), and timestamp.

### 7. The GitOps demo — change Git, watch the cluster update

This is the payoff. Change something in Git and watch Argo CD apply it:

**Demo 1: Scale replicas**

Edit `manifests/10-backend.yaml`, change `replicas: 2` to `replicas: 4`, commit, and push.

```bash
# Watch Argo CD detect the change (within 3 min, or click "Refresh" in UI)
argocd app get demo-app

# Watch new Pods appear
kubectl get pods -n argocd-demo -w
```

**Demo 2: Roll out a new version**

Edit `manifests/10-backend.yaml`, change `APP_VERSION` from `"v1"` to `"v2"`, commit, and push.

```bash
# After sync, the backend reports the new version
curl http://$(minikube ip):30110
# {"message":"Hello from a GitOps-deployed backend","version":"v2",...}
```

**Demo 3: Self-healing**

Manually delete a Pod or scale the Deployment:

```bash
kubectl scale deploy backend -n argocd-demo --replicas=1
```

Argo CD detects the drift and reverts it back to the Git-defined replica count (2). Check the UI — it briefly shows `OutOfSync`, then re-syncs.

**Demo 4: Prune — remove a resource from Git**

Delete `20-frontend.yaml` from Git and push. Because `prune: true` is set in the sync policy, Argo CD will **delete** the frontend Deployment and Service from the cluster.

---

## The Application manifest — explained

The heart of Argo CD is the `Application` CRD. Here's `demo-app.yaml` annotated:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: demo-app
  namespace: argocd              # always in the argocd namespace
  finalizers:
    - resources-finalizer.argocd.argoproj.io   # delete app → delete managed resources
spec:
  project: default               # AppProject — RBAC boundary

  source:
    repoURL: https://github.com/ronitj1211/K8S-DEMO-APP.git
    targetRevision: main          # branch, tag, or commit SHA
    path: K8S-demo-concept-wise-project/argocd/manifests
    # Also supports:
    #   helm:     { valueFiles: [values-prod.yaml] }
    #   kustomize: { namePrefix: prod- }

  destination:
    server: https://kubernetes.default.svc   # the local cluster
    namespace: argocd-demo                   # where workloads land

  syncPolicy:
    automated:
      prune: true       # delete resources removed from Git
      selfHeal: true    # revert manual cluster changes
    syncOptions:
      - CreateNamespace=true    # create namespace if missing
    retry:
      limit: 5
      backoff:
        duration: 5s
        factor: 2
        maxDuration: 3m
```

### Key sync policy options

| Option | What it does | Default |
|--------|-------------|---------|
| `automated` | Sync without clicking a button. Omit this block for manual-only sync. | manual |
| `prune` | Delete resources the controller created that no longer exist in Git. | `false` |
| `selfHeal` | Revert resources that were changed outside of Git (e.g., `kubectl edit`). | `false` |
| `CreateNamespace` | Create the destination namespace if it doesn't exist. | `false` |
| `ServerSideApply` | Use server-side apply (safer for large resources like CRDs). | `false` |
| `retry` | Retry failed syncs with exponential backoff. | no retry |

---

## The App of Apps pattern

Instead of applying each Application by hand:

```bash
kubectl apply -f app-1.yaml
kubectl apply -f app-2.yaml
kubectl apply -f app-3.yaml    # gets tedious
```

Create one **root Application** that points at a **folder of Application YAMLs**:

```yaml
# app-of-apps.yaml
spec:
  source:
    path: K8S-demo-concept-wise-project/argocd/apps
    directory:
      recurse: true
```

Apply only the root. Argo CD discovers every `Application` in that folder and creates them. Add a new app? Just commit a YAML file to the `apps/` folder.

```
                        ┌─────────────────┐
                        │  root-app       │   ← you apply this one
                        │  (watches apps/)│
                        └────────┬────────┘
                                 │ discovers
                    ┌────────────┼────────────┐
                    ▼            ▼             ▼
              ┌──────────┐ ┌──────────┐ ┌──────────┐
              │ demo-app │ │ app-2    │ │ app-3    │
              │(manifests│ │(another  │ │(another  │
              │   path)  │ │  path)   │ │  path)   │
              └──────────┘ └──────────┘ └──────────┘
```

This is how most teams manage many applications with Argo CD.

---

## Argo CD CLI cheat sheet

```bash
# Login
argocd login localhost:8080

# Applications
argocd app list
argocd app get demo-app
argocd app sync demo-app                   # manual sync
argocd app diff demo-app                   # show what would change
argocd app history demo-app                # past syncs
argocd app rollback demo-app <id>          # revert to a previous sync

# Cluster
argocd cluster list

# Repos
argocd repo list
argocd repo add https://github.com/... --username <user> --password <token>

# Projects
argocd proj list
argocd proj get default
```

---

## Useful kubectl commands

```bash
# Argo CD components
kubectl get pods -n argocd
kubectl logs -n argocd deploy/argocd-application-controller
kubectl logs -n argocd deploy/argocd-repo-server
kubectl logs -n argocd deploy/argocd-server

# Applications (the CRD)
kubectl get applications -n argocd
kubectl describe application demo-app -n argocd

# The workloads Argo CD deployed
kubectl get all -n argocd-demo
kubectl logs -n argocd-demo deploy/backend
```

---

## Scaling notes (for the real world)

| Concern | What you do in production |
|---------|---------------------------|
| **Installation** | Use the Argo CD Helm chart or `argocd-autopilot` instead of the raw install manifest. |
| **Auth / SSO** | Integrate with OIDC (Okta, Google, GitHub) via the Dex config or native OIDC. Disable the default `admin` user. |
| **RBAC** | Create AppProjects per team with allowed source repos, destination namespaces, and cluster resource whitelists. |
| **Webhook** | Set up a GitHub/GitLab webhook to `/api/webhook` so Argo CD syncs immediately on push instead of polling every 3 min. |
| **Secrets** | Don't store Secrets in Git in plain text. Use Sealed Secrets, SOPS, External Secrets Operator, or Vault. |
| **Multi-cluster** | Register external clusters with `argocd cluster add`. One Argo CD instance can manage many clusters. |
| **ApplicationSets** | Use `ApplicationSet` CRDs to template Applications from a matrix (clusters × environments × apps). |
| **Notifications** | Install `argocd-notifications` to send Slack / email / webhook alerts on sync events. |
| **Image Updater** | `argocd-image-updater` watches a container registry and updates image tags in Git automatically. |

---

## Cleanup

```bash
# Delete the demo app (and all resources it manages, thanks to the finalizer)
kubectl delete application demo-app -n argocd

# Or if using App of Apps:
kubectl delete application root-app -n argocd

# Verify workloads are gone
kubectl get all -n argocd-demo

# Delete the namespace
kubectl delete namespace argocd-demo

# Uninstall Argo CD itself
kubectl delete -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
kubectl delete namespace argocd
```

---

## Key takeaways

1. **GitOps = Git is the source of truth.** You don't `kubectl apply` from your laptop. You push to Git, and the controller applies for you.
2. **Argo CD is a pull-based controller.** It lives inside the cluster and pulls from Git — no CI pipeline needs cluster credentials.
3. **`selfHeal: true` + `prune: true`** makes the cluster converge to Git automatically. Manual changes get reverted; deleted manifests get cleaned up.
4. **The Application CRD** is the bridge between a Git path and a cluster namespace. Learn its fields and you understand Argo CD.
5. **App of Apps** scales management — one root Application discovers all others from a folder in Git.
6. For real workloads, add **webhooks** (instant sync), **RBAC** (team isolation), and **a secrets solution** (never commit plain Secrets to Git).

**Back to** [course index](../README.md)
