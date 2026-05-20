# Run Steps — Autoscaling & Resources on Colima (k3s)

Concrete commands to drive the HPA from idle → max and back, on **Colima + k3s**. See [README.md](README.md) for the concepts.

> Colima's k3s already runs `metrics-server` (the HPA's data source) — verify with `kubectl top nodes`. On other distros you may need to install it separately.

---

## 0. Pre-check

```bash
kubectl top nodes              # metrics-server is working if this returns numbers
kubectl get hpa                # No resources
```

If `kubectl top nodes` errors, the HPA will sit at `cpu: <unknown>/50%` forever.

---

## 1. CORS fix on the backend

Add to [backend/server.js](backend/server.js) so the frontend can hit `/burn`:

```js
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});
```

---

## 2. Build images

```bash
cd K8S-demo-concept-wise-project/autoscaling-resources/backend
docker build -t cpu-burner:1.0 .

cd ../frontend
docker build -t cpu-burner-ui:1.0 .
```

---

## 3. Apply

```bash
cd K8S-demo-concept-wise-project/autoscaling-resources

kubectl apply -f backend/01-deployment.yaml       # Deployment + Service + CPU requests/limits
kubectl apply -f backend/02-hpa.yaml              # HPA: 1..5 replicas at 50% CPU
kubectl apply -f frontend/frontend.yaml

kubectl rollout status deployment/cpu-burner
kubectl get hpa
```

Initially the HPA shows `cpu: <unknown>/50%` — it takes ~30s for metrics-server to publish the first sample.

---

## 4. Verify the resource math

```bash
kubectl describe pod -l app=cpu-burner | sed -n '/Limits/,/QoS Class/p'
```

```
Limits:    cpu: 500m, memory: 128Mi
Requests:  cpu: 100m, memory: 64Mi
QoS Class: Burstable
```

- **Requests** are reservations and what the HPA percentage is measured against.
  Each Pod requests `100m` CPU; the HPA target is 50% of that → 50m used per Pod.
- **Limits** are the throttling ceiling. The container is capped at `500m` (0.5 vCPU) even if the node is idle.
- **QoS class:** because limits > requests, it's `Burstable`. Pods with no requests/limits → `BestEffort`. Pods where requests == limits → `Guaranteed` (last to be evicted under pressure).

---

## 5. Drive load and watch the HPA scale up

Start a sustained burner in-cluster:

```bash
kubectl run loadgen --image=busybox --restart=Never --rm=false -- sh -c \
  'while true; do wget -qO- http://cpu-burner.default.svc.cluster.local/burn?ms=500 > /dev/null; done'
```

Watch in another terminal:

```bash
kubectl get hpa cpu-burner -w
```

Observed timeline (your timings will be similar):

| Time after load start | HPA TARGETS | REPLICAS |
|---|---|---|
| ~0s | cpu: 3% / 50% | 1 |
| ~20s | cpu: 31% / 50% | 1 |
| ~30s | **cpu: 500% / 50%** | 3 *(jumped by 2, per `scaleUp.policies`)* |
| ~50s | cpu: 173% / 50% | 5 *(another +2, capped at maxReplicas)* |

Replicas tops out at `maxReplicas: 5` even though desired-replicas is higher.

---

## 6. Watch the scale-DOWN stabilization window

Stop the load:

```bash
kubectl delete pod loadgen
```

CPU drops back to ~1-2% almost immediately — but **replicas stay at 5** for `scaleDown.stabilizationWindowSeconds: 300` (5 minutes). This is by design: scaling down too eagerly causes flapping. After the window, the HPA shrinks by `policies` (1 Pod per 60s in this manifest) until back to `minReplicas: 1`.

```bash
kubectl get hpa cpu-burner -w     # leave running for 5-10 minutes
```

---

## 7. The frontend page

<http://localhost:30098> — click the burn buttons to drive load from the browser. Useful for ad-hoc experimentation; the in-cluster `loadgen` Pod hits the Service harder.

---

## 8. (Optional) QoS examples

```bash
kubectl apply -f backend/03-qos-examples.yaml
kubectl describe pod -l qos=demo | grep "QoS Class"
```

Shows `Guaranteed` / `Burstable` / `BestEffort` Pods side-by-side.

---

## 9. Cleanup

```bash
cd K8S-demo-concept-wise-project/autoscaling-resources

kubectl delete pod loadgen --ignore-not-found
kubectl delete -f backend/02-hpa.yaml \
                -f backend/01-deployment.yaml \
                -f frontend/frontend.yaml \
                -f backend/03-qos-examples.yaml --ignore-not-found
```

---

## Notes specific to this setup

- **metrics-server is pre-installed in k3s.** On a fresh cluster it needs `--kubelet-insecure-tls` to talk to kubelets; k3s wires this up automatically.
- **`<unknown>/50%` for ~30s is normal**, not an error. HPA needs a metric window before it can decide.
- **Replicas scaled to 5, not infinity**, because `maxReplicas: 5` capped it. The HPA reports `desired` separately if you `kubectl describe hpa cpu-burner` — interesting under heavy load.
- **Burn from in-cluster, not the host.** Hitting `localhost:30097` via curl works but the HPA sees lower utilization because the loop runs on your laptop, not the cluster — you'll need many parallel terminals. The `kubectl run loadgen` approach pegs CPU much faster.
- **5-minute scale-down delay is in the HPA manifest.** Don't be alarmed when replicas linger after load stops — that's `behavior.scaleDown.stabilizationWindowSeconds: 300`.
- **NodePorts:** backend 30097, frontend 30098.
