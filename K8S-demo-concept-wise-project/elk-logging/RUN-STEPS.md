# Run Steps — EFK Logging on Colima (k3s)

Concrete commands to bring up Elasticsearch + Kibana + Fluent Bit on **Colima + k3s**. See [README.md](README.md), [HOW_IT_CONNECTS.md](HOW_IT_CONNECTS.md), and [KIBANA_GUIDE.md](KIBANA_GUIDE.md) for the concepts.

> **Status of this session:** images built; the live stack-deploy was **not** executed in the session that produced this file because the EFK stack uses ~2.5 GB RAM (ES 1.5 GB + Kibana 1 GB + Fluent Bit). The commands below are correct for Colima/k3s — bump `colima start --memory 6` if you're running tight.

---

## 0. Pre-check / resize Colima if needed

```bash
colima status                          # check available memory
colima stop && colima start --memory 6 --kubernetes   # if you need more headroom
kubectl get ns | grep -E "logging|demo"   # should be empty
```

---

## 1. Build the demo app images

The stack manifests reference 3 custom images: `elk-demo-backend:1.0`, `orders-service:1.0`, `elk-demo-frontend:1.0`. Build all three:

```bash
cd K8S-demo-concept-wise-project/elk-logging/backend
docker build -t elk-demo-backend:1.0 .

cd ../orders-service
docker build -t orders-service:1.0 .

cd ../frontend
docker build -t elk-demo-frontend:1.0 .
```

---

## 2. Deploy the EFK stack

Apply in numeric order — the file prefixes encode the dependency:

```bash
cd K8S-demo-concept-wise-project/elk-logging

kubectl apply -f stack/00-namespace.yaml          # creates `logging` + `demo`
kubectl apply -f stack/10-elasticsearch.yaml      # 1-node ES, no auth, no PVC (demo only)
kubectl apply -f stack/20-kibana.yaml             # Kibana hitting elasticsearch.logging.svc

# Wait for Elasticsearch — Kibana hangs in CrashLoop until ES is yellow/green
kubectl wait --for=condition=ready pod -l app=elasticsearch -n logging --timeout=300s
kubectl wait --for=condition=ready pod -l app=kibana        -n logging --timeout=300s

kubectl apply -f stack/30-fluent-bit-rbac.yaml    # SA + ClusterRole for K8s metadata
kubectl apply -f stack/31-fluent-bit-config.yaml  # tail → kubernetes filter → es output
kubectl apply -f stack/32-fluent-bit-daemonset.yaml
```

Sanity check:

```bash
kubectl get pods -n logging -o wide
# elasticsearch-0  Running
# kibana-...       Running
# fluent-bit-...   Running (one per node — on Colima, one)
```

---

## 3. Deploy the demo apps that produce logs

```bash
kubectl apply -f backend/sample-app.yaml          # 2 replicas, emits info/warn/error JSON lines
kubectl apply -f orders-service/orders-service.yaml   # second service with order/payment events
kubectl apply -f frontend/frontend.yaml           # UI to drive traffic

kubectl rollout status -n demo deployment/sample-app
kubectl rollout status -n demo deployment/orders-service
```

---

## 4. Verify the pipeline end-to-end

### Generate logs

```bash
# hit sample-app
for i in $(seq 1 20); do
  curl -s -o /dev/null http://localhost:30090/
  curl -s -o /dev/null http://localhost:30090/warn
  curl -s -o /dev/null http://localhost:30090/error
done

# hit orders-service
for i in $(seq 1 10); do
  curl -s -X POST http://localhost:30099/orders > /dev/null
  curl -s         http://localhost:30099/orders/ord_1023 > /dev/null
  curl -s -X POST http://localhost:30099/payments/charge > /dev/null
done
```

### See it arrive in Elasticsearch

Port-forward ES (it's a ClusterIP — no NodePort):

```bash
kubectl port-forward -n logging svc/elasticsearch 9200:9200 &

curl -s http://localhost:9200/_cat/indices?v | head
# health  status  index                        ... docs.count
# yellow  open    k8s-logs-2026.05.20          ...   1234
```

Look for log lines:

```bash
curl -s "http://localhost:9200/k8s-logs-*/_search?q=msg:order%20created&size=2" | python3 -m json.tool | head -40
```

### Open Kibana

<http://localhost:30092> — first time, follow the steps in [KIBANA_GUIDE.md](KIBANA_GUIDE.md):

1. **Management → Stack Management → Data Views** → create a data view with index pattern `k8s-logs-*` and `@timestamp` as the time field.
2. **Discover** → pick the data view, set the time picker to *Last 15 minutes*, and search:
   - `msg : "order created"` — orders-service events
   - `level : "error"` — both apps' errors
   - `kubernetes.labels.app : "orders-service" and action : "charge"`
3. The records carry the Pod's labels, namespace, pod name, and container name — added by the **kubernetes** filter in `31-fluent-bit-config.yaml`.

---

## 5. Cleanup

```bash
cd K8S-demo-concept-wise-project/elk-logging
kubectl delete -f backend/sample-app.yaml \
                -f orders-service/orders-service.yaml \
                -f frontend/frontend.yaml
kubectl delete -f stack/32-fluent-bit-daemonset.yaml \
                -f stack/31-fluent-bit-config.yaml \
                -f stack/30-fluent-bit-rbac.yaml \
                -f stack/20-kibana.yaml \
                -f stack/10-elasticsearch.yaml \
                -f stack/00-namespace.yaml
```

Or nuke both namespaces:

```bash
kubectl delete namespace demo logging
```

---

## Notes specific to this setup

- **Single-node ES, no auth, no PVC.** The manifest uses `discovery.type: single-node` and disables `xpack.security`. Data is on `emptyDir` — Pod restart wipes it. Production needs auth, a 3-node cluster, and PVCs.
- **Fluent Bit handles both CRI and Docker log formats** via `multiline.parser docker, cri`. k3s on Colima uses containerd (CRI format) — the parser auto-detects which.
- **Apps log JSON.** The `Merge_Log On` filter in Fluent Bit unpacks each log line's JSON into top-level fields, so in Kibana you filter on `level`, `msg`, `orderId`, `customerId`, etc. directly.
- **NodePorts:** Kibana 30092, sample-app 30090, orders-service 30099, log-generator-ui 30091. ES has no NodePort — use `kubectl port-forward` if you want to hit it from the host.
- **Memory pressure.** ES alone reserves 1 GB and limits 1.5 GB. If Colima's VM is at 4 GB total, the cluster will struggle. Resize with `colima start --memory 6 --kubernetes` before applying.
- **First request to Kibana can take ~60s** while it negotiates with Elasticsearch. The readinessProbe has `initialDelaySeconds: 60`.
