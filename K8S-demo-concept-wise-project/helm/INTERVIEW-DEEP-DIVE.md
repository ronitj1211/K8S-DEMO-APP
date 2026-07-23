# Helm — Deep Dive for Interviews

The narrative on Kubernetes' package manager. What Helm actually solves, why v2 vs v3 matters, and how to talk about it.

---

## The origin story

Early Kubernetes had a real problem: **YAML sprawl**. Every microservice had similar-looking manifests: Deployment, Service, ConfigMap, Secret, ServiceAccount, Role, RoleBinding, HPA, PDB. Cross-environment variation (dev vs staging vs prod) meant either N copies of each file (with subtle drift) or elaborate templating in your CI/CD.

Helm (2015, Deis, later CNCF) introduced three ideas:

1. **Chart** — a directory bundling all the K8s YAML for one app, with Go template placeholders.
2. **Values** — a set of parameters to fill the placeholders. Different values files per environment.
3. **Release** — one specific installation of a chart with a specific values set, in a specific namespace, tracked by Helm.

Suddenly you could `helm install dev ./chart -f values-dev.yaml`, `helm install prod ./chart -f values-prod.yaml`, and the same chart drove both. Bumping the chart bumped all environments in a controlled way. Rollback was `helm rollback prod 5`.

## The mental model

Helm turns raw K8s YAML into **reusable, parameterized, versioned packages**.

- **Chart** = the package (template + defaults).
- **Values file** = per-environment overrides.
- **Release** = one specific installation of a chart into a cluster.
- **Revision** = a snapshot of the release at some point (each `helm upgrade` creates a new revision).

Analogies:
- Chart ≈ npm/pip package.
- Values ≈ config file for that package.
- Release ≈ an installed instance.
- Revision ≈ a versioned deploy.

The revision history is what enables `helm rollback` — Helm stores each revision as a Secret in the release's namespace.

## How it actually works

**Rendering**: `helm install` reads the chart's `templates/*.yaml`, applies Go template functions using values from `values.yaml` + `-f overrides.yaml` + `--set` flags, and outputs pure Kubernetes YAML.

**Installation**: Helm calls the K8s API to apply that YAML. Creates all the resources, tagged with labels identifying the release (`app.kubernetes.io/managed-by: Helm`, `app.kubernetes.io/instance: <release-name>`).

**State tracking**: Helm stores each release's metadata (chart version, values used, rendered manifests) as a Secret named `sh.helm.release.v1.<release>.v<revision>`. This is how `helm list`, `helm history`, `helm rollback` know what's what.

**Upgrade**: `helm upgrade` renders the new chart, computes a diff against the previous release's manifests, applies changes to the cluster (which may trigger K8s controllers to rolling-update Pods), and writes a new revision Secret.

**Rollback**: `helm rollback` picks a previous revision Secret, re-applies its stored manifests, and marks it as the current revision.

**Hooks**: templates annotated with `helm.sh/hook: pre-install` (or `pre-upgrade`, `post-delete`, etc.) run at lifecycle events — commonly a Job that runs DB migrations before app Pods start.

## Helm v2 vs Helm v3 — why it matters

**Helm v2** (2016-2019) had a server-side component called **Tiller** that ran in the cluster with cluster-admin. Every `helm` command talked to Tiller, which then talked to the K8s API on your behalf. Security nightmare: Tiller could do anything, and anyone with Helm CLI access could deploy anything anywhere.

**Helm v3** (Nov 2019+) removed Tiller. Helm now talks directly to the K8s API using your kubeconfig; RBAC applies normally. Release state moved from Tiller's namespace to Secrets in the release's own namespace.

**Never use Helm v2 in 2026.** If you find a legacy chart with `apiVersion: v1` in Chart.yaml, migrate with `helm 2to3`.

## When to use Helm

- **Multiple environments** of the same app (dev/staging/prod) — Helm's values files shine.
- **Reusable operators** — every operator (Prometheus, cert-manager, ingress-nginx, ArgoCD) ships a Helm chart.
- **Team-level app portability** — one chart, many teams install with their values.
- **Complex apps with many resources** — a chart bundles them into one install/uninstall unit.

## When Helm might not be the right tool

- **GitOps with Kustomize** — some teams prefer Kustomize's overlay model (no templating, YAML patches). Argo CD supports both.
- **Very simple apps** — a Deployment + Service is 30 lines. Wrapping in Helm adds ceremony.
- **Ephemeral / one-off** — for `kubectl run debug`, Helm is overkill.

Common hybrid: **Argo CD or Flux for GitOps, Helm charts as the manifest format**. Argo renders the chart with `helm template` (not `helm install`), owns the release state itself. Best of both worlds.

## Common misunderstandings

**"Helm is a K8s controller."** Helm is a **client-side CLI**. It talks to the K8s API using kubeconfig. Nothing runs in the cluster on Helm's behalf (in v3+; v2 had Tiller).

**"`helm template | kubectl apply` and `helm install` are equivalent."** They render the same YAML, but `helm install` also creates the release-tracking Secret. `helm template | kubectl apply` gives you the manifests but Helm doesn't know about the release — no history, no rollback.

**"Helm hooks are transactions."** They're not — hooks run separately from the main resources, aren't rolled back if the main install fails. A `pre-install` migration Job that succeeded stays succeeded even if the subsequent Deployment fails.

**"Subchart values are automatic."** They're not — you have to nest them under the subchart's name in `values.yaml`. If a chart depends on `redis` as a subchart, values for redis go under `redis:` in the parent's values file.

**"CRDs in `templates/` are managed like anything else."** They are — but so is upgrading them (which mutates data types, potentially destructively). Best practice: CRDs live in `crds/` directory in the chart, where Helm only installs (never upgrades). Update CRDs separately.

**"`helm upgrade --install` is safe."** Mostly, but if the chart adds/removes labels that change selectors, Helm's diff can result in surprising resource churn. `helm diff upgrade` (via the helm-diff plugin) shows changes before you apply.

## The war stories

**"Upgrade succeeded but Pods didn't roll."** The Deployment template didn't change — Pods use ConfigMap values via `envFrom`, and the values updated but the Deployment did not. Fix: annotate the Deployment with a checksum of the ConfigMap: `annotations: checksum/config: {{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}`. When ConfigMap changes, checksum changes, Deployment template changes, Pods roll.

**"Release exists but `helm list` doesn't show it."** Wrong namespace: `helm list -A` shows all. Or wrong storage driver: `--driver=configmap` if the release was created with the older driver.

**"CRDs got out of sync."** Chart's `crds/` directory gets installed on first `helm install` but NOT updated on subsequent `helm upgrade`. If the operator's CRDs changed, they're stale. Fix: `kubectl apply -f <new-crds>` manually, or use a separate CRD-only chart the ops team upgrades explicitly.

**"Two Helm releases fighting over the same resource."** Both chart templates create a Deployment named `foo` in the same namespace. Symptom: `helm upgrade` fails with `rendered manifests contain a resource that already exists`. Fix: rename with release name prefix (`{{ .Release.Name }}-foo`), or use separate namespaces per release.

**"After Tiller was uninstalled, we lost all release history."** Migration from v2 to v3 wasn't done properly. `helm 2to3 convert` per release, then `helm 2to3 cleanup` for Tiller. Don't just delete Tiller and reinstall.

**"`helm rollback` didn't actually roll back."** Rollback re-applies the stored manifests but doesn't fix data-layer changes. A migration that ran forward doesn't reverse. Design with backward-compatible migrations (add columns, don't drop; feature flag the reads/writes).

## What to actually say in an interview

If asked "what's Helm?":

> Helm is the package manager for Kubernetes. A chart is a bundle of parameterized YAML templates plus default values. A release is one installation of that chart into a cluster with a specific set of values. The big wins are cross-environment reuse — same chart, different values files per env — and versioned deploys with rollback. Under the hood in Helm 3, it's just a client that talks to the K8s API using your kubeconfig; releases are stored as Secrets. Helm 2 had Tiller server-side, which was a security nightmare and is deprecated.

If asked about Helm vs raw manifests:

> Raw manifests: fine for a simple app in one environment. Helm shines when you have multiple environments (dev/staging/prod), multiple releases of the same chart (a shared platform team installs many customer-specific instances), or complex operators with lots of interconnected resources. The trade-off is templating complexity — Go templates in YAML can get gnarly, and errors don't always give useful messages. Kustomize is the main alternative — patch-based instead of template-based, less power but simpler.

If asked about Helm + GitOps:

> Common hybrid: Argo CD or Flux for GitOps flow, Helm charts as the manifest format. Argo renders the chart with `helm template` (not `helm install`) and owns the deployed state itself. So you get Helm's ergonomics (values files, versioning, community charts) without Helm managing the release state in-cluster. This is my recommended pattern for prod — Argo shows drift, gives you the Git-is-source-of-truth guarantee, and lets you use community charts alongside your own.

If asked about hooks / lifecycle:

> Hooks are templates annotated with `helm.sh/hook: pre-install` (or pre-upgrade, post-delete, etc). They run at lifecycle events. The canonical use is a pre-upgrade Job that runs DB migrations before the new app Pods start. Hooks are separate from the main release resources — they aren't rolled back automatically if the main install fails. And they aren't idempotent unless you build them that way; a re-run creates a new Job.

Say the words: **chart / release / revision**, **values files per environment**, **Helm v3 client-only (no Tiller)**, **releases stored as Secrets**, **`helm template` for GitOps**, **CRDs are install-once**, **checksum annotations for ConfigMap changes**.
