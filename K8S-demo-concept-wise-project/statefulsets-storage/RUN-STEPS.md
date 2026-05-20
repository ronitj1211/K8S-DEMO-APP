# Run Steps — StatefulSets & PVCs on Colima (k3s)

Concrete commands to demo this folder on **Colima + k3s**. See [README.md](README.md) for the concepts.

> k3s ships with **`local-path-provisioner`** as the default StorageClass, so PVCs bind out of the box with no extra setup. The `01-storageclass.yaml` example is for minikube and is **not needed** here.

---

## 0. Pre-check

```bash
kubectl get storageclass        # k3s default is "local-path"
kubectl get pvc                 # No resources
```

---

## 1. CORS fix on the backend

The frontend makes `POST /inc` calls across NodePorts, so set CORS + allow POST. Add to [backend/server.js](backend/server.js):

```js
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST');
  next();
});
```

---

## 2. Build images

```bash
cd K8S-demo-concept-wise-project/statefulsets-storage/backend
docker build -t stateful-counter:1.0 .

cd ../frontend
docker build -t stateful-counter-ui:1.0 .
```

---

## 3. Apply

Skip `01-storageclass.yaml` — k3s already has a default. Apply the StatefulSet (which bundles the headless Service + a NodePort Service in the same file) and the frontend:

```bash
cd K8S-demo-concept-wise-project/statefulsets-storage

kubectl apply -f backend/02-statefulset.yaml
kubectl apply -f frontend/frontend.yaml

kubectl rollout status statefulset/counter --timeout=120s
kubectl rollout status deployment/counter-ui
```

What got created:

```bash
kubectl get statefulset,pod,pvc,pv -l app=counter
```

You'll see:

- 3 Pods with **stable, ordered names**: `counter-0`, `counter-1`, `counter-2`.
- 3 PVCs named `data-counter-0`, `data-counter-1`, `data-counter-2` — generated automatically from `volumeClaimTemplates`.
- 3 PVs (k3s's local-path provisioner backed them).

Pods come up **one at a time, in order** (counter-0 must be Ready before counter-1 starts). That's a StatefulSet defining feature.

---

## 4. Each Pod has its own state

Hit each Pod directly (the headless Service makes them individually addressable):

```bash
for pod in counter-0 counter-1 counter-2; do
  kubectl exec "$pod" -- sh -c "wget -qO- --post-data='' http://localhost:3000/inc"
  echo
done
```

You'll see each Pod return `counter: 1` — totally independent counters.

Bump counter-0 a few more times and read it back:

```bash
for i in 2 3 4 5; do
  kubectl exec counter-0 -- sh -c "wget -qO- --post-data='' http://localhost:3000/inc" > /dev/null
done
kubectl exec counter-0 -- wget -qO- http://localhost:3000/
# {"podHostname":"counter-0","counter":5,"counterFile":"/data/counter.txt"}
```

---

## 5. PVC persistence — the headline feature

Delete `counter-0`. The StatefulSet recreates it **with the same name and same PVC**:

```bash
kubectl delete pod counter-0
kubectl get pod counter-0 -w        # comes back as counter-0, Running
# Ctrl-C once Ready

kubectl exec counter-0 -- wget -qO- http://localhost:3000/
# {"podHostname":"counter-0","counter":5,...}    <-- counter survived!
```

If you scaled this StatefulSet down, the PVCs **stick around** by default — scaling back up reattaches them. PVCs are deleted only when you delete them or set `persistentVolumeClaimRetentionPolicy.whenScaled: Delete`.

---

## 6. DNS — the other StatefulSet trick

The **headless Service** (`clusterIP: None`) gives each Pod a stable DNS name. Verify from a throwaway Pod:

```bash
kubectl run dns-test --rm -i --restart=Never --image=busybox -- sh -c \
  "nslookup counter-0.counter.default.svc.cluster.local"
# Name:    counter-0.counter.default.svc.cluster.local
# Address: 10.42.0.X
```

Each `counter-N` Pod has its own DNS record `counter-N.counter.<ns>.svc.cluster.local`. Useful when clients need to talk to a specific replica (leader/follower, primary/secondary, shard).

The `counter` short-name (no pod prefix) resolves to **all** Pod IPs — clients can pick one.

---

## 7. The NodePort Service for outside callers

```bash
for i in 1 2 3 4 5 6 7 8; do
  curl -s http://localhost:30093/ | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['podHostname'], 'counter=', d['counter'])"
done
```

You'll see the Service round-robin across the 3 Pods, each with its own counter value.

Open the frontend: <http://localhost:30094>. Click **Increment 10x** — the responses pane shows which Pod handled each call and where each counter is.

---

## 8. Cleanup

Deleting the StatefulSet does **not** delete its PVCs by default — they're considered precious. Delete them explicitly:

```bash
cd K8S-demo-concept-wise-project/statefulsets-storage

kubectl delete -f backend/02-statefulset.yaml \
                -f frontend/frontend.yaml

kubectl delete pvc -l app=counter
# (and the PVs are auto-deleted because local-path reclaimPolicy is Delete)
```

Confirm everything's gone:

```bash
kubectl get statefulset,svc,pvc,pv | head
```

---

## Notes specific to this setup

- **k3s has `local-path` as the default StorageClass** — no installation needed. Volumes live on the node's filesystem under `/var/lib/rancher/k3s/storage/`.
- **Skip `01-storageclass.yaml`** — its provisioner (`k8s.io/minikube-hostpath`) doesn't exist on this cluster. If you `apply` it, nothing breaks (it's just an unused StorageClass), but PVCs that try to use `demo-standard` will hang `Pending` forever.
- **PVCs are NOT deleted with the StatefulSet by default.** Delete them by label or explicitly. With `persistentVolumeClaimRetentionPolicy` you can change this behavior, but be careful — the default protects data.
- **`/data` on the Pod is on the node's disk.** On Colima that's the VM's disk, not your laptop's. `colima delete` wipes it all.
- **NodePorts:** counter-lb on 30093, counter-ui on 30094.
- **`wget --post-data=''`** is the busybox way to POST. The Pods don't have curl.
