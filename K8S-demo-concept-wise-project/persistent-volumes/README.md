# PersistentVolumes (PV) & PersistentVolumeClaims (PVC)

## Why these exist

Pods are ephemeral. When a Pod is deleted, everything in its container filesystem is gone. That is fine for stateless APIs, but not for:

- Application data (uploads, SQLite, local caches you cannot rebuild)
- Logs you must keep across restarts
- Any workload that writes to disk and expects that disk tomorrow

Kubernetes separates **compute** (Pods) from **storage** (PV/PVC). A Pod can die; the PVC (and the data on its bound PV) survives.

---

## The three storage objects

```
        Pod
         │ mounts
         ▼
       PVC  ── "I need 2 GiB, ReadWriteOnce"
         │ bound to
         ▼
        PV   ── actual disk (EBS, GCE PD, hostPath, NFS, …)
         │ provisioned via
         ▼
   StorageClass  ── "use AWS gp3 with these defaults"
```

| Object | Scope | Role |
|--------|-------|------|
| **StorageClass** | Cluster | Recipe for *how* to provision storage (provisioner, parameters, reclaim policy, binding mode). |
| **PersistentVolume (PV)** | Cluster | A real chunk of storage. Pre-created by an admin (**static**) or auto-created by a StorageClass (**dynamic**). |
| **PersistentVolumeClaim (PVC)** | Namespace | A Pod's *request* for storage. Specifies size, access mode, and optionally a StorageClass. |

The Pod never talks to the PV directly — it mounts the PVC. The PVC controller binds the claim to a matching PV.

---

## Static vs dynamic provisioning

### Dynamic (the common case)

1. You create a **PVC** asking for 2 GiB.
2. Kubernetes finds a matching **StorageClass** (the one you named, or the cluster default).
3. The StorageClass's **provisioner** (usually a CSI driver) creates a **PV** and the underlying disk.
4. The PV binds to the PVC.
5. The Pod mounts the PVC.

You almost never write PV YAML by hand on managed Kubernetes.

### Static (admin-managed)

1. An admin creates a **PV** pointing at existing storage (NFS export, pre-formatted EBS volume, `hostPath` in dev).
2. A user creates a **PVC** that matches the PV's size, access mode, and StorageClass.
3. The binder pairs them. No provisioner runs.

See `backend/04-static-pv-pvc-example.yaml` for a local `hostPath` example.

---

## Access modes

| Mode | Meaning | Typical backend |
|------|---------|-----------------|
| `ReadWriteOnce` (RWO) | One **node** mounts read/write at a time | EBS, GCE PD, Azure Disk |
| `ReadOnlyMany` (ROX) | Many nodes mount read-only | NFS (shared export) |
| `ReadWriteMany` (RWX) | Many nodes read/write | NFS, EFS, Azure Files, CephFS |
| `ReadWriteOncePod` (RWOP) | Exactly one **Pod** mounts RW | Newer block storage classes |

**Important:** Most cloud block storage is RWO. A Deployment with `replicas: 3` sharing one RWO PVC will not work — only one Pod can mount it. Use RWX + NFS/EFS, or one PVC per Pod (StatefulSet `volumeClaimTemplates` — see [statefulsets-storage](../statefulsets-storage/)).

---

## Reclaim policy

When a PVC is deleted, what happens to the PV and the real disk?

| Policy | Behavior | When to use |
|--------|----------|-------------|
| `Delete` | PV and underlying disk are destroyed | Default for dynamic provisioning; dev/test |
| `Retain` | PV stays in `Released` state; admin cleans up manually | Production data you might need to recover |

Set reclaim policy on the **StorageClass** (for dynamic PVs) or on the **PV** itself (for static).

---

## Volume binding modes

| Mode | Behavior |
|------|----------|
| `Immediate` | PVC binds and provisions as soon as it is created — possibly in the wrong zone for your Pod |
| `WaitForFirstConsumer` | Binding waits until a Pod actually uses the PVC — provisioner picks topology matching the Pod's node |

Use `WaitForFirstConsumer` in multi-zone clusters so disks are created in the same zone as the Pod.

---

## What's in this folder

A notes + counter app. One Deployment (single replica) mounts a PVC at `/data`. Data survives Pod deletion.

```
persistent-volumes/
├── backend/
│   ├── server.js
│   ├── 01-storageclass.yaml
│   ├── 02-pvc.yaml
│   ├── 03-deployment.yaml
│   └── 04-static-pv-pvc-example.yaml
├── frontend/
│   ├── index.html
│   └── frontend.yaml
├── README.md
├── INTERNALS.md
├── INTERVIEW.md
├── INTERVIEW-DEEP-DIVE.md
├── PRODUCTION-INCIDENTS.md
└── RUN-STEPS.md
```

---

## Prerequisites

- Docker, `kubectl`, local cluster.
- A working default **StorageClass** (`kubectl get storageclass`).

---

## How to run

### 1. Build images

```bash
eval $(minikube docker-env)   # minikube only

cd backend  && docker build -t pv-demo-backend:1.0 .
cd ../frontend && docker build -t pv-demo-ui:1.0 .
```

### 2. Create the PVC first, then the Deployment

```bash
kubectl apply -f backend/02-pvc.yaml
kubectl apply -f backend/03-deployment.yaml
kubectl apply -f frontend/frontend.yaml
```

### 3. Use the app

```bash
curl http://$(minikube ip):30095/
curl -X POST http://$(minikube ip):30095/inc
```

Open `http://$(minikube ip):30096` for the UI.

### 4. Prove persistence — delete the Pod

```bash
kubectl delete pod -l app=notes
kubectl get pods -l app=notes -w
curl http://$(minikube ip):30095/    # counter + notes survived
```

---

## Cleanup

```bash
kubectl delete -f frontend/frontend.yaml
kubectl delete -f backend/03-deployment.yaml
kubectl delete -f backend/02-pvc.yaml
```

---

## Key takeaways

1. **PVC** = request for storage. **PV** = actual storage. **StorageClass** = how to provision.
2. Pods mount **PVCs**, not PVs directly.
3. **Dynamic provisioning** is the default — you write PVCs, not PVs.
4. **Access modes matter** — RWO cannot be shared across nodes.
5. **PVCs outlive Pods** — delete PVCs explicitly when you want data gone.
6. For per-Pod storage with stable identity, see [statefulsets-storage](../statefulsets-storage/).

**Previous:** [helm](../helm/) · **Next:** [statefulsets-storage](../statefulsets-storage/)
