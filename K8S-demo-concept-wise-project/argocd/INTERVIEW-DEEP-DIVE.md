# Argo CD & GitOps — Deep Dive for Interviews

The narrative on GitOps and Argo CD. Why the model exists, how it changes the operations picture, and how to talk about it.

---

## The origin story

In the pre-GitOps world, deploying to K8s meant one of these:

- **Developer laptops** — someone with kubeconfig runs `kubectl apply`. Cluster state depends on who deploys and when.
- **CI push** — a Jenkins/GitHub Actions job runs `kubectl apply` at the end of the pipeline. Better, but CI now has cluster credentials, and drift happens (someone edits a resource in cluster, no one commits it back).
- **kubectl edit** — mid-incident hotfix. Change lives only in the cluster. Nobody knows until the next `apply` overwrites it.

**Common failures**:
- "What's actually running in prod?" — answered by `kubectl get`, not the repo.
- No audit trail — who changed what when.
- Drift — cluster and Git diverge silently.
- No self-healing — if a resource is accidentally deleted, nothing brings it back until someone notices.

The **GitOps model** (Weaveworks, ~2017) flipped it: **Git is the source of truth. A controller inside the cluster continuously reconciles the cluster to match Git.** Deploy = push to Git. Drift = auto-corrected. Rollback = `git revert` + push.

**Argo CD** (Intuit, 2018, later CNCF) became the reference implementation. Flux is the other major GitOps controller with similar semantics.

## The mental model

Argo CD is a **Kubernetes controller that watches Git repos and reconciles the cluster to match.**

Key concepts:
- **Application** — the core Argo CD CRD. Points at a Git path and a destination (cluster + namespace). One Application = one set of manifests to sync.
- **Sync** — the act of making the cluster match Git.
- **Sync Status** — Synced (cluster matches Git) or OutOfSync (they differ).
- **Health Status** — the runtime state of the managed resources (Healthy, Progressing, Degraded, Missing).
- **AppProject** — RBAC / grouping for Applications. Restricts which repos, clusters, namespaces an Application can use.

Argo CD **doesn't replace CI**. Your CI still builds images. Argo CD replaces the deploy step of CI: instead of CI running `kubectl apply`, CI updates the image tag in a Git manifest, and Argo CD sees the change and applies it.

## How it actually works

The reconcile loop:

1. **Argo CD's repo-server** clones the Git repo (or pulls the latest) periodically — default every 3 minutes, or immediately on webhook.
2. Renders manifests: raw YAML as-is, or `helm template` for Helm charts, or `kustomize build` for Kustomize bases.
3. **Argo CD's application-controller** compares the rendered manifests against the live cluster state.
4. If **automated sync** is enabled and there's a difference, applies the changes.
5. **Watches resource health** — Pods Running, Deployments complete, etc. Reports Healthy/Progressing/Degraded.
6. If **self-heal** is enabled, reverts drift the moment it's detected (someone `kubectl edit`s a resource; Argo reverts it back to Git's version).

**Components inside the cluster** (all in the `argocd` namespace):
- `argocd-server` — API + web UI.
- `argocd-repo-server` — clones repos, renders manifests.
- `argocd-application-controller` — the reconcile loop.
- `argocd-redis` — internal cache.
- `argocd-dex-server` — OIDC/SSO (optional).

## When to use Argo CD

- **Multi-environment deploys** with Git as source of truth. Argo shines here.
- **Multi-cluster deploys** — one Argo CD can manage many clusters.
- **Compliance / audit requirements** — every deploy is a Git commit with author, timestamp, review.
- **Teams that want to see cluster state at a glance** — Argo UI is genuinely nice.

Don't use for:
- **Trivial single-repo, single-cluster setups** — the ceremony isn't worth it. Just `kubectl apply` from CI.
- **Ephemeral / preview environments** — Argo can do it but it's more work than throwaway `kubectl` deploys.

## Key patterns

**Automated sync with prune + self-heal**:
```yaml
syncPolicy:
  automated:
    prune: true       # delete resources removed from Git
    selfHeal: true    # revert manual drift
```
This is what "GitOps" really means in practice — Git is unconditionally the source of truth.

**Manual sync for prod**: some teams prefer manual sync in production. Argo detects drift and shows a diff; a human clicks Sync. Slower but sometimes appropriate for high-blast-radius changes.

**App of Apps**: one root Application points at a Git folder full of *other* Application manifests. Apply the root; Argo discovers and manages the rest. How you bootstrap a whole cluster's app portfolio with one `kubectl apply`.

**ApplicationSet**: template-driven generation of many Applications from a matrix or list. Used for "same app deployed to N clusters/environments." Reduces boilerplate vs App-of-Apps.

**Sync Waves**: `argocd.argoproj.io/sync-wave: "-1"` annotation orders resources within a sync. CRDs in wave -1, operator Deployment in wave 0, Custom Resources in wave 1.

**Sync Hooks**: `argocd.argoproj.io/hook: PreSync` runs a resource (typically a Job) before the main sync. DB migrations.

## Common misunderstandings

**"Argo CD replaces CI."** It doesn't. CI builds images and runs tests. Argo CD deploys. You still need CI. The typical flow: PR → CI runs tests → merge to main → CI builds image, pushes to registry, updates image tag in the manifests repo → Argo detects the change → syncs.

**"Argo CD only works with plain YAML."** It works with Helm charts, Kustomize, Jsonnet, and can even invoke arbitrary plugins. Common setup: Helm charts in Git, Argo renders with `helm template`.

**"Automated sync means immediate."** Argo polls every 3 minutes by default. To make it faster, configure a Git webhook to Argo's `/api/webhook` endpoint. Then pushes trigger sync within seconds.

**"Argo tells me when a deploy is done."** It tells you when the *sync* is done. The resources are applied. But your app inside them may still be rolling — the health status shows `Progressing` until Deployments finish. Wait for `Healthy`, not `Synced`.

**"GitOps means everything must be in Git."** Ideally yes, but externally-controlled fields (HPA-managed replica count, admission-webhook-added labels) create drift Argo will fight against. Use `ignoreDifferences` to tell Argo to ignore specific fields.

## The war stories

**"Argo kept reverting HPA's replica count."** The Deployment manifest specified `replicas: 3`, but HPA scaled to 10. Argo saw drift (10 vs 3) and self-healed back to 3. HPA scaled back to 10. Loop. Fix: `ignoreDifferences` on `/spec/replicas` for that Deployment. Or remove `replicas` from the manifest entirely.

**"Deploy 'succeeded' but Pods were still crashing."** Argo reported `Synced` — the resources were applied to K8s. But `Healthy: False, Degraded` — the Deployment's Pods were CrashLoopBackOff. The user only looked at Sync status. Look at both.

**"Rolled back the branch, but the cluster kept the buggy version."** Argo was configured with manual sync. Reverting Git didn't automatically apply. Someone had to click Sync. Fix: use automated sync + selfHeal for envs where you want strict Git-is-truth.

**"Deleted the wrong Application by mistake, and Argo deleted all its resources."** `syncPolicy.automated.prune: true` + `finalizers: resources-finalizer.argocd.argoproj.io` means when you delete the Application, Argo cascades and deletes all the K8s resources it managed. Recovery: revert the Application in Git (Argo recreates the resources). Prevention: `syncOptions: - allowEmpty=false` guards against accidental empty Git states.

**"Argo lost connection to the private Git repo."** Deploy key expired, or Argo's repo-server credentials rotated without updating Argo. Fix: refresh the secret in Argo's UI (Settings → Repositories).

**"Two teams had conflicting Applications in the same namespace."** Both created a Deployment `backend`; they took turns overwriting each other. Fix: give each team its own AppProject with restricted namespace destinations. Also namespace-scope by prefix (team-alpha-backend, team-beta-backend).

## What to actually say in an interview

If asked "what's GitOps?":

> GitOps is a deployment model where Git is the single source of truth for cluster state. Instead of running `kubectl apply` from a laptop or CI, a controller inside the cluster continuously watches Git and reconciles the cluster to match. Push to Git = deploy. Drift = auto-corrected. Rollback = `git revert` + push. The benefits are: audit trail (every deploy is a commit), self-healing (manual `kubectl edit` gets reverted), and separation of concerns (CI never needs cluster credentials).

If asked about Argo CD specifically:

> Argo CD is the reference GitOps controller for Kubernetes. It has one main CRD, `Application`, that points at a Git path and a destination cluster+namespace. Argo watches the Git repo, compares to live cluster state, syncs differences. Sync can be manual (drift is detected, human clicks Sync) or automated (with prune to delete removed resources and selfHeal to revert manual drift). It supports raw YAML, Helm, and Kustomize natively. Compared to CI-pushed deploys, the big shift is that CI no longer has cluster credentials — Argo pulls from Git; CI just writes to Git.

If asked about the CI/CD boundary:

> Argo CD doesn't replace CI — it replaces the deploy step. CI still runs tests and builds images. The deploy step, instead of `kubectl apply`, becomes "update the image tag in a Git manifests repo." Common setup: an application-code repo with CI that builds images, and a separate manifests repo that Argo watches. CI's final step is a bot commit that updates the image tag. Argo sees it, syncs, deploys.

If asked about advanced patterns:

> App of Apps for bootstrapping — one root Application points at a folder of other Applications, apply once, Argo discovers everything. ApplicationSet for templated fleet deploys — one template + a generator (list of clusters/envs) creates many Applications. Sync waves for ordering — CRDs first, then operators, then Custom Resources. Sync hooks for lifecycle — PreSync Jobs for DB migrations. For production: manual sync at first while you build trust; automated sync with selfHeal once the team is comfortable.

Say the words: **Git is source of truth**, **controller reconciles cluster to Git**, **pull not push**, **CI still builds; Argo deploys**, **Application CRD**, **automated sync + prune + selfHeal**, **App of Apps / ApplicationSet**, **ignore differences for HPA-managed fields**, **health vs sync status**.
