# Interview Questions — Argo CD / GitOps

---

## Basic

### Q1. What's GitOps?
A model where **Git is the single source of truth** for cluster state. A controller inside the cluster watches the repo and reconciles the cluster to match. You don't `kubectl apply` from your laptop; you `git push`.

### Q2. What's Argo CD?
A GitOps continuous-delivery tool. It:
- Watches Git repos for K8s manifests / Helm charts / Kustomize bases.
- Compares **desired state** (Git) vs **live state** (cluster).
- Syncs differences (creates/updates/deletes resources).
- Surfaces status and diffs in a web UI / CLI / API.

### Q3. Argo CD's core CRD?
`Application` — the link between Git and the cluster. It says "watch this path in this repo, sync to this namespace on this cluster." There's also `AppProject` (RBAC / grouping for Applications) and `ApplicationSet` (template-driven generation of many Applications).

### Q4. Push vs pull CI/CD — which is GitOps?
GitOps is **pull**:
- **Push** — pipeline runs `kubectl apply` from outside; the cluster receives changes.
- **Pull** — controller inside the cluster watches Git and pulls changes itself.

Pull has a tighter security boundary (CI never has cluster credentials) and continuous reconciliation (drift is fixed).

### Q5. What's "drift"?
When the live cluster state differs from Git. Argo CD flags this as `OutOfSync`. With `selfHeal: true`, it auto-reverts manual changes back to Git's state.

### Q6. What's the "App of Apps" pattern?
One root Argo CD `Application` points at a folder of *other* `Application` YAMLs in Git. Apply the root → Argo CD discovers and manages the rest. Lets you bootstrap a whole cluster's apps with a single `kubectl apply`.

### Q7. Sync status vs Health status?
- **Sync status** — does the cluster match Git? `Synced`, `OutOfSync`.
- **Health status** — are the resources actually healthy? `Healthy`, `Progressing`, `Degraded`, `Missing`.

A resource can be `Synced` but `Degraded` (deployed correctly but the app is crashing).

---

## Intermediate

### Q8. Auto-sync vs manual sync?
- **Manual** — Argo CD detects drift but requires a click / CLI to sync. Safer for prod.
- **Automated** — Argo CD syncs as soon as it detects drift. Set `syncPolicy.automated: {}`.

Sub-options under automated:
- `prune: true` — delete cluster resources that are no longer in Git.
- `selfHeal: true` — revert manual changes.
- `allowEmpty: false` — don't sync if Git is empty (safety against accidental `rm -rf`).

### Q9. How does Argo CD know when Git changes?
- **Polling** (default) — every 3 minutes (`timeoutSeconds`).
- **Webhook** — configure Git to POST to Argo CD's `/api/webhook` for instant notification.

Webhooks need Argo CD reachable from GitHub/GitLab — usually means a public Ingress.

### Q10. What's an `AppProject`?
RBAC boundary. Restricts which repos, clusters, and namespaces an Application can use. The `default` AppProject is wide open; for multi-tenant clusters, create per-team projects with `sourceRepos`, `destinations`, `clusterResourceWhitelist`, `namespaceResourceBlacklist`, etc.

### Q11. What's `ApplicationSet`?
A controller that generates many `Application` resources from a template + a generator (list, cluster, Git directory, matrix). Use case: one Application per team, one Application per environment. Avoids the App-of-Apps boilerplate.

### Q12. What sync options are useful?
- `CreateNamespace=true` — create destination namespace if missing.
- `PrunePropagationPolicy=foreground` — wait for deletes to complete before proceeding.
- `ServerSideApply=true` — use server-side apply (safer for big CRDs and Helm-managed resources).
- `Replace=true` — `kubectl replace` instead of `apply` (rare; loses metadata).
- `RespectIgnoreDifferences=true` — honor ignore rules during sync, not just diff.

### Q13. How do you ignore certain fields from drift detection?
`ignoreDifferences` on the Application:
```yaml
ignoreDifferences:
  - group: apps
    kind: Deployment
    jsonPointers: [/spec/replicas]   # let HPA control replicas
```
Common use: ignore replica count when an HPA owns it.

### Q14. Argo CD vs Flux?
Both are GitOps controllers. Differences:
- **Argo CD** — UI-first, one Application per Git path. Strong visual diff.
- **Flux** — CLI-/CRD-first, more composable (separate `Kustomization`, `HelmRelease`, `GitRepository` resources). Better for pure pipelines.

Both are CNCF graduated. Argo CD usually wins on UX; Flux on flexibility.

### Q15. How does Argo CD handle Helm?
Argo CD can use the chart from Git, or pull from a Helm repo. Internally it runs `helm template` (not `helm install`) and applies the rendered manifests itself. This means **Argo CD owns the release state**, not Helm — `helm list` won't show Argo-managed releases. The `valueFiles`, `valuesObject`, and `parameters` fields on the Application override values.

### Q16. What's a Sync Wave?
Annotation `argocd.argoproj.io/sync-wave: "-1"` (or any integer) orders resources within a sync. Lower waves apply first. Common pattern: CRDs in wave -1, then operator Deployment in wave 0, then Custom Resources in wave 1.

### Q17. What's a Sync Hook?
Like Helm hooks. Annotate a resource with `argocd.argoproj.io/hook: PreSync` (or `Sync`, `PostSync`, `SyncFail`) to run it at a specific lifecycle phase. Common: a Job that runs DB migrations on `PreSync`.

---

## Scenario-based

### S1. Argo CD shows `OutOfSync`. What changed?
Click into the Application — UI shows the per-resource diff with the difference highlighted. Common causes:
- Someone `kubectl edit`ed the resource (drift).
- A controller mutated it (e.g., HPA set replicas).
- A defaulting webhook added fields the Git manifest doesn't have.

Fix the right side:
- True drift → `Sync` (push Git's state).
- Controller-owned field → `ignoreDifferences`.
- Webhook field → `respectIgnoreDifferences` or annotate the resource.

### S2. Your sync fails — "Resource not permitted in project".
The AppProject restricts what the Application can use. Either:
- Widen the project's `destinations` / `sourceRepos`.
- Move the Application to a less-restricted project.

This is exactly what AppProjects are for — preventing teams from deploying outside their lane.

### S3. You accidentally pushed bad YAML and Argo CD synced it — Pods are crashing.
Two options:
1. **`git revert` + push** — Argo CD picks up the revert and rolls back. Clean GitOps.
2. **Argo CD "Rollback" in UI** — flips to a previous revision instantly. Faster, but Git and cluster are out of sync until you also revert in Git.

Option 1 is the GitOps-purist answer; option 2 is the on-call answer.

### S4. Argo CD can't reach your private Git repo.
- Add the repo via `argocd repo add git@... --ssh-private-key-path ~/.ssh/id_ed25519`.
- For HTTPS: `argocd repo add https://... --username --password`.
- Or via a `Repository` Secret in the `argocd` namespace.

Verify in **Settings → Repositories** — green check means Argo CD authenticated.

### S5. Two Applications target the same namespace and collide.
Common when two teams accidentally manage the same resource. Argo CD's view becomes confusing — both Applications show drift against each other.

Fix:
- Add per-app prefix (Helm release name) so resources are uniquely named.
- Use `AppProject` to restrict each team to their own namespace.
- ApplicationSet's `templatePatch` to enforce naming conventions.

### S6. CRDs are stuck in `Out of sync` because their `status` field is in Git.
Don't put `status` in Git — it's runtime state. Use `ignoreDifferences`:
```yaml
ignoreDifferences:
  - group: '*'
    kind: '*'
    jsonPointers: [/status]
```
Or use `kubectl neat` (a plugin) to clean exports before committing.

### S7. You want a manual approval gate before production deploys.
Two patterns:
- **Manual sync** in the prod Application — Argo CD detects drift but doesn't apply; an oncall clicks Sync.
- **Pull request workflow** — the staging Application auto-syncs from `main`, the prod Application syncs from a `prod` branch; promoting = merging staging into prod via PR review.

### S8. ApplicationSet generates 50 apps; one is broken. Can you investigate without un-generating all 50?
Yes — the broken `Application` exists as a normal K8s resource. `kubectl describe application <name> -n argocd` and the UI show the per-app status. Fix the template / values to address the broken one; the ApplicationSet re-renders only the changed Applications.

### S9. Argo CD is itself broken (controller crash, etc.). How do you keep deploying?
- `kubectl apply -f manifests/` directly — Argo CD doesn't have to be up for the cluster to work; it just won't reconcile drift while down.
- For the long-term recovery, Argo CD itself is often deployed via... Argo CD (chicken-and-egg). Bootstrap pattern: install Argo CD via a static manifest, then have Argo CD manage itself going forward.
