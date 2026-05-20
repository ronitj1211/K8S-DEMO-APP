# Interview Questions — Helm

---

## Basic

### Q1. What's Helm?
The package manager for Kubernetes. A **chart** is a parameterized bundle of K8s YAML (Go templates + values). A **release** is one installed instance of a chart in a cluster. `helm install`, `helm upgrade`, `helm rollback`, `helm uninstall`.

### Q2. Chart vs release vs revision?
- **Chart** — the package (templates + default values). Stored in a repo.
- **Release** — one named installation of a chart in a cluster.
- **Revision** — a point-in-time version of a release. Every `upgrade` creates a new revision; `rollback` goes back to one.

### Q3. Standard chart layout?
```
mychart/
├── Chart.yaml              # metadata
├── values.yaml             # defaults
├── templates/
│   ├── _helpers.tpl        # template partials
│   ├── NOTES.txt           # printed after install
│   └── *.yaml              # K8s manifests with {{ ... }}
└── charts/                 # subchart dependencies
```

### Q4. How are values overridden?
Priority (highest wins):
1. `--set` on the CLI
2. `--set-file` / `--set-string`
3. `-f values-prod.yaml` (later `-f` wins over earlier)
4. `values.yaml` in the chart
5. Subchart defaults

### Q5. What's `_helpers.tpl`?
Templates beginning with `_` aren't rendered as manifests — they're library helpers you `include` from real templates. Common pattern: `{{ include "mychart.fullname" . }}` returns a release-scoped name.

### Q6. Helm v2 vs Helm v3?
- **v2** had Tiller — a server-side component with cluster-admin. Security nightmare.
- **v3** removed Tiller; client-side only. Releases stored as Secrets in the namespace. Default since 2019. **Always use v3.**

### Q7. What's `helm template`?
Renders the chart to stdout **without installing**. Useful for inspecting what would be applied, or for piping into `kubectl apply -f -` if you don't want Helm to track the release.

---

## Intermediate

### Q8. Helm lookup vs render?
- `helm template` — render only, no cluster.
- `helm install --dry-run --debug` — render and validate against the cluster's schema.
- The `lookup` template function lets the chart **query the cluster** during render. Use sparingly — it makes the chart non-reproducible.

### Q9. What's a `Chart.yaml` `apiVersion` value?
- `v1` — Helm 2 chart format.
- `v2` — Helm 3+ chart format (supports library charts, dependencies in `Chart.yaml`).

### Q10. What's a library chart vs application chart?
- **Application chart** (`type: application`) — what you install.
- **Library chart** (`type: library`) — only provides templates for other charts to `include`. Not installable on its own. Useful for sharing common K8s patterns across many apps.

### Q11. Hooks — what are they?
Templates annotated with `helm.sh/hook: pre-install` (or `pre-upgrade`, `post-delete`, etc.) that run at lifecycle events. Common: a Job that runs DB migrations on `pre-upgrade`. Hook templates are NOT part of the release's tracked resources — Helm cleans them up per `helm.sh/hook-delete-policy`.

### Q12. What's a subchart?
Charts listed under `dependencies` in `Chart.yaml`. `helm dependency update` pulls them into `charts/`. Subcharts are installed alongside the parent and can have their own values (overridden via `<subchart>.<key>` in the parent's values).

### Q13. How do you upgrade with care?
```bash
helm diff upgrade demo ./chart -f values-prod.yaml    # helm-diff plugin: see what changes
helm upgrade demo ./chart -f values-prod.yaml --atomic --timeout 5m
```
- `--atomic` — automatic rollback on failure.
- `--timeout` — abort if hooks / readiness don't complete in time.
- `--wait` — wait for all resources to be Ready before declaring success.

### Q14. Where is the release state stored?
As K8s Secrets (or ConfigMaps, configurable) in the release's namespace, with name `sh.helm.release.v1.<release>.v<revision>`. Each Secret holds a gzipped JSON blob of the release.

### Q15. How does Helm handle CRDs?
Templates under `crds/` (not `templates/crds/`) are installed once on `helm install` but **never upgraded or deleted** by Helm. This protects existing custom resources. To update CRDs, `kubectl apply` them manually or use a separate chart.

### Q16. What's `Chart.lock`?
Like `package-lock.json` for chart dependencies. Pins exact subchart versions so `helm dependency update` is reproducible. Commit it.

---

## Scenario-based

### S1. You install a chart and the rollout fails. What now?
Default Helm behavior on `helm install` failure: the release is left in `failed` state. With `--atomic`, Helm rolls back automatically. Without:
```bash
helm history my-release
helm rollback my-release 1    # back to revision 1
# or delete and start fresh
helm uninstall my-release
```

Investigate the failure: `kubectl describe` on the failed Pods; `helm get manifest my-release | kubectl apply --dry-run=server -f -` to validate.

### S2. Two teams' charts both create a `ConfigMap` named `app-config`. Collision.
Standard chart practice: name resources with `{{ .Release.Name }}-app-config` so each release gets its own. Most community charts do this via the `fullname` helper. If you're stuck importing a bad chart, use `--name-template` or fork the chart.

### S3. You want to share one chart across dev / staging / prod environments.
One chart, multiple values files:
```bash
helm upgrade --install demo ./chart -f values-dev.yaml -n dev
helm upgrade --install demo ./chart -f values-staging.yaml -n staging
helm upgrade --install demo ./chart -f values-prod.yaml -n prod
```
The chart is the source of truth for structure; the values files are the per-env knobs. Avoid `helm template ... | kubectl apply` in prod — you lose history/rollback.

### S4. The release exists but `helm list` doesn't show it.
- Wrong namespace: `helm list -A` lists all namespaces.
- Release stored in a ConfigMap not a Secret (`--driver=configmap`): `helm list --driver=configmap`.
- Filter applied: `helm list --all` includes Failed/Deleted.

### S5. You need to migrate a chart from Helm v2 to v3.
Two-step:
1. Install `helm-2to3` plugin.
2. `helm 2to3 convert <release>` — converts the release metadata.

Then `helm 2to3 cleanup` to remove Tiller. Tag your chart `apiVersion: v2` once on Helm 3.

### S6. CRDs in the chart get out of sync with the operator. How to upgrade?
Helm doesn't upgrade `crds/`. Either:
- Upgrade CRDs manually: `kubectl apply -f new-crds.yaml`.
- Re-install the chart (uninstall + install) — but `crds/` is still skipped on upgrade.
- Put CRDs in `templates/` (counter to Helm guidance) — they're tracked but can be `prune`d on uninstall, which is destructive.

Real solution: many charts now include a separate `crds-` Helm chart you upgrade explicitly when the operator releases new CRDs.

### S7. `helm install` fails with "release exists, but has no status".
Stale release record after a previous failed install. Clean it:
```bash
helm uninstall my-release         # if visible
kubectl delete secret -n <ns> sh.helm.release.v1.my-release.v1   # last resort
```
Then re-install.

### S8. How to do a canary with Helm?
Not built-in. Options:
- Install **two releases** (`demo-stable`, `demo-canary`) with different replica counts; share label selector; let the Service load-balance proportionally.
- Use **Argo Rollouts** or **Flagger** alongside Helm for proper traffic splitting.
- Service mesh (Istio) traffic splitting + Helm just for the manifests.
