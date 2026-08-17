# Config Guide — which file does what

Every file in this project, what it configures, what breaks without it, and how to check it. Use the **"I want to change X" table** at the bottom as the day-to-day lookup.

---

## The numbering scheme

Files in [stack/](stack/) are prefixed with numbers that encode **apply order and grouping**:

| Prefix | Group | Why it's in that position |
|---|---|---|
| `00-` | Namespace | Must exist before anything can be created in it |
| `10-13` | Prometheus | RBAC → config → rules → workload. Config must exist before the Deployment mounts it |
| `20-` | Alertmanager | Prometheus references it, but only at runtime, so order isn't strict |
| `30-31` | Exporters | Independent; Prometheus discovers them whenever they appear |
| `40-42` | Grafana | Provisioning → dashboards → workload. Same rule: ConfigMaps before the Deployment |

`kubectl apply -f stack/` processes files in filename order, so the numbering makes a single command work. The only *hard* dependencies are the namespace, and ConfigMaps existing before the pods that mount them — a pod whose ConfigMap is missing stays `ContainerCreating` until it appears.

---

## Quick reference — all 12 manifests

| File | Objects | Configures | Without it |
|---|---|---|---|
| [00-namespace.yaml](stack/00-namespace.yaml) | Namespace | The `monitoring` namespace | Everything else fails to apply |
| [10-prometheus-rbac.yaml](stack/10-prometheus-rbac.yaml) | ServiceAccount, ClusterRole, ClusterRoleBinding | **Permission to discover targets** | Targets page is empty — silently |
| [11-prometheus-config.yaml](stack/11-prometheus-config.yaml) | ConfigMap | **What to scrape and how often** | Prometheus scrapes nothing |
| [12-prometheus-rules.yaml](stack/12-prometheus-rules.yaml) | ConfigMap | Recording + alerting rules | No alerts, no precomputed series, dashboards break |
| [13-prometheus.yaml](stack/13-prometheus.yaml) | Deployment, Service | The Prometheus **process** and how you reach it | No Prometheus |
| [20-alertmanager.yaml](stack/20-alertmanager.yaml) | ConfigMap, Deployment, Service | Alert grouping, routing, delivery | Alerts fire but nobody is told |
| [30-node-exporter.yaml](stack/30-node-exporter.yaml) | DaemonSet, Service | **Host** metrics collection, one pod per node | No `node_*` metrics |
| [31-kube-state-metrics.yaml](stack/31-kube-state-metrics.yaml) | SA, ClusterRole, CRB, Deployment, Service | **Kubernetes object state** metrics | No `kube_*` metrics; K8s alerts never fire |
| [40-grafana-provisioning.yaml](stack/40-grafana-provisioning.yaml) | ConfigMap | Grafana's **datasources** + dashboard loader | Grafana starts empty, no connection to Prometheus |
| [41-grafana-dashboards.yaml](stack/41-grafana-dashboards.yaml) | ConfigMap | The two dashboards, as JSON | Grafana works but has no dashboards |
| [42-grafana.yaml](stack/42-grafana.yaml) | Deployment, Service | The Grafana **process**, mounts, admin login | No Grafana |
| [app/app.yaml](app/app.yaml) | Namespace, 2 Deployments, Service | The app being monitored + traffic generator | Nothing to monitor |

---

## The key idea: two levels of configuration

This trips people up constantly. There are **Kubernetes manifests**, and there is **application config living inside those manifests as ConfigMaps**. They are edited differently and take effect differently.

```
  11-prometheus-config.yaml          ← a Kubernetes ConfigMap (kubectl apply)
     └── data:
           prometheus.yml: |         ← Prometheus's OWN config format (not K8s at all)
             global:
               scrape_interval: 15s
                    ▲
                    │ mounted as a file
                    ▼
  13-prometheus.yaml                 ← the Deployment that mounts it
     volumeMounts: /etc/prometheus
     args: --config.file=/etc/prometheus/prometheus.yml
```

So `prometheus.yml` is **not Kubernetes YAML** — it's Prometheus's config, wrapped in a ConfigMap so Kubernetes can deliver it as a file. The same pattern applies to `alertmanager.yml`, the Grafana provisioning YAML, and the dashboard JSON.

**Consequence:** a syntax error inside those embedded blocks is invisible to `kubectl apply` — it validates the ConfigMap, not its contents. The pod applies it and crashes or ignores it. That's why the [Jenkinsfile](Jenkinsfile) has a separate `promtool check rules` stage.

| Embedded config | Lives in | Format | Consumed by |
|---|---|---|---|
| `prometheus.yml` | 11-prometheus-config.yaml | Prometheus config | Prometheus, via `--config.file` |
| `recording.yml`, `alerts.yml` | 12-prometheus-rules.yaml | Prometheus rules | Prometheus, via `rule_files:` glob |
| `alertmanager.yml` | 20-alertmanager.yaml | Alertmanager config | Alertmanager, via `--config.file` |
| `datasources.yaml`, `dashboards.yaml` | 40-grafana-provisioning.yaml | Grafana provisioning | Grafana, scanned at startup |
| `red-dashboard.json`, `cluster-dashboard.json` | 41-grafana-dashboards.yaml | Grafana dashboard JSON | Grafana, via the file provider |

---

## File-by-file

### [stack/00-namespace.yaml](stack/00-namespace.yaml) — 4 lines

Creates the `monitoring` namespace. The `demo` namespace is created by [app/app.yaml](app/app.yaml) instead, so the app is deployable on its own.

---

### [stack/10-prometheus-rbac.yaml](stack/10-prometheus-rbac.yaml) — 44 lines

**Required for:** Prometheus being *allowed* to ask the API server what exists.

Three objects: a ServiceAccount, a ClusterRole granting `get/list/watch` on nodes, services, endpoints and pods (plus `nodes/proxy`, `nodes/metrics`, and `nonResourceURLs: ["/metrics", "/metrics/cadvisor"]`), and the binding between them.

It must be **Cluster**Role, not Role — Prometheus discovers targets across *all* namespaces, and a namespaced Role can't do that.

The Deployment consumes it via `serviceAccountName: prometheus` ([13-prometheus.yaml:22](stack/13-prometheus.yaml)).

> **Failure mode:** service discovery returns nothing and the targets page is empty, with **no error in the UI**. Always check:
> ```bash
> kubectl logs -n monitoring deploy/prometheus | grep -i forbidden
> ```

---

### [stack/11-prometheus-config.yaml](stack/11-prometheus-config.yaml) — 143 lines

**Required for:** *what* Prometheus scrapes, *how often*, where alerts go, and where rules are loaded from. The most-edited file in the project.

| Block | Line | Controls |
|---|---|---|
| `global.scrape_interval` | 9 | How often every target is pulled (15s) |
| `global.evaluation_interval` | 10 | How often rules are evaluated |
| `global.external_labels` | 11-12 | Labels stamped on data leaving this server (matters for federation/Thanos) |
| `alerting.alertmanagers` | 15-18 | Where firing alerts are pushed |
| `rule_files` | 21-22 | Glob for rule files — must match the mount path in the Deployment |
| `scrape_configs` | 24+ | The six scrape jobs |

The six jobs and what each gives you:

| Job | Line | Discovery | Produces |
|---|---|---|---|
| `prometheus` | 29 | static | Prometheus's own health |
| `kubernetes-pods` | 38 | `role: pod` + annotations | Your application metrics |
| `node-exporter` | 77 | `role: endpoints` | `node_*` host metrics |
| `kube-state-metrics` | 93 | `role: endpoints` | `kube_*` object state |
| `kubernetes-nodes` | 104 | `role: node` via API proxy | kubelet metrics |
| `kubernetes-cadvisor` | 127 | `role: node` via API proxy | `container_*` usage |

**Edit this file when:** adding a scrape job, changing scrape frequency, pointing at a different Alertmanager, or filtering which metrics get stored (`metric_relabel_configs`).

> `rule_files: /etc/prometheus/rules/*.yml` must match the `mountPath` at [13-prometheus.yaml:42](stack/13-prometheus.yaml). Change one without the other and rules silently stop loading.

---

### [stack/12-prometheus-rules.yaml](stack/12-prometheus-rules.yaml) — 182 lines

**Required for:** alerts existing at all, and for the precomputed series the dashboards use.

Two keys, which become two files in `/etc/prometheus/rules/`:

- **`recording.yml`** — 5 rules precomputing request rate, error rate, error ratio, p95 and p99. Named `service:metric:operation`.
- **`alerts.yml`** — 11 alerts in four groups:

| Group | Alerts | Built on |
|---|---|---|
| `application.alerts` | HighErrorRate, HighLatencyP95, NoTrafficReceived | The recording rules |
| `monitoring.alerts` | TargetDown | `up` |
| `kubernetes.alerts` | PodCrashLooping, PodNotReady, DeploymentReplicasMismatch, ContainerMemoryNearLimit | `kube_*` + `container_*` |
| `node.alerts` | NodeHighCPU, NodeLowMemory, NodeDiskFillingUp | `node_*` |

**Edit this file when:** adding or tuning an alert, changing a threshold or `for:` duration, or adding a recording rule.

> The dashboards query the recording rules by name (`service:http_error_ratio:rate5m`). Rename a recording rule here and the corresponding Grafana panel goes blank — [41-grafana-dashboards.yaml](stack/41-grafana-dashboards.yaml) must be updated to match.

---

### [stack/13-prometheus.yaml](stack/13-prometheus.yaml) — 81 lines

**Required for:** the Prometheus process itself.

| Setting | Line | Why it matters |
|---|---|---|
| `strategy: Recreate` | 12-13 | Two pods sharing one TSDB volume would corrupt it |
| `serviceAccountName` | 22 | Links to the RBAC in file 10 |
| `--config.file` | 31 | Where it reads config from — must match the mount |
| `--storage.tsdb.retention.time` | 33 | 6h here; 15d+ in production |
| `--web.enable-lifecycle` | 34 | Enables `POST /-/reload` for hot config reloads |
| volume mounts | 38-44 | Wires the two ConfigMaps and the data dir into the container |
| `emptyDir` for data | 63-64 | **All metrics are lost on pod restart** — demo only |
| Service nodePort 30090 | 81 | How you reach the UI |

**Edit this file when:** changing retention, adding a PVC for persistence, adjusting resources, or bumping the Prometheus version.

---

### [stack/20-alertmanager.yaml](stack/20-alertmanager.yaml) — 115 lines

**Required for:** alerts actually reaching a human. Prometheus decides *what* is wrong; this decides *who is told, how often, and grouped with what*.

Contains all three pieces in one file — the ConfigMap, Deployment, and Service.

Inside `alertmanager.yml`:

| Block | Controls |
|---|---|
| `route.group_by` | Which labels collapse many alerts into one notification |
| `route.group_wait` | Delay before sending a new group (10s) |
| `route.group_interval` | Gap before sending an *updated* group (30s) |
| `route.repeat_interval` | Gap before re-sending an *unchanged* group (1h) |
| `route.routes` | The child routing tree — `severity=critical` gets its own receiver |
| `inhibit_rules` | Suppress warnings when a critical for the same thing is firing |
| `receivers` | Where notifications go — here, a webhook to the demo app |

**Edit this file when:** adding Slack/PagerDuty, changing who gets paged for what severity, or tuning notification frequency.

> In production, replace the webhook receivers with `slack_configs` / `pagerduty_configs`, and put the API keys in a **Secret**, not this ConfigMap.

---

### [stack/30-node-exporter.yaml](stack/30-node-exporter.yaml) — 74 lines

**Required for:** every `node_*` metric — host CPU, memory, disk, network.

| Setting | Line | Why |
|---|---|---|
| `kind: DaemonSet` | 6 | Exactly one pod per node, automatically including new nodes |
| `hostNetwork: true` | 21 | Pod IP becomes the node IP |
| `hostPID: true` | 22 | Sees host processes |
| `tolerations: operator: Exists` | 24-25 | Runs on tainted control-plane nodes too |
| `--path.procfs/sysfs/rootfs` | 30-32 | **Tells it to read the mounted host paths** |
| hostPath volumes | 53-58 | Mounts the node's real `/proc`, `/sys`, `/` |
| `clusterIP: None` | 68 | Headless — so each pod is its own scrape target |

**Both halves are required.** Mounting the volumes without the `--path.*` args gives you a node-exporter reporting its own container — a few MB of memory, no real disks — that looks perfectly healthy and is completely wrong.

**Edit this file when:** enabling/disabling collectors, excluding filesystem mount points, or changing resource limits.

---

### [stack/31-kube-state-metrics.yaml](stack/31-kube-state-metrics.yaml) — 121 lines

**Required for:** every `kube_*` metric — and therefore for the entire `kubernetes.alerts` group.

Self-contained: its own ServiceAccount, ClusterRole (a long list of `list`/`watch` grants on pods, deployments, nodes, PVCs, HPAs, PDBs and more), binding, Deployment, and headless Service.

It does **not** read any node. It watches the API server and translates object state into metrics.

**Edit this file when:** kube-state-metrics needs to watch a resource type not in the ClusterRole (a new CRD, for example), or to restrict which namespaces it watches.

> If `kube_*` queries return nothing, check this pod's RBAC first — it needs its own permissions, entirely separate from Prometheus's.

---

### [stack/40-grafana-provisioning.yaml](stack/40-grafana-provisioning.yaml) — 45 lines

**Required for:** Grafana knowing that Prometheus exists, and knowing where to find dashboards.

Two keys mounted into two **different directories**:

| Key | Mounted at | Declares |
|---|---|---|
| `datasources.yaml` | `/etc/grafana/provisioning/datasources/` | The Prometheus and Alertmanager datasources |
| `dashboards.yaml` | `/etc/grafana/provisioning/dashboards/` | A *file provider* pointing at `/var/lib/grafana/dashboards` |

The split matters: Grafana scans each provisioning directory for **all** YAML files, so a datasource file sitting in the dashboards directory is a startup error. That's why [42-grafana.yaml:59-68](stack/42-grafana.yaml) mounts them with explicit `items:` rather than mounting the whole ConfigMap twice.

| Setting | Line | Why |
|---|---|---|
| `url: http://prometheus.monitoring.svc:9090` | 18 | The Service DNS name — resolved inside the cluster |
| `access: proxy` | 17 | Grafana's backend queries Prometheus, not your browser |
| `timeInterval: 15s` | 21 | Should match `scrape_interval`; drives `$__rate_interval` |
| `options.path` | 44 | **Must equal the dashboards `mountPath`** in file 42 |

**Edit this file when:** adding a datasource (Loki, CloudWatch, Elasticsearch) or changing where dashboards are loaded from.

---

### [stack/41-grafana-dashboards.yaml](stack/41-grafana-dashboards.yaml) — 309 lines

**Required for:** having dashboards. Purely content — two dashboard JSON documents.

| Dashboard | UID | Panels | Shows |
|---|---|---|---|
| `red-dashboard.json` | `demo-api-red` | 10 | Request rate, error ratio, p50/p95/p99, rate by route, per-pod distribution, business orders, in-flight |
| `cluster-dashboard.json` | `cluster-health` | 7 | Node CPU/memory, container CPU/memory, restarts, replicas desired vs available, targets up |

**Edit this file when:** adding or changing a panel. The practical workflow is: edit in the Grafana UI → **Dashboard settings → JSON Model** → copy → paste back into this ConfigMap → apply. That keeps Git as the source of truth.

> Keep the `uid` stable across edits — it's what links people to the dashboard.

---

### [stack/42-grafana.yaml](stack/42-grafana.yaml) — 92 lines

**Required for:** the Grafana process, and for the two ConfigMaps above actually reaching it.

| Setting | Line | Why |
|---|---|---|
| `GF_SECURITY_ADMIN_USER/PASSWORD` | 29-32 | Login (`admin`/`admin`) — **use a Secret in production** |
| `GF_USERS_ALLOW_SIGN_UP: "false"` | 33-34 | No self-registration |
| `GF_DASHBOARDS_DEFAULT_HOME_DASHBOARD_PATH` | 35-37 | Lands on the RED dashboard instead of an empty home page |
| Three mounts | 39-46 | datasources dir, dashboards-provider dir, dashboard JSON dir |
| `fsGroup: 472` | 18-21 | Grafana's UID — without it the container can't read its own files |
| Service nodePort 30030 | 92 | How you reach the UI |

**Edit this file when:** changing credentials, enabling OIDC/SSO, adding plugins, or adding a PVC so UI-created content survives restarts.

---

### [app/app.yaml](app/app.yaml) — 103 lines

**Required for:** having something to monitor.

Four objects: the `demo` namespace, the demo-api Deployment (3 replicas), its NodePort Service, and the loadgen Deployment.

The three lines that matter most for monitoring are the **annotations on the pod template** ([:26-28](app/app.yaml)):

```yaml
prometheus.io/scrape: "true"
prometheus.io/path: "/metrics"
prometheus.io/port: "3000"
```

Those are the entire contract with Prometheus. **They must be on the pod template (`spec.template.metadata`), not on the Deployment** — Prometheus discovers pods, and an annotation on the Deployment object is never seen. Also note `"true"` must be a **quoted string**; unquoted, YAML parses it as a boolean and the `keep` regex won't match.

**Edit this file when:** scaling replicas, changing probes or resources, or adding another app to monitor.

---

## Non-manifest files

| File | Purpose |
|---|---|
| [app/server.js](app/server.js) | The instrumented app — defines every custom metric, and the `/alerts` webhook receiver |
| [app/package.json](app/package.json) | `express` + `prom-client` (the Prometheus client library) |
| [app/Dockerfile](app/Dockerfile) | Builds `demo-api:1.0` |
| [Jenkinsfile](Jenkinsfile) | CI: lint manifests, `promtool check rules`, build, deploy, then **verify targets are up and rules loaded** |
| [README.md](README.md) | Concepts, architecture, requirements, PromQL, cardinality |
| [HOW_IT_CONNECTS.md](HOW_IT_CONNECTS.md) | Every hop traced to its config line |
| [RUN-STEPS.md](RUN-STEPS.md) | Hands-on walkthrough |
| [INTERNALS.md](INTERNALS.md) | Scrape lifecycle, TSDB, relabeling, alert state machine |
| [INTERVIEW.md](INTERVIEW.md) | 36 Q&A |

---

## "I want to change X" → edit this file

| I want to… | Edit | Then |
|---|---|---|
| Monitor a **new application** | that app's manifest — add the 3 `prometheus.io/*` annotations | nothing; discovered automatically |
| Scrape **more/less often** | [11-prometheus-config.yaml](stack/11-prometheus-config.yaml) `scrape_interval` | reload Prometheus |
| Add a **scrape job** for something outside K8s | [11-prometheus-config.yaml](stack/11-prometheus-config.yaml) `scrape_configs` | reload Prometheus |
| **Drop a noisy metric** to save memory | [11-prometheus-config.yaml](stack/11-prometheus-config.yaml) `metric_relabel_configs` | reload Prometheus |
| Add or tune an **alert** | [12-prometheus-rules.yaml](stack/12-prometheus-rules.yaml) | reload Prometheus |
| Add a **recording rule** | [12-prometheus-rules.yaml](stack/12-prometheus-rules.yaml) | reload Prometheus |
| Send alerts to **Slack/PagerDuty** | [20-alertmanager.yaml](stack/20-alertmanager.yaml) `receivers` | restart Alertmanager |
| Change **who gets paged** for what severity | [20-alertmanager.yaml](stack/20-alertmanager.yaml) `route` | restart Alertmanager |
| **Silence** an alert temporarily | Alertmanager UI at :30093 — *not* a file | — |
| Keep metrics **longer** | [13-prometheus.yaml](stack/13-prometheus.yaml) `--storage.tsdb.retention.time` | restart Prometheus |
| Make metrics **survive restarts** | [13-prometheus.yaml](stack/13-prometheus.yaml) — swap `emptyDir` for a PVC | restart Prometheus |
| Add/modify a **dashboard panel** | [41-grafana-dashboards.yaml](stack/41-grafana-dashboards.yaml) | Grafana reloads within 30s |
| Add a **datasource** (Loki, CloudWatch) | [40-grafana-provisioning.yaml](stack/40-grafana-provisioning.yaml) | restart Grafana |
| Change the **Grafana password** | [42-grafana.yaml](stack/42-grafana.yaml) env vars — better, a Secret | restart Grafana |
| Collect a **new host metric** | [30-node-exporter.yaml](stack/30-node-exporter.yaml) — enable the collector | restart the DaemonSet |
| Watch a **new K8s resource type** | [31-kube-state-metrics.yaml](stack/31-kube-state-metrics.yaml) ClusterRole | restart KSM |
| **Scale** the demo app | [app/app.yaml](app/app.yaml) `replicas` | nothing; new pods discovered automatically |
| Add a **custom application metric** | [app/server.js](app/server.js) | rebuild the image |

### Applying a change

```bash
# ConfigMap-only changes (config, rules, dashboards) — no restart needed
kubectl apply -f stack/12-prometheus-rules.yaml
# mounted ConfigMaps refresh in up to ~60s, then hot-reload:
kubectl exec -n monitoring deploy/prometheus -- wget -qO- --post-data='' http://localhost:9090/-/reload

# Alertmanager has no lifecycle endpoint enabled here, so restart it:
kubectl rollout restart -n monitoring deploy/alertmanager

# Grafana dashboards are re-read automatically (updateIntervalSeconds: 30).
# Datasource changes need a restart:
kubectl rollout restart -n monitoring deploy/grafana
```

---

## Cross-file dependencies

These are the couplings that break silently if you change one side only:

| If you change… | You must also update… | Otherwise |
|---|---|---|
| `rule_files` glob ([11](stack/11-prometheus-config.yaml)) | the rules `mountPath` ([13:42](stack/13-prometheus.yaml)) | Rules never load |
| `--config.file` ([13:31](stack/13-prometheus.yaml)) | the config `mountPath` ([13:40](stack/13-prometheus.yaml)) | Prometheus won't start |
| A recording rule **name** ([12](stack/12-prometheus-rules.yaml)) | the panels that query it ([41](stack/41-grafana-dashboards.yaml)) and any alert using it | Blank panels, dead alerts |
| Dashboard provider `path` ([40:44](stack/40-grafana-provisioning.yaml)) | the dashboards `mountPath` ([42:44](stack/42-grafana.yaml)) | No dashboards appear |
| Alertmanager Service name/port ([20](stack/20-alertmanager.yaml)) | `alerting.alertmanagers` ([11:15-18](stack/11-prometheus-config.yaml)) | Alerts fire but go nowhere |
| The app's metrics **port** ([app/app.yaml](app/app.yaml)) | the `prometheus.io/port` annotation | Target `DOWN`, connection refused |
| Metric **names** in [server.js](app/server.js) | rules ([12](stack/12-prometheus-rules.yaml)) and dashboards ([41](stack/41-grafana-dashboards.yaml)) | Empty queries everywhere |
| ServiceAccount name ([10](stack/10-prometheus-rbac.yaml)) | `serviceAccountName` ([13:22](stack/13-prometheus.yaml)) | Empty targets page |

---

## Validating before you apply

```bash
# 1. Kubernetes structure (does NOT check embedded config)
kubectl apply --dry-run=client -f stack/

# 2. Embedded Prometheus rules — the part kubectl can't see
python3 -c "
import yaml,pathlib
cm=list(yaml.safe_load_all(open('stack/12-prometheus-rules.yaml')))[0]
for k,v in cm['data'].items(): pathlib.Path('/tmp/'+k).write_text(v)
"
promtool check rules /tmp/recording.yml /tmp/alerts.yml

# 3. Embedded Prometheus config
python3 -c "
import yaml,pathlib
cm=list(yaml.safe_load_all(open('stack/11-prometheus-config.yaml')))[0]
pathlib.Path('/tmp/prometheus.yml').write_text(cm['data']['prometheus.yml'])
"
promtool check config /tmp/prometheus.yml

# 4. Dashboard JSON is valid JSON
python3 -c "
import yaml,json
cm=list(yaml.safe_load_all(open('stack/41-grafana-dashboards.yaml')))[0]
[json.loads(v) for v in cm['data'].values()]; print('dashboards OK')
"
```

Steps 2–4 exist because `kubectl apply` validates the **ConfigMap wrapper**, never its contents. A malformed `prometheus.yml` applies cleanly and then crash-loops the pod.
