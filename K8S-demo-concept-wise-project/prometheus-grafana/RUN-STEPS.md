# Run Steps — Prometheus + Grafana on Colima (k3s)

Concrete commands to bring the stack up and drive it end to end. See [README.md](README.md) for the concepts.

Everything is exposed as **NodePort**, so no ingress is needed:

| Service | URL | Login |
|---|---|---|
| Grafana | http://localhost:30030 | `admin` / `admin` |
| Prometheus | http://localhost:30090 | — |
| Alertmanager | http://localhost:30093 | — |
| demo-api | http://localhost:30300 | — |

---

## 0. Pre-check

```bash
kubectl get nodes
kubectl get ns | grep -E "monitoring|demo"    # should be empty
```

---

## 1. Build the app image

k3s on Colima can't pull `demo-api:1.0` from a registry — it has to exist in the node's image store. Build it, then import it:

```bash
cd K8S-demo-concept-wise-project/prometheus-grafana/app
docker build -t demo-api:1.0 .

# Make the image visible to k3s (Colima shares the Docker daemon, so this is
# usually a no-op; run it if pods report ErrImageNeverPull / ImagePullBackOff)
docker save demo-api:1.0 | colima ssh -- sudo k3s ctr images import -
```

The manifest uses `imagePullPolicy: IfNotPresent`, so a locally present image is used as-is.

---

## 2. Deploy everything

Order matters only for the namespace and RBAC:

```bash
cd K8S-demo-concept-wise-project/prometheus-grafana

kubectl apply -f stack/00-namespace.yaml
kubectl apply -f stack/            # the rest, in filename order
kubectl apply -f app/app.yaml      # demo namespace + app + loadgen
```

Wait for everything to settle:

```bash
kubectl -n monitoring rollout status deploy/prometheus
kubectl -n monitoring rollout status deploy/grafana
kubectl -n monitoring rollout status deploy/alertmanager
kubectl -n monitoring rollout status deploy/kube-state-metrics
kubectl -n monitoring rollout status ds/node-exporter
kubectl -n demo       rollout status deploy/demo-api

kubectl get pods -n monitoring -o wide
kubectl get pods -n demo -o wide
```

---

## 3. Confirm the app is actually exposing metrics

Before blaming Prometheus, always check the source:

```bash
curl -s localhost:30300/metrics | head -30
curl -s localhost:30300/metrics | grep -E "^http_requests_total|^http_request_duration"
```

You should see `http_requests_total{...} <number>`. If this is empty, nothing downstream can work.

---

## 4. Verify Prometheus discovered the targets

Open **http://localhost:30090/targets** — or from the CLI:

```bash
# Every target and its health
curl -s localhost:30090/api/v1/targets | python3 -m json.tool | grep -E '"job"|"health"' | head -40

# Just the ones that are down
curl -s 'localhost:30090/api/v1/query?query=up==0' | python3 -m json.tool
```

Expect these jobs `up`: `prometheus`, `kubernetes-pods` (3 demo-api pods), `node-exporter`, `kube-state-metrics`, `kubernetes-nodes`, `kubernetes-cadvisor`.

> **If `kubernetes-pods` is empty:** the pod annotations aren't matching. Check with
> `kubectl get pods -n demo -o jsonpath='{.items[0].metadata.annotations}'` — you need `prometheus.io/scrape: "true"` as a **string**, not a boolean.
>
> **If everything is empty:** RBAC. Check `kubectl logs -n monitoring deploy/prometheus | grep -i forbidden`.

---

## 5. Run some PromQL

In the Prometheus UI (**http://localhost:30090/graph**) or via curl:

```bash
q() { curl -sG localhost:30090/api/v1/query --data-urlencode "query=$1" | python3 -m json.tool; }

q 'sum(rate(http_requests_total[5m]))'
q 'sum by (status) (rate(http_requests_total[5m]))'
q 'histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))'
q 'service:http_error_ratio:rate5m'          # the recording rule
q 'up'
```

The loadgen Deployment has been driving traffic since step 2, so these return real numbers.

---

## 6. Confirm the recording rules are producing series

```bash
curl -s localhost:30090/api/v1/rules | python3 -m json.tool | grep -E '"name"|"type"|"health"'
```

Then query a recorded series directly — if `service:http_latency_p95:5m` returns data, the rule engine is working:

```bash
q 'service:http_latency_p95:5m'
```

---

## 7. Open Grafana

**http://localhost:30030** — login `admin` / `admin`.

Both dashboards are already provisioned under the **Demo** folder:

- **Demo API — RED** (the default home dashboard)
- **Cluster Health — Nodes & Pods**

Check the datasource wired up correctly: **Connections → Data sources → Prometheus → Save & test** should report success.

---

## 8. Fire a real alert and watch it travel

This is the payoff — the full path from PromQL condition to delivered notification.

**Start watching the webhook receiver in one terminal:**

```bash
kubectl logs -n demo -l app=demo-api -f | grep ALERT
```

**In another terminal, generate errors** (`/error` always returns 500):

```bash
for i in $(seq 1 400); do curl -s -o /dev/null localhost:30300/error; done
```

**Watch the alert change state:**

```bash
# pending -> firing (takes `for: 2m` to become firing)
watch -n5 "curl -s localhost:30090/api/v1/alerts | python3 -m json.tool | grep -E '\"alertname\"|\"state\"'"
```

The sequence you should observe:

1. **Inactive** — error ratio below 5%.
2. **Pending** — condition true, but the `for: 2m` timer hasn't elapsed. Visible at http://localhost:30090/alerts.
3. **Firing** — pushed to Alertmanager. Visible at http://localhost:30093.
4. **Delivered** — the demo-api log line appears:
   `[ALERT firing] HighErrorRate severity=critical summary="demo-api 5xx ratio is 12%"`

Then stop generating errors and watch it resolve (`send_resolved: true` posts a `[ALERT resolved]` line).

**Latency alert instead:**

```bash
for i in $(seq 1 50); do curl -s -o /dev/null "localhost:30300/slow?ms=2000" & done; wait
```

---

## 9. Watch readiness affect the scrape

The app can be toggled out of readiness, which removes it from Service endpoints:

```bash
POD=$(kubectl get pod -n demo -l app=demo-api -o jsonpath='{.items[0].metadata.name}')
kubectl exec -n demo $POD -- wget -qO- --post-data='' http://localhost:3000/toggle-ready

kubectl get endpoints -n demo demo-api        # that pod's IP is gone
kubectl get pods -n demo                      # shows 0/1 READY
```

Note that **Prometheus still scrapes it** — pod-role service discovery targets pods directly, not Service endpoints. That's a genuinely useful property: an unready pod still reports metrics, so you can see *why* it's unready. Toggle it back:

```bash
kubectl exec -n demo $POD -- wget -qO- --post-data='' http://localhost:3000/toggle-ready
```

---

## 10. Trigger a CrashLoop alert

```bash
kubectl set image -n demo deploy/demo-api demo-api=demo-api:does-not-exist
kubectl get pods -n demo -w          # ImagePullBackOff
```

`PodNotReady` fires after 10 minutes. Roll it back:

```bash
kubectl rollout undo -n demo deploy/demo-api
```

---

## 11. Hot-reload Prometheus config

Prometheus runs with `--web.enable-lifecycle`, so you don't need to restart the pod after editing a rule or scrape job:

```bash
kubectl apply -f stack/12-prometheus-rules.yaml
# ConfigMap updates propagate to the mounted volume in up to ~60s, then:
kubectl exec -n monitoring deploy/prometheus -- wget -qO- --post-data='' http://localhost:9090/-/reload
curl -s localhost:9090/api/v1/rules >/dev/null && echo reloaded
```

Check the config Prometheus currently believes it has: **http://localhost:30090/config**.

---

## 12. Teardown

```bash
kubectl delete -f app/app.yaml
kubectl delete -f stack/
kubectl delete ns monitoring demo --ignore-not-found
```

---

## Troubleshooting

| Symptom | Check |
|---|---|
| Targets page empty | RBAC — `kubectl logs -n monitoring deploy/prometheus \| grep -i forbidden` |
| `kubernetes-pods` job has no targets | Annotations must be strings: `prometheus.io/scrape: "true"` |
| Target `DOWN` with connection refused | Wrong `prometheus.io/port`, or the app isn't listening on `0.0.0.0` |
| Grafana "No data" | Datasource URL must be `http://prometheus.monitoring.svc:9090`; check the panel's time range |
| Dashboards missing in Grafana | ConfigMap not mounted — `kubectl exec -n monitoring deploy/grafana -- ls /var/lib/grafana/dashboards` |
| `histogram_quantile` returns nothing | You dropped the `le` label in the `by()` clause |
| Alert never fires | It needs the full `for:` duration; check **Status → Rules** for the rule's health |
| Alert fires but no webhook log | Alertmanager can't reach `demo-api.demo.svc:3000` — `kubectl logs -n monitoring deploy/alertmanager` |
| node-exporter CrashLoop | `hostPort: 9100` already taken on the node |
| Prometheus OOMKilled | Cardinality. Run `topk(10, count by (__name__)({__name__=~".+"}))` |
