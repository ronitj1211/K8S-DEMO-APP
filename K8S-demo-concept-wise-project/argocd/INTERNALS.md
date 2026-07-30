# Argo CD — Internals

The reconcile loop, component split, Application CRD, diffing mechanics.

---

## Purpose

Argo CD is a K8s controller that watches Git repositories and reconciles the cluster to match the manifests in Git. **Git is source of truth**; the cluster is a projection of Git.

## The three-component architecture

Argo CD runs in the `argocd` namespace as several Deployments:

- **argocd-repo-server** — clones Git repos, renders manifests (`kubectl kustomize`, `helm template`, or raw YAML). Stateless. Multiple replicas for scale.
- **argocd-application-controller** — the reconcile loop. Compares Git manifests to live cluster state. Applies changes. Stateful (holds sync state in memory + K8s objects).
- **argocd-server** — API server + Web UI. gRPC + REST. Handles user requests, RBAC, SSO integration.

Plus supporting:
- **argocd-redis** — caching (repo renders, RBAC).
- **argocd-dex-server** — OIDC/SSO if enabled.
- **argocd-notifications-controller** — Slack/email/webhook alerts on sync events.
- **argocd-applicationset-controller** — ApplicationSet CRD reconciliation.

## The `Application` CRD

Everything revolves around one CRD:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: my-app
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://github.com/ronitj1211/K8S-DEMO-APP.git
    targetRevision: main
    path: K8S-demo-concept-wise-project/argocd/manifests
  destination:
    server: https://kubernetes.default.svc
    namespace: my-app-ns
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

- `source` — where the manifests come from.
- `destination` — which cluster + namespace to sync to.
- `syncPolicy` — how to sync.

**Multi-cluster**: an Application can target any cluster registered with Argo. Register via `argocd cluster add <context>`.

## The reconcile loop

Every 3 minutes (default `timeoutSeconds`), for each Application:

1. **Refresh**: repo-server does `git fetch` (or reuses cache if recent), then renders manifests based on the `source.path` and `targetRevision`.
2. **Fetch live state**: application-controller lists resources in the destination cluster+namespace matching the Application's ownership annotations.
3. **Diff**: compute the delta between the rendered manifests (desired) and the live state (actual).
4. **Status**: update `Application.status.sync` (Synced / OutOfSync) and `Application.status.health` (Healthy / Progressing / Degraded / Missing).
5. **Sync** (if automated): apply the differences to the cluster.

## Sync operation — how apply happens

When Argo syncs:

1. **Sort resources** by kind (Namespaces first, then CRDs, then everything else — enforce dependency order).
2. **Apply sync-wave annotations** (`argocd.argoproj.io/sync-wave: "-1"`) if present — resources with lower waves apply first.
3. **Run PreSync hooks** — resources with `argocd.argoproj.io/hook: PreSync` (usually a Job for migrations). Wait for completion.
4. **Apply main sync resources** — `kubectl apply` (or `kubectl replace` if configured) for each resource.
5. **Wait for health** — poll each resource's health status until it's Healthy or timeout.
6. **Run PostSync hooks**.
7. **Update status**.

Failure at any step: mark the sync as Failed. `SyncFail` hooks run for cleanup.

## Health checks

For each resource kind, Argo has a built-in health check function:
- **Deployment**: Healthy when `status.readyReplicas == spec.replicas` and no deployment condition is degraded.
- **StatefulSet**: Healthy when all replicas are ready.
- **PVC**: Healthy when `status.phase == Bound`.
- **Pod**: Healthy when Ready.

You can override with a custom health check in Lua:

```lua
-- for a custom resource
hs = {}
hs.status = "Progressing"
if obj.status ~= nil then
  if obj.status.phase == "Ready" then
    hs.status = "Healthy"
  elseif obj.status.phase == "Failed" then
    hs.status = "Degraded"
    hs.message = obj.status.errorMessage
  end
end
return hs
```

## Sync policies — what auto-sync means

```yaml
syncPolicy:
  automated:
    prune: true       # delete resources removed from Git
    selfHeal: true    # revert manual drift
    allowEmpty: false # don't sync if Git renders to nothing (safety)
```

- **`prune: true`** — during sync, delete cluster resources that are no longer in Git. Without this, deleted-in-Git resources linger in the cluster.
- **`selfHeal: true`** — if the live state drifts from Git (someone `kubectl edit`s a resource), Argo automatically re-syncs to restore Git's state.
- **`allowEmpty: false`** — if the source renders to zero resources (e.g., someone `rm`'d the manifests folder in Git), refuse to sync. Prevents accidental full deletion.

**Manual sync**: without `automated`, Argo detects drift but doesn't apply — a human clicks Sync (or calls `argocd app sync`).

## `ignoreDifferences` — for controller-owned fields

HPA changes `spec.replicas` on a Deployment. Argo sees drift (replicas != Git). Self-heals back. HPA scales again. Loop.

Fix:
```yaml
ignoreDifferences:
  - group: apps
    kind: Deployment
    jsonPointers:
      - /spec/replicas
```

Argo now ignores `spec.replicas` diffs. HPA can freely scale without Argo interfering.

Similar for admission-webhook-added labels, defaulted fields, and other controller-managed values.

## Sync waves

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: config
  annotations:
    argocd.argoproj.io/sync-wave: "0"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
  annotations:
    argocd.argoproj.io/sync-wave: "1"    # apply after wave 0
```

Sync waves are integers. Lower waves apply first. Common pattern: CRDs at wave -1, operators at wave 0, custom resources at wave 1.

Argo waits for all resources in wave N to be Healthy before applying wave N+1.

## Sync hooks

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: migrate
  annotations:
    argocd.argoproj.io/hook: PreSync
    argocd.argoproj.io/hook-delete-policy: BeforeHookCreation, HookSucceeded
spec:
  # ... migration Job
```

Hook events:
- `PreSync` — before applying resources.
- `Sync` — during the main sync (unusual).
- `PostSync` — after main sync + health.
- `SyncFail` — if sync fails, for cleanup.

Delete policies:
- `HookSucceeded` — delete after success.
- `HookFailed` — delete after failure.
- `BeforeHookCreation` — delete previous hook before creating new one.

Hooks are NOT part of the tracked resource set — they run separately.

## AppProject — RBAC and boundaries

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: team-alpha
  namespace: argocd
spec:
  sourceRepos:
    - "https://github.com/team-alpha/*"
  destinations:
    - namespace: "team-alpha-*"
      server: https://kubernetes.default.svc
  clusterResourceWhitelist: []       # can't touch cluster-scoped resources
  namespaceResourceWhitelist:
    - group: "*"
      kind: "*"                       # any resource within their namespaces
```

An Application in a project can only:
- Pull from `sourceRepos` matching the project's patterns.
- Sync to `destinations` matching the project's patterns.
- Create/modify resource types matching the whitelists.

Multi-tenancy: each team's Applications go in their own project.

## ApplicationSet — templated fleet Applications

Rather than manually creating 10 Applications for 10 environments:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: my-app-fleet
spec:
  generators:
    - list:
        elements:
          - env: dev
            cluster: dev-cluster
          - env: staging
            cluster: staging-cluster
          - env: prod
            cluster: prod-cluster
  template:
    metadata:
      name: 'my-app-{{env}}'
    spec:
      source:
        repoURL: https://github.com/my-org/manifests.git
        path: apps/my-app
        targetRevision: HEAD
        helm:
          valueFiles:
            - values-{{env}}.yaml
      destination:
        server: '{{cluster}}'
        namespace: my-app
```

ApplicationSet controller iterates the generator's output, creates one Application per element. Add a new environment → add a list entry → new Application appears.

Other generators: `git` (folders in a repo), `matrix` (crosses generators), `cluster` (all registered clusters).

## App of Apps — bootstrap pattern

One root Application points at a folder of *other* Application manifests:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: root
spec:
  source:
    repoURL: https://github.com/my-org/gitops.git
    path: bootstrap/apps          # folder full of Application YAMLs
  destination:
    server: https://kubernetes.default.svc
    namespace: argocd
  syncPolicy:
    automated: { prune: true, selfHeal: true }
```

Applying `root` → Argo discovers all Applications in that folder → deploys them. Bootstraps an entire cluster with one command.

## Webhook trigger for instant sync

Argo polls Git every 3 minutes. To make pushes trigger a sync within seconds, configure a Git webhook:

```
POST https://argocd.example.com/api/webhook
```

GitHub webhook: on push events. Argo receives, immediately refreshes the affected Applications.

## The "sync status vs health status" distinction

Two orthogonal states:
- **Sync status**: does the live cluster match Git? `Synced` or `OutOfSync`.
- **Health status**: are the resources actually running/healthy? `Healthy`, `Progressing`, `Degraded`, `Missing`.

You can have `Synced` + `Degraded` — Argo applied the manifests correctly, but the resulting Pods are CrashLoopBackOff (bad image). Sync succeeded; health didn't.

Or `OutOfSync` + `Healthy` — someone edited a Deployment; the app is running fine (Healthy) but the live state doesn't match Git (OutOfSync). With `selfHeal: true`, Argo would re-sync to Git.

## Cluster registration

```bash
argocd cluster add <kube-context>
```

Creates a K8s Secret in the `argocd` namespace with kubeconfig details, and a ServiceAccount in the target cluster with cluster-admin (or scoped) permissions. The application-controller uses these credentials to apply resources.

Managed clusters (EKS/GKE) can also use IRSA / Workload Identity to avoid storing static credentials.

---

## The 30-second summary

- Argo CD is a K8s controller: watches Git, applies manifests. Not a CI system — CI still builds images.
- Three components: repo-server (renders), application-controller (reconciles), argocd-server (UI/API).
- `Application` CRD points at Git path + destination cluster+namespace.
- Reconcile loop: refresh (git pull + render) → diff (Git vs cluster) → sync (apply changes) → wait for health.
- Automated sync = auto-apply drift; `prune` deletes removed-in-Git; `selfHeal` reverts manual changes; `allowEmpty: false` guards against catastrophes.
- `ignoreDifferences` for controller-owned fields (HPA replicas, webhook labels).
- Sync waves for dependency ordering; sync hooks for lifecycle jobs (migrations).
- AppProject for multi-tenant boundaries; ApplicationSet for templated fleet Applications; App of Apps for bootstrap.
