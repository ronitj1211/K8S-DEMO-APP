# Run Steps — Monitoring + NetworkPolicies on Colima (k3s)

Concrete commands to bring up Prometheus + Grafana with the demo app, then prove NetworkPolicy enforcement on **Colima + k3s**. See [README.md](README.md) for the concepts.

> **k3s enforces NetworkPolicies.** k3s ships with flannel for the CNI and embeds **kube-router** for NetworkPolicy enforcement. The policies in this folder will actually block traffic — verified live in this session.

---

## 0. Pre-check

```bash
kubectl get ns | grep -E "monitoring|demo"     # should be empty
```

---

## 1. CORS fix on the backend

Add to [backend/server.js](backend/server.js) (inside the existing middleware) so the browser-driven traffic generator works:

```js
res.setHeader('Access-Control-Allow-Origin', '*');
```

---

## 2. Build images

```bash
cd K8S-demo-concept-wise-project/monitoring-networkpolicies/backend
docker build -t monitoring-backend:1.0 .

cd ../frontend
docker build -t monitoring-frontend:1.0 .
```

---

## 3. Apply everything except the policies

Order matters only for namespaces. Apply in this sequence:

```bash
cd K8S-demo-concept-wise-project/monitoring-networkpolicies

kubectl apply -f stack/00-namespaces.yaml          # demo + monitoring
kubectl apply -f stack/10-prometheus-rbac.yaml     # SA + ClusterRole
kubectl apply -f stack/11-prometheus-config.yaml   # Prometheus scrape config (pod auto-discovery)
kubectl apply -f stack/12-prometheus.yaml          # Prometheus Deployment + Service
kubectl apply -f stack/20-grafana.yaml             # Grafana Deployment + pre-provisioned datasource
kubectl apply -f backend/01-app.yaml               # 2-replica backend with /metrics, in `demo` ns
kubectl apply -f frontend/frontend.yaml            # traffic-generator UI

kubectl rollout status -n monitoring deployment/prometheus
kubectl rollout status -n monitoring deployment/grafana
kubectl rollout status -n demo       deployment/backend
kubectl rollout status -n demo       deployment/frontend
```

---

## 4. Verify Prometheus discovered the backend

Prometheus picks up Pods carrying `prometheus.io/scrape: "true"` annotations:

```bash
curl -s http://localhost:30101/api/v1/targets | \
  python3 -c "import sys,json; d=json.load(sys.stdin); \
    [print(t['labels'].get('pod','?'), '->', t['health']) for t in d['data']['activeTargets']]"
```

Expected:

```
backend-xxxxx-aaaaa -> up
backend-xxxxx-bbbbb -> up
```

---

## 5. Generate traffic and query metrics

```bash
for i in $(seq 1 30); do
  curl -s -o /dev/null http://localhost:30100/
  curl -s -o /dev/null http://localhost:30100/slow
  curl -s -o /dev/null http://localhost:30100/error
done

sleep 12       # wait for the next scrape

curl -s "http://localhost:30101/api/v1/query?query=demo_requests_total" | python3 -m json.tool | head -30
```

Or open the Prometheus UI at <http://localhost:30101> and query `demo_requests_total` / `rate(demo_request_duration_seconds_sum[1m])`.

---

## 6. Grafana

Open <http://localhost:30102> — login **admin / admin** (set in the manifest; demo only). The **Prometheus** datasource is already provisioned from `stack/20-grafana.yaml`. Build a panel using `demo_requests_total` to confirm end-to-end.

API confirmation:

```bash
curl -su admin:admin http://localhost:30102/api/datasources | python3 -m json.tool
# url: http://prometheus.monitoring.svc:9090  isDefault: true
```

---

## 7. NetworkPolicy demo — DENY then ALLOW

### Baseline: anything can reach `backend`

```bash
kubectl run probe -n default --rm -i --restart=Never --image=curlimages/curl \
  --command -- sh -c "curl -s --max-time 3 http://backend.demo.svc/ && echo ' -- reachable'"
# {"hostname":"backend-..."} -- reachable
```

### Apply default-deny ingress

```bash
kubectl apply -f policies/01-default-deny-ingress.yaml
```

Same probe → **BLOCKED**:

```bash
kubectl run probe -n default --rm -i --restart=Never --image=curlimages/curl \
  --command -- sh -c "curl -s --max-time 3 http://backend.demo.svc/ || echo BLOCKED"
# BLOCKED
```

Prometheus targets in `demo` also flip to `down` — Prometheus is in another namespace.

### Allow frontend (same ns) and Prometheus (different ns)

```bash
kubectl apply -f policies/02-allow-frontend-to-backend.yaml
kubectl apply -f policies/03-allow-prometheus-scrape.yaml
```

Verify:

```bash
# from `default` ns -- still blocked
kubectl run probe -n default --rm -i --restart=Never --image=curlimages/curl \
  --command -- sh -c "curl -s --max-time 3 http://backend.demo.svc/ || echo BLOCKED"
# BLOCKED

# from frontend in `demo` ns -- allowed by label
FE=$(kubectl get pod -n demo -l app=frontend -o jsonpath='{.items[0].metadata.name}')
kubectl exec -n demo "$FE" -- sh -c "wget -qO- --timeout=3 http://backend.demo.svc/ || echo BLOCKED"
# {"hostname":"backend-..."}

# Prometheus targets — back to `up`
sleep 12
curl -s http://localhost:30101/api/v1/targets | \
  python3 -c "import sys,json; d=json.load(sys.stdin); \
    [print(t['labels'].get('pod','?'), '->', t['health']) for t in d['data']['activeTargets'] if t['labels'].get('namespace')=='demo']"
```

The selectors that mattered:
- **02** uses `podSelector: app=frontend` — matches Pods in the **same namespace** (`demo`) only.
- **03** uses `namespaceSelector: kubernetes.io/metadata.name=monitoring` + `podSelector: app=prometheus` — matches the prometheus Pod in the monitoring ns.

Everything else stays denied. That's the principle of least privilege at the network layer.

---

## 8. Cleanup

```bash
cd K8S-demo-concept-wise-project/monitoring-networkpolicies
kubectl delete -f policies/ -f frontend/frontend.yaml -f backend/01-app.yaml \
                -f stack/20-grafana.yaml -f stack/12-prometheus.yaml \
                -f stack/11-prometheus-config.yaml -f stack/10-prometheus-rbac.yaml \
                -f stack/00-namespaces.yaml
```

Or nuke both namespaces in one shot:

```bash
kubectl delete namespace demo monitoring
```

---

## Notes specific to this setup

- **k3s DOES enforce NetworkPolicies.** Don't assume "flannel doesn't enforce NetPol" — k3s embeds kube-router specifically to make policies stick. On a plain flannel install (no k3s), policies are silently ignored.
- **`prometheus.io/scrape: "true"` annotations are what hook into Prometheus.** The scrape config does the discovery via `kubernetes_sd_configs: pod` + a relabel rule that keeps only annotated Pods.
- **Grafana admin password is `admin`** (hardcoded in `20-grafana.yaml` env vars). Demo only — change for anything real.
- **`emptyDir` for Prometheus data.** Pod restart wipes metrics. Production uses a PVC.
- **NodePorts:** Prometheus 30101, Grafana 30102, backend 30100, frontend 30103.
- **Pod IPs vs Services in NetworkPolicy.** NetPol selectors match Pods, not Services. Even though the frontend hits `http://backend.demo.svc`, kube-proxy DNAT-translates that to a Pod IP before the policy is evaluated.
