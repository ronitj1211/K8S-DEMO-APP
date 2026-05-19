# Helm

## What is Helm?

**Helm** is the package manager for Kubernetes. A Helm **chart** is a parameterized bundle of YAML manifests, and a **release** is one specific install of a chart into a cluster with a specific set of values.

In short: Helm turns raw K8s YAML into reusable, configurable software packages.

```
Helm chart (templates + default values)
     │
     ├── helm install demo-dev   chart/ -f values.yaml         → release "demo-dev"
     ├── helm install demo-prod  chart/ -f values-prod.yaml    → release "demo-prod"
     └── helm install demo-stage chart/ --set backend.replicas=10
```

Same chart → many environments. The chart is the source of truth; values files are the per-environment knobs.

### What problems does Helm solve?

Without Helm, you usually have:

- A folder of YAMLs per environment, copy-pasted with minor edits.
- Hand-edited replica counts and image tags scattered everywhere.
- No version of "the whole release" to roll back to.

Helm gives you:

| Capability | What it means |
|------------|---------------|
| **Templating** | Manifests are Go templates with `{{ .Values.x }}` placeholders. |
| **Values files** | Environment-specific overrides (`values-dev.yaml`, `values-prod.yaml`). |
| **Releases** | A named install — Helm tracks every revision. |
| **Rollback** | `helm rollback demo 3` to flip back to revision 3. |
| **Dependencies** | Charts can depend on other charts (Redis, Postgres, etc). |
| **Registries** | Charts are published to repositories (OCI registries, Artifact Hub). |

---

## Key concepts

| Term | Meaning |
|------|---------|
| **Chart** | A directory with `Chart.yaml`, `values.yaml`, and `templates/`. |
| **Template** | A YAML file under `templates/` with Go template directives. |
| **Values** | Configuration for the templates — defaults in `values.yaml`, overrides via `-f` or `--set`. |
| **Release** | One installation of a chart. Named, namespaced, versioned. |
| **Revision** | A point-in-time version of a release. Every upgrade creates a new revision. |
| **Repository** | Where charts are published (HTTP repo or OCI registry). |
| **Hooks** | Templates that run at lifecycle events (pre-install, post-upgrade, etc.). |

---

## Standard chart layout

```
chart/
├── Chart.yaml              # metadata: name, version, appVersion
├── values.yaml             # default values
├── values-prod.yaml        # optional override file for prod
├── templates/
│   ├── _helpers.tpl        # template partials (define, include)
│   ├── NOTES.txt           # printed after install
│   ├── backend-deployment.yaml
│   ├── backend-service.yaml
│   ├── frontend-deployment.yaml
│   └── frontend-service.yaml
└── charts/                 # subchart dependencies (none here)
```

---

## What's in this folder

```
helm/
├── backend/                # same Node.js backend as other concepts
│   ├── server.js, package.json, Dockerfile
├── frontend/               # same nginx + HTML frontend
│   ├── index.html, Dockerfile
├── chart/
│   ├── Chart.yaml
│   ├── values.yaml         # defaults (dev-ish)
│   ├── values-prod.yaml    # production overrides
│   └── templates/
│       ├── _helpers.tpl
│       ├── NOTES.txt
│       ├── backend-deployment.yaml
│       ├── backend-service.yaml
│       ├── frontend-deployment.yaml
│       └── frontend-service.yaml
└── README.md
```

---

## Prerequisites

- Docker, `kubectl`, local cluster.
- **Helm v3** installed:

```bash
# macOS
brew install helm

# verify
helm version
```

---

## How to run

### 1. Build images

```bash
eval $(minikube docker-env)   # minikube only

cd backend  && docker build -t k8s-demo-backend:1.0 .
cd ../frontend && docker build -t k8s-demo-frontend:1.0 .
```

For kind:

```bash
kind load docker-image k8s-demo-backend:1.0
kind load docker-image k8s-demo-frontend:1.0
```

### 2. Lint and preview

From the `helm/` folder:

```bash
helm lint ./chart
helm template demo ./chart                       # render to stdout (no install)
helm template demo ./chart -f chart/values-prod.yaml   # preview prod
```

### 3. Install (dev defaults)

```bash
helm install demo ./chart
```

Helm prints the rendered `NOTES.txt` after install. List + inspect:

```bash
helm list
helm status demo
kubectl get all -l app.kubernetes.io/instance=demo
```

Hit it:

```bash
curl http://$(minikube ip):30086
open http://$(minikube ip):30087
```

### 4. Install a second release with prod values

```bash
helm install demo-prod ./chart -f chart/values-prod.yaml
```

Now you have **two releases** of the same chart side by side — `demo` and `demo-prod` — on different node ports, with different replica counts and different `GREETING`.

```bash
helm list
curl http://$(minikube ip):30086    # demo (dev)
curl http://$(minikube ip):30186    # demo-prod
```

### 5. Upgrade with a one-off override

```bash
helm upgrade demo ./chart --set backend.replicas=5
kubectl get pods -l app.kubernetes.io/instance=demo
```

### 6. Rollback

```bash
helm history demo
helm rollback demo 1
```

### 7. Uninstall

```bash
helm uninstall demo
helm uninstall demo-prod
```

---

## Templating quick reference

Inside `templates/*.yaml`, you can use:

```yaml
# Substitute a value:
replicas: {{ .Values.backend.replicas }}

# Conditionally include a field:
{{- if eq .Values.backend.service.type "NodePort" }}
nodePort: {{ .Values.backend.service.nodePort }}
{{- end }}

# Loop over a map of env vars:
{{- range $k, $v := .Values.backend.env }}
- name: {{ $k }}
  value: {{ $v | quote }}
{{- end }}

# Use a named partial:
{{ include "k8s-demo.labels" (merge (dict "component" "backend") .) | nindent 4 }}
```

Built-in objects you can reach:

| Object | What it gives you |
|--------|-------------------|
| `.Values` | The merged values (`values.yaml` + overrides). |
| `.Release` | `.Release.Name`, `.Release.Namespace`, `.Release.Revision`. |
| `.Chart` | Fields from `Chart.yaml`. |
| `.Files` | Read any file in the chart. |
| `.Capabilities` | Cluster info: K8s version, API versions. |

Pipes (`|`) chain transforms: `quote`, `nindent 4`, `default "x"`, `toYaml`, etc.

---

## Using community charts

You don't have to write your own. Most popular software has a chart:

```bash
helm repo add bitnami https://charts.bitnami.com/bitnami
helm repo update
helm search repo redis
helm install my-redis bitnami/redis --set auth.password=secret
```

Browse charts at <https://artifacthub.io>.

---

## Useful commands

```bash
helm lint ./chart
helm template demo ./chart -f chart/values-prod.yaml > rendered.yaml
helm install demo ./chart --dry-run --debug
helm install demo ./chart
helm upgrade demo ./chart --set backend.replicas=4
helm history demo
helm rollback demo 2
helm get values   demo               # values used by the live release
helm get manifest demo               # the actual rendered manifests
helm uninstall demo
helm list -A                          # all releases in all namespaces
```

---

## Key takeaways

1. **A chart is a package**; a **release is an install of that package** with specific values.
2. The same chart deploys to many environments by swapping the **values file**.
3. Helm tracks revisions — `helm rollback` is the equivalent of `kubectl rollout undo` but for the whole release.
4. Use `helm template` / `--dry-run` to **preview** what Helm will create before installing.
5. Don't hand-write everything — community charts cover most off-the-shelf software (databases, ingress controllers, monitoring).

**Previous:** [daemonsets](../daemonsets/) · Back to [course index](../README.md)
