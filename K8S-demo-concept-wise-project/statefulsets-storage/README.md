# StatefulSets, PV, PVC & StorageClass

## The problem with Deployment for stateful apps

Pods managed by a Deployment are **interchangeable**:

- Random names (`backend-7d8f6c-abc12`).
- No stable identity, no stable storage.
- A Pod can be rescheduled to any node — its disk is gone.

That works for a stateless web server. It does **not** work for:

- Databases (Postgres, MySQL, MongoDB, Redis)
- Distributed systems with peer identity (Kafka, ZooKeeper, Cassandra, Elasticsearch)
- Anything that writes to disk and needs that disk after a restart

For those, Kubernetes gives you:

- **PersistentVolume (PV) + PersistentVolumeClaim (PVC) + StorageClass** — the storage layer.
- **StatefulSet** — the controller that gives each Pod a stable name, hostname, and its own PVC.

---

## Storage: three pieces that fit together

```
        Pod
         │ mounts
         ▼
       PVC  ── "I want 5 GB, ReadWriteOnce"
         │ bound to
         ▼
        PV   ── actual disk (EBS volume, GCE PD, hostPath, NFS share, ...)
         │ provisioned via
         ▼
   StorageClass  ── "use AWS gp3 with these defaults"
```

| Object | Role | Lifecycle |
|--------|------|-----------|
| **StorageClass** | Recipe for *how* to provision storage. | Cluster-scoped. Long-lived. Often one default + a few specialized (fast, archival). |
| **PersistentVolume (PV)** | A real chunk of storage in the cluster. | Either pre-created by an admin (**static**) or auto-created by the StorageClass (**dynamic** — far more common). |
| **PersistentVolumeClaim (PVC)** | A Pod's *request* for storage of some size/access mode. | Namespaced. Survives Pod deletion. |

### Dynamic provisioning (the common case)

1. You write a **PVC** asking for 5 GB.
2. Kubernetes finds a matching **StorageClass** (your specified one, or the default).
3. The StorageClass's provisioner creates a **PV** (a real disk in your cloud, or a hostPath, etc.).
4. The PV is **bound** to the PVC.
5. The Pod mounts the PVC.

You almost never write PVs by hand on managed Kubernetes — the StorageClass does it.

### Access modes

| Mode | Meaning |
|------|---------|
| `ReadWriteOnce` (RWO) | One **node** mounts it read/write. Most cloud block devices (EBS, PD). |
| `ReadOnlyMany` (ROX) | Many nodes mount it read-only. |
| `ReadWriteMany` (RWX) | Many nodes read/write — needs NFS, EFS, CephFS, AzureFile. |
| `ReadWriteOncePod` (RWOP) | Only one **Pod** at a time can mount it. |

### Reclaim policy

When a PVC is deleted, what happens to the PV?

- `Delete` (default for dynamic): the real disk is destroyed.
- `Retain`: the PV is kept around for manual recovery — useful for production data.

---

## StatefulSet: the controller for stateful workloads

A StatefulSet gives each replica:

1. **Stable name** — `counter-0`, `counter-1`, `counter-2` (predictable, sticky).
2. **Stable DNS** — `counter-0.counter.default.svc.cluster.local` via a **headless Service**.
3. **Its own PVC** — created automatically from `volumeClaimTemplates`. PVC names are `<vct>-<pod>` (e.g. `data-counter-0`).
4. **Ordered start, stop, update** — `0` comes up first, then `1`, then `2`. Reverse for shutdown.

When `counter-1` is deleted, the StatefulSet recreates a Pod named **`counter-1`** that **re-mounts the same PVC `data-counter-1`**. The state is preserved.

### Deployment vs StatefulSet

| | Deployment | StatefulSet |
|---|---|---|
| Pod name | random hash | ordinal: `name-0`, `name-1`, ... |
| Pod identity | interchangeable | stable per Pod |
| Storage | typically none (or shared) | per-Pod PVC |
| Update order | parallel | one at a time, ordered |
| Use for | stateless web/API | DBs, queues, stateful clusters |

### When NOT to use a StatefulSet

If you don't need stable identity or per-Pod storage, use a Deployment + a single shared PVC (or no PVC). StatefulSets are heavier and updates are slower.

---

## Headless Service

A regular Service has one cluster IP that load-balances across all Pods. For StatefulSets, you often want **direct addressing** of each Pod by DNS. That's a **headless Service** — `clusterIP: None`. DNS returns the individual Pod IPs:

```
counter-0.counter   → 10.244.0.5
counter-1.counter   → 10.244.0.6
counter-2.counter   → 10.244.0.7
```

You typically pair a StatefulSet with **two** Services:

- A **headless** Service for peer-to-peer (used inside the StatefulSet).
- A regular Service (ClusterIP/NodePort/LB) for outside clients who don't care which replica.

---

## What's in this folder

The demo is a tiny counter app. Each Pod stores its counter in `/data/counter.txt`. With a StatefulSet + PVC, the counter survives Pod restart, *and* each Pod has its own counter.

```
statefulsets-storage/
├── backend/
│   ├── server.js                       # GET / and POST /inc, reads/writes /data/counter.txt
│   ├── package.json, Dockerfile
│   ├── 01-storageclass.yaml            # (optional) example StorageClass
│   ├── 02-statefulset.yaml             # headless Svc + LB Svc + StatefulSet w/ volumeClaimTemplates
│   └── 03-static-pvc-example.yaml      # standalone PVC, for reference (not used here)
├── frontend/
│   ├── index.html, Dockerfile          # button UI showing per-Pod counters
│   └── frontend.yaml
└── README.md
```

---

## Prerequisites

- Docker, `kubectl`, local cluster.
- A working default **StorageClass**. Check:
  ```bash
  kubectl get storageclass
  ```
  minikube has `standard` by default. kind has `standard` after `kubectl apply -f` the local-path-provisioner. Docker Desktop has `hostpath`.

---

## How to run

### 1. Build images

```bash
eval $(minikube docker-env)   # minikube only

cd backend  && docker build -t stateful-counter:1.0 .
cd ../frontend && docker build -t stateful-counter-ui:1.0 .
```

(kind: `kind load docker-image ...`)

### 2. Apply

```bash
kubectl apply -f backend/02-statefulset.yaml
kubectl apply -f frontend/frontend.yaml
```

### 3. Watch ordered startup

```bash
kubectl get pods -l app=counter -w
```

Notice Pods start **one at a time, in order**: `counter-0` → `counter-1` → `counter-2`.

### 4. Inspect the auto-created PVCs

```bash
kubectl get pvc
# data-counter-0   Bound   pvc-xxx   1Gi   RWO   ...
# data-counter-1   Bound   pvc-yyy   1Gi   RWO   ...
# data-counter-2   Bound   pvc-zzz   1Gi   RWO   ...

kubectl get pv
```

One PVC and one PV per Pod, generated from the `volumeClaimTemplates`.

### 5. Use the app

```bash
NODE_IP=$(minikube ip)
curl http://$NODE_IP:30093/                     # GET — load-balanced
curl -X POST http://$NODE_IP:30093/inc          # POST — also load-balanced
```

Or open `http://$NODE_IP:30094` and click **Increment 10x**.

You'll see the same Pod's counter staying consistent — increments to `counter-0` are persisted to its disk; `counter-1`'s disk has its own value.

### 6. Test persistence: kill a Pod

```bash
kubectl delete pod counter-1
kubectl get pods -l app=counter -w
```

A new Pod **named `counter-1`** comes up. It re-mounts **`data-counter-1`**. Hit the API again — the counter for that Pod is still there.

### 7. Reach a specific Pod via the headless Service

From inside the cluster, every Pod has a DNS name:

```bash
kubectl run dbg --rm -it --image=curlimages/curl -- sh
# then inside:
nslookup counter
nslookup counter-0.counter
curl http://counter-0.counter
curl -X POST http://counter-1.counter/inc
```

### 8. Scale up / down

```bash
kubectl scale statefulset/counter --replicas=5
kubectl get pods -l app=counter -w
```

New Pods are `counter-3`, then `counter-4`, each with a fresh PVC.

Scaling **down** removes Pods in reverse order. **The PVCs are kept** by default — you can scale back up and recover the data. Delete them explicitly with `kubectl delete pvc data-counter-4` if you want them gone.

### 9. Delete the StatefulSet without losing data

```bash
kubectl delete statefulset counter
kubectl get pvc                       # still there!
# Re-apply: data is back.
kubectl apply -f backend/02-statefulset.yaml
```

---

## Useful commands

```bash
kubectl get statefulset
kubectl describe statefulset counter
kubectl get pods -l app=counter -o wide
kubectl get pvc
kubectl get pv
kubectl get storageclass
kubectl rollout status statefulset/counter
kubectl rollout history statefulset/counter

# Inspect a PVC -> which PV?
kubectl get pvc data-counter-0 -o jsonpath='{.spec.volumeName}'

# Grow a PVC (if StorageClass allows expansion)
kubectl edit pvc data-counter-0           # bump spec.resources.requests.storage
```

---

## Cleanup

```bash
kubectl delete -f frontend/frontend.yaml
kubectl delete -f backend/02-statefulset.yaml

# StatefulSet PVCs are NOT auto-deleted — wipe them:
kubectl delete pvc -l app=counter
```

---

## Key takeaways

1. **PV / PVC / StorageClass** is the storage layer. You ask via PVC; the StorageClass provisions a PV; the Pod mounts the PVC.
2. **`accessModes`** matters: most cloud block storage is `ReadWriteOnce` — single-node RW.
3. **StatefulSet** = Deployment that also gives each Pod a stable name, hostname, and PVC.
4. Pods of a StatefulSet start/update/stop **in order** and can be addressed individually via a **headless Service**.
5. **PVCs survive** Pod deletion and even StatefulSet deletion. To delete the data you must delete the PVCs explicitly.
6. For production stateful apps (Postgres, Kafka, etc.) you almost always use an **operator** — don't hand-roll the StatefulSet.

**Back to** [course index](../README.md)
