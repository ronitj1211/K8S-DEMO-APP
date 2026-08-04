# Hands-on Practice — Persistent Volumes (notes app)

Project folder: `persistent-volumes/` (contains `backend`, `frontend`, plus
`notes-data` PVC-backed storage)
Environment: k3s via Colima (single node: `colima`)

---

## 1. What was built

A small "notes" app to prove persistent storage survives Pod restarts:
- **Backend** (`pv-demo-backend:1.0`) — Node.js app, stores a counter + notes
  list on disk at `/data` (`counter.txt`, `notes.json`).
- **Frontend** (`pv-demo-ui:1.0`) — static Nginx UI.
- **Storage** — a single PVC (`notes-data`), **no `storageclass.yaml` or
  `pv.yaml` was written manually** — both were provided automatically by the
  cluster, covered in detail below.

---

## 2. Commands run, in order

```bash
# Build images
cd backend
docker build -t pv-demo-backend:1.0 .

cd ../frontend
docker build -t pv-demo-ui:1.0 .

# Deploy storage first
kubectl apply -f backend/02-pvc.yaml

# Deploy backend (Deployment + Service)
kubectl apply -f backend/03-deployment.yaml

# Deploy frontend (Deployment + Service)
kubectl apply -f frontend/frontend.yaml
```

---

## 3. Key command outputs and what they proved

### PVC starts `Pending`

```bash
kubectl get pvc
```
```
NAME         STATUS    VOLUME   CAPACITY   ACCESS MODES   STORAGECLASS   AGE
notes-data   Pending                                      local-path     8s
```
`Pending` immediately after creating the PVC, **before** any Pod existed —
this is `volumeBindingMode: WaitForFirstConsumer` in action: the provisioner
deliberately waits for a Pod to be scheduled before creating anything.

### PVC binds once the Deployment's Pod is scheduled

```bash
kubectl get pvc notes-data
```
```
NAME         STATUS   VOLUME                                     CAPACITY   ACCESS MODES   STORAGECLASS   AGE
notes-data   Bound    pvc-73f2e51c-20c7-4328-a59f-dbb42f130585   2Gi        RWO            local-path     5m31s
```

### `kubectl get pv` shows a PV that was never manually written

```bash
kubectl get pv
```
```
NAME                                       CAPACITY   ACCESS MODES   RECLAIM POLICY   STATUS   CLAIM                STORAGECLASS
pvc-73f2e51c-20c7-4328-a59f-dbb42f130585   2Gi        RWO            Delete           Bound    default/notes-data   local-path
```

### `kubectl describe pvc` — the full dynamic-provisioning event trail

```bash
kubectl describe pvc notes-data
```
```
Events:
  Normal  WaitForFirstConsumer   waiting for first consumer to be created before binding
  Normal  Provisioning           External provisioner is provisioning volume for claim "default/notes-data"
  Normal  ExternalProvisioning   Waiting for a volume to be created either by the external
                                 provisioner 'rancher.io/local-path' or manually by the
                                 system administrator...
  Normal  ProvisioningSucceeded  Successfully provisioned volume pvc-73f2e51c-...
```
This is the entire dynamic-provisioning flow, end to end, visible directly in
the Events — no manual PV creation, no manual binding.

### `kubectl describe pv` — where the data actually lives

```bash
kubectl describe pv pvc-73f2e51c-20c7-4328-a59f-dbb42f130585
```
```
StorageClass:      local-path
Status:            Bound
Reclaim Policy:    Delete
Access Modes:      RWO
Node Affinity:
  Required Terms:
    Term 0:        kubernetes.io/hostname in [colima]
Source:
    Type:  LocalVolume (a persistent volume backed by local storage on a node)
    Path:  /var/lib/rancher/k3s/storage/pvc-73f2e51c-..._default_notes-data
```
Two critical details here:
- **`Node Affinity` pinned to `colima`** — this PV only works on that exact
  node.
- **`Source: LocalVolume`, a real directory path on that node's own disk** —
  not a network-attached disk of any kind.

### Data survives a Pod restart

```bash
curl -s -X POST http://localhost:30095/notes \
  -H 'Content-Type: application/json' \
  -d '{"text":"survives pod restart"}'
```
```json
{"podHostname":"notes-89fbffc-v7zd9","note":{"id":1785829808500,"text":"survives pod restart","pod":"notes-89fbffc-v7zd9"},"total":1}
```

```bash
kubectl delete pod -l app=notes
kubectl get pods -l app=notes -w
```
```
NAME                  READY   STATUS    RESTARTS   AGE
notes-89fbffc-xdlbh   1/1     Running   0          35s
```

```bash
curl -s http://localhost:30095/
```
```json
{
  "podHostname": "notes-89fbffc-xdlbh",
  "counter": 5,
  "notes": [
    {"id": 1785829808500, "text": "survives pod restart", "pod": "notes-89fbffc-v7zd9"}
  ]
}
```
New pod (`xdlbh`, different hash suffix — this is a Deployment, not a
StatefulSet, so identity isn't preserved, only the **data** is), but the
counter and notes list are intact — proving the PVC/PV survived the Pod's
death independently of the Pod's own lifecycle.

---

## 4. Why no `storageclass.yaml` or `pv.yaml` was needed

| Thought it needed | What actually happened |
|---|---|
| Write `storageclass.yaml` | k3s ships a pre-installed default StorageClass, `local-path` — confirmed via `kubectl get storageclass` |
| Write `pv.yaml` | The `rancher.io/local-path` provisioner (a controller Pod running in-cluster) auto-created a PV dynamically the moment a Pod needed it |
| Manually bind PVC to PV | Handled automatically by the PV controller as part of dynamic provisioning |

The PVC had no `storageClassName` set → fell back to the cluster's default
(`local-path`) → dynamic provisioning path, same mechanism as a cloud
provider, just backed by a plain local directory instead of a real network
disk.

---

## 5. The `local-path` gotcha — and how it maps to EKS

`local-path`'s PV is hard-pinned via `Node Affinity` to the exact node it was
created on (`colima`). In this single-node k3s cluster, that's invisible —
there was nowhere else for the Pod to reschedule to, so the restart test
"just worked."

**This does not mean the same setup is production-safe.** Comparing to a
real multi-node EKS cluster:

| | `local-path` (k3s, this exercise) | EBS CSI (EKS, production) |
|---|---|---|
| Default StorageClass | `local-path`, pre-installed by k3s | `gp2`/`gp3`, pre-installed by the EKS EBS CSI add-on |
| `volumeBindingMode` | `WaitForFirstConsumer` | `WaitForFirstConsumer` (same reason) |
| Provisioner action | Creates a directory on the **node's local disk** | Calls the **AWS EC2 API**, creates a real EBS volume |
| PV's Node Affinity | Pinned to one specific **node** (`kubernetes.io/hostname`) | Pinned to one **Availability Zone** (`topology.ebs.csi.aws.com/zone`) — any node within that zone can attach |
| Pod reschedules to a different node, same AZ/zone | Fails — no other node has the data (single-node only) | Works — EBS reattaches to any node in the same AZ |
| Pod reschedules to a different node in a different zone | N/A (no zones in this setup) | Stuck `Pending` — `volume node affinity conflict` |
| Volume expansion / snapshots | Not supported | Supported |
| Production-appropriate | No — explicitly meant for local dev/testing only | Yes |

**Why `WaitForFirstConsumer` matters even more on EKS:** if binding mode were
`Immediate` instead, AWS would provision the EBS volume in a zone with no
idea where the Pod will actually be scheduled — a common real-world bug where
the Pod later lands in a different zone and gets stuck permanently with a
`volume node affinity conflict`. `WaitForFirstConsumer` waits until the Pod
is scheduled first, then provisions in that exact zone — avoiding the
mismatch entirely.

**Multi-replica implication (ties back to the Deployment vs StatefulSet
volume-sharing discussion):** on a multi-AZ EKS cluster, a Deployment with
several replicas sharing one RWO EBS-backed PVC will have replicas that land
outside the volume's AZ get stuck `Pending` forever — a very common
production trap when a Deployment (instead of a StatefulSet with
`volumeClaimTemplates`) is used with cluster autoscaling/HA spreading nodes
across zones.

---

## 6. Key takeaways from this exercise

1. A `StorageClass` doesn't have to be written by you — cluster
   distributions (k3s, EKS, GKE, AKS) typically ship one pre-installed and
   marked default.
2. `kubectl describe pvc` and `kubectl describe pv` Events are the clearest
   way to see the entire dynamic-provisioning sequence actually happening,
   step by step.
3. Data persisting across a Pod restart proves the PVC/PV lifecycle is
   fully independent of the Pod's lifecycle — the Pod got a new name and
   identity, the data did not care.
4. A PV's `Node Affinity` is the single most important field to check when
   reasoning about whether storage will "just work" after a reschedule —
   node-pinned (`local-path`) vs zone-pinned (EBS) vs unrestricted (NFS/EFS)
   all behave very differently the moment more than one node/zone is
   involved.
5. What worked seamlessly in this single-node k3s exercise would break in a
   specific, predictable way (`volume node affinity conflict`) on a
   multi-AZ EKS cluster if the same assumptions were carried over — this is
   exactly the kind of thing that looks fine in dev and fails in production.

---

## 7. Quick command reference used in this exercise

```bash
kubectl apply -f backend/02-pvc.yaml
kubectl apply -f backend/03-deployment.yaml
kubectl apply -f frontend/frontend.yaml

kubectl get pvc
kubectl get pv
kubectl get svc
kubectl get endpoints
kubectl get pods -l app=notes -o wide

kubectl describe pvc notes-data
kubectl describe pv <volume-name>

kubectl delete pod -l app=notes
kubectl get pods -l app=notes -w

curl -s http://localhost:30095/
curl -s -X POST http://localhost:30095/inc
curl -s -X POST http://localhost:30095/notes -H 'Content-Type: application/json' -d '{"text":"..."}'
```
