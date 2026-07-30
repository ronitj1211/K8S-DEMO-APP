# Helm — Internals

Chart rendering pipeline, release storage, upgrade diffing, v3 vs v2 architecture.

---

## Purpose

Helm turns raw K8s YAML into reusable, parameterized packages. It handles templating (Go templates + values), install/upgrade/rollback state tracking, and versioned deploys.

## v3 vs v2 — architectural shift

**Helm v2 (2015-2019)** had a server-side component called **Tiller**, running in the cluster with (usually) cluster-admin privileges. Every `helm` command talked to Tiller via gRPC; Tiller talked to the K8s API. Release state stored in Tiller's namespace as ConfigMaps.

**Security nightmare**: anyone with `helm` CLI could deploy anything anywhere.

**Helm v3 (Nov 2019+)**:
- No Tiller. Helm is now a **client-only** tool.
- Talks directly to the K8s API using your kubeconfig.
- Standard K8s RBAC applies.
- Release state stored as **Secrets** in the release's own namespace.

Always Helm v3 in 2026. If you find a Tiller install, migrate with `helm 2to3`.

## Chart anatomy

```
mychart/
├── Chart.yaml                     # metadata (name, version, appVersion)
├── values.yaml                    # default values
├── values-prod.yaml               # optional environment override files
├── templates/
│   ├── _helpers.tpl              # partial templates (starts with _)
│   ├── NOTES.txt                 # printed after install
│   ├── deployment.yaml           # Go-template YAML for a Deployment
│   ├── service.yaml
│   └── ...
├── crds/                          # CRDs installed on first install, NOT upgraded
├── charts/                        # subchart dependencies (as extracted tarballs)
└── Chart.lock                     # locks subchart versions
```

## Rendering — how templates become K8s YAML

The pipeline:

1. **Merge values**: `values.yaml` + `-f values-prod.yaml` (later wins) + `--set foo=bar` (highest priority).
2. **Load templates**: read every file under `templates/*` (excluding `_*.tpl` partials, which are only for `include`).
3. **Execute templates**: for each template file, run through Go's text/template with the merged values as context (`.Values.*`), plus:
   - `.Release.*` — Name, Namespace, Service, IsInstall, IsUpgrade, Revision.
   - `.Chart.*` — Chart.yaml contents (Name, Version, AppVersion).
   - `.Files.*` — access to non-template files (via `.Get`).
   - `.Capabilities.*` — cluster K8s version, available APIs.
4. **Concat output**: all rendered files → one big YAML stream, separated by `---`.
5. **Post-render** (optional): if `--post-renderer` is used, pipe the YAML through an external tool for final tweaks. Common with Kustomize-based patching.

The rendered YAML is what actually goes to the K8s API.

## `helm template` — dry-render

```bash
helm template my-release ./chart -f values-prod.yaml
```

Renders to stdout. No cluster interaction. Useful for:
- Debugging templates.
- Piping into `kubectl apply -f -` if you don't want Helm's release tracking (Argo CD does this).
- Diffing against the current live state (`helm diff upgrade`).

## Release storage — the Secret

Every install creates a Secret:

```
name: sh.helm.release.v1.<release>.v<revision>
type: helm.sh/release.v1
```

Content: a gzipped, base64-encoded JSON blob containing:
- The rendered manifests.
- The values used.
- The chart metadata.
- Deployment status (deployed/failed/pending).

Each upgrade creates a new Secret (v2, v3, ...). Old ones stay for rollback history (up to `--history-max` items, default 10).

Inspect:

```bash
kubectl get secret sh.helm.release.v1.my-release.v1 -o yaml
# The .data.release field is (base64-decoded → gunzipped → JSON) the release object
```

## Upgrade — how the diff works

`helm upgrade my-release ./chart`:

1. **Fetch current release**: read the current Secret, extract rendered manifests.
2. **Render new manifests**: from the (possibly updated) chart + values.
3. **Compute the 3-way merge**:
   - The current live state (queried from the K8s API).
   - The previous manifest (from the Secret).
   - The new manifest.
4. **Apply the diff**: for each resource, decide create/update/delete via strategic-merge-patch. Deletions happen for resources present in the previous release but not in the new one.
5. **Wait** (if `--wait`): poll each resource until it's in a stable state (Deployment: `AVAILABLE`; Job: `SUCCEEDED`).
6. **Write new Secret**: on success. On failure, if `--atomic`, roll back to the previous revision.

## Rollback

`helm rollback my-release 2` → apply the manifests from Secret `v2`. Under the hood: same 3-way merge, this time targeting the older revision. Result is a *new* revision (v3+1) that has v2's content.

**Idempotent**: rolling back to v2 twice produces the same result.

## `--atomic` and `--wait`

- `--atomic`: on failure, auto-rollback. Combines `--wait` + rollback-on-failure.
- `--wait`: block until all resources are Ready.
- `--wait-for-jobs`: also wait for any Jobs to complete (default `--wait` doesn't).
- `--timeout 5m`: max wait time.

Best-practice `helm upgrade` in CI:

```bash
helm upgrade --install my-release ./chart \
  -f values-prod.yaml \
  --namespace prod \
  --atomic \
  --wait \
  --timeout 10m
```

## Hooks

Templates annotated with `helm.sh/hook: <lifecycle-event>` are treated separately from the main release:

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: migrate
  annotations:
    "helm.sh/hook": pre-upgrade
    "helm.sh/hook-delete-policy": before-hook-creation,hook-succeeded
spec:
  # ...
```

**Hook events**:
- `pre-install`, `post-install`
- `pre-upgrade`, `post-upgrade`
- `pre-delete`, `post-delete`
- `pre-rollback`, `post-rollback`
- `test` — only runs on `helm test`

**Delete policies**:
- `before-hook-creation` — delete the resource before creating a new one on the next hook.
- `hook-succeeded` — delete after successful completion.
- `hook-failed` — delete on failure.

Common use: `pre-upgrade` Job that runs a DB migration. If the migration fails, the whole upgrade aborts (with `--atomic`).

**Important**: hooks are NOT part of the release's resource set. `helm uninstall` doesn't delete them (unless a `post-delete` hook does). You manage their lifecycle via `hook-delete-policy`.

## CRDs — a special case

Templates under `crds/` (not `templates/crds/`) are treated specially:
- Installed on **first** install.
- **Not upgraded** on subsequent `helm upgrade`.
- **Not deleted** on `helm uninstall`.

Reason: CRDs often have `status` subresource and finalizers. Modifying them mid-flight can corrupt custom resources of that type.

**Consequence**: to update CRDs when the operator releases a new version, apply them separately:
```bash
kubectl apply -f new-crds.yaml
helm upgrade my-operator ./chart
```

Or put CRDs in a separate CRD-only chart the ops team upgrades explicitly.

## Values file precedence

Highest to lowest:
1. `--set` CLI overrides.
2. `--set-string`, `--set-file`, `--set-json`.
3. `-f` files, in the order given (later overrides earlier).
4. Chart's own `values.yaml`.
5. Subchart's `values.yaml` (only if the parent doesn't override).

## Subcharts

`Chart.yaml`:
```yaml
dependencies:
  - name: redis
    version: "17.11.3"
    repository: https://charts.bitnami.com/bitnami
    condition: redis.enabled
```

`helm dependency update` downloads the subchart's tarball into `charts/redis-*.tgz`.

**Values for subcharts** go under the subchart name in the parent's values:

```yaml
# parent values.yaml
redis:
  enabled: true
  master:
    persistence:
      size: 10Gi
```

`condition: redis.enabled` — the subchart is only installed if the parent's `values.redis.enabled == true`.

## Library charts

`Chart.yaml`: `type: library`. Not installable on its own. Provides templates for other charts to `include`:

```yaml
# my-lib/templates/_common-labels.tpl
{{- define "common.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
```

Consumer chart:
```yaml
labels:
  {{- include "common.labels" . | nindent 4 }}
```

DRY across many charts.

## Common template functions

- `{{ .Values.image }}` — access values.
- `{{ .Values.replicas | default 3 }}` — default if unset.
- `{{ include "mychart.fullname" . }}` — invoke a partial (from `_helpers.tpl`).
- `{{ toYaml .Values.env | nindent 12 }}` — dump a map as YAML with indentation.
- `{{ .Values.tag | quote }}` — string quoting.
- `{{ if .Values.enabled }}...{{ end }}` — conditional.
- `{{ range .Values.items }}...{{ end }}` — loop.
- `{{ printf "%s-%s" .Release.Name .Chart.Name }}` — sprintf.

## Debugging templates

```bash
# Render + print (no apply)
helm template my-release ./chart

# Render with debug info (shows values in comments)
helm template my-release ./chart --debug

# Render + validate against a cluster (server dry-run)
helm install my-release ./chart --dry-run --debug

# Diff current vs new (requires helm-diff plugin)
helm diff upgrade my-release ./chart
```

## Argo CD + Helm

Argo CD doesn't run `helm install`. It uses `helm template` to render, then applies the raw YAML itself. Argo owns the release state; Helm just provides templating.

Consequence: `helm list` won't show Argo-managed releases. Use `argocd app list` instead.

---

## The 30-second summary

- Helm v3 is client-only (no Tiller); release state stored as Secrets in the release namespace.
- Chart = templates + defaults; values files override; `helm upgrade --install --atomic --wait` is the go-to for CI.
- Rendering: Go templates + values → YAML → API. Debug with `helm template` or `--dry-run`.
- Upgrade uses a 3-way merge (previous manifest, new manifest, live state).
- Hooks (`pre-upgrade` Job) run outside the main resource set — great for migrations.
- CRDs in `crds/` are install-once and never upgraded by Helm — manage them separately.
- Argo CD uses `helm template` (not `helm install`), so Helm and Argo can coexist safely.
