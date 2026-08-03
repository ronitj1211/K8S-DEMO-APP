# Run Steps — PV & PVC on Colima (k3s)

Concrete commands to demo this folder on **Colima + k3s**. See [README.md](README.md) for concepts.

> k3s ships with **`local-path-provisioner`** as the default StorageClass. PVCs bind automatically — skip `01-storageclass.yaml`.

---

## 0. Pre-check

```bash
kubectl get storageclass        # expect: local-path (default)
kubectl get pvc,pv              # expect: No resources
```

---

## 1. Build images

```bash
cd K8S-demo-concept-wise-project/persistent-volumes/backend
docker build -t pv-demo-backend:1.0 .

cd ../frontend
docker build -t pv-demo-ui:1.0 .
```

---

## 2. Apply manifests (order matters)

PVC first — Deployment references it.

```bash
cd K8S-demo-concept-wise-project/persistent-volumes

kubectl apply -f backend/02-pvc.yaml
kubectl apply -f backend/03-deployment.yaml
kubectl apply -f frontend/frontend.yaml

kubectl rollout status deployment/notes --timeout=120s
kubectl rollout status deployment/notes-ui
```

Verify binding:

```bash
kubectl get pvc notes-data
kubectl get pv
kubectl get pods -l app=notes -o wide
```

Expected:
- PVC `notes-data` → `Bound`
- One PV created by local-path provisioner
- Pod `notes-xxxxx` → `Running`

---

## 3. Write data

```bash
curl -s http://localhost:30095/ | python3 -m json.tool

curl -s -X POST http://localhost:30095/inc | python3 -m json.tool

curl -s -X POST http://localhost:30095/notes \
  -H 'Content-Type: application/json' \
  -d '{"text":"survives pod restart"}' | python3 -m json.tool
```

Open UI: <http://localhost:30096>

---

## 4. Prove persistence — delete the Pod

```bash
kubectl delete pod -l app=notes
kubectl get pods -l app=notes -w
# Ctrl-C once Running

curl -s http://localhost:30095/ | python3 -m json.tool
# counter and notes are unchanged — same PVC, new Pod
```

Inspect files on disk inside the new Pod:

```bash
kubectl exec deploy/notes -- cat /data/counter.txt
kubectl exec deploy/notes -- cat /data/notes.json
```

---

## 5. Trace PVC → PV binding

```bash
kubectl describe pvc notes-data
PV=$(kubectl get pvc notes-data -o jsonpath='{.spec.volumeName}')
echo "Bound PV: $PV"
kubectl describe pv "$PV"
```

---

## 6. (Optional) Static PV example

```bash
kubectl apply -f backend/04-static-pv-pvc-example.yaml
kubectl get pv static-demo-pv
kubectl get pvc static-demo-pvc
# both should show Bound
```

Clean up static example:

```bash
kubectl delete -f backend/04-static-pv-pvc-example.yaml
```

---

## 7. Cleanup

Deleting the Deployment does **not** delete the PVC — data is preserved by design.

```bash
kubectl delete -f frontend/frontend.yaml
kubectl delete -f backend/03-deployment.yaml
kubectl delete -f backend/02-pvc.yaml

kubectl get pv,pvc
# PV auto-deleted (local-path reclaimPolicy: Delete)
```

---

## Notes for this setup

- **NodePorts:** notes API on 30095, UI on 30096.
- **Skip `01-storageclass.yaml`** on k3s — its minikube provisioner does not exist here.
- **replicas: 1** — RWO volume can only attach to one node; multi-replica Deployments need RWX or StatefulSets.
- **PVC survives Pod deletion** — delete PVC explicitly when you want data gone.

**Next chapter:** [statefulsets-storage/RUN-STEPS.md](../statefulsets-storage/RUN-STEPS.md) — per-Pod PVCs with StatefulSets.
