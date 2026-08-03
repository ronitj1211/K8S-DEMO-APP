# PersistentVolumes & PVCs — Internals

How binding, provisioning, attach/detach, and reclaim actually work under the hood.

---

## Purpose

Separate **compute lifecycle** (Pods come and go) from **storage lifecycle** (disks persist). Applications request storage through a namespaced **PVC**; the cluster provides a cluster-scoped **PV** backed by real infrastructure (cloud disk, NFS, local path).

Without this layer, every Pod restart would wipe application data. With it, you delete a Pod, recreate it, mount the same PVC, and the files are still there.

## The binding controller

Two controllers in `kube-controller-manager` manage storage:

1. **PersistentVolumeClaimBinder** — pairs PVCs with PVs.
2. **PersistentVolumeController** — handles reclaim, protection finalizers.

### Binding rules (static)

A PVC binds to a PV when **all** of these match:

| Requirement | PVC field | PV field |
|-------------|-----------|----------|
| Size | `spec.resources.requests.storage` | `spec.capacity.storage` (PV must be ≥ PVC) |
| Access mode | `spec.accessModes` | `spec.accessModes` (PV must support what PVC asks) |
| StorageClass | `spec.storageClassName` | `spec.storageClassName` (must match, or both empty for legacy) |
| Selector (optional) | `spec.selector` | PV labels must match |

Only one PVC can bind to a PV. Once bound, `spec.claimRef` on the PV points to the PVC.

### Dynamic provisioning flow

```
User creates PVC
       │
       ▼
Provisioner watches PVC (external-provisioner sidecar or in-tree)
       │
       ▼
Provisioner calls cloud API / CSI CreateVolume
       │
       ▼
Provisioner creates PV object with claimRef pre-set
       │
       ▼
Binder marks PVC Bound, PV Bound
       │
       ▼
Pod scheduled → kubelet mounts volume
```

The **StorageClass** tells the provisioner which driver and parameters to use:

```yaml
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  encrypted: "true"
reclaimPolicy: Delete
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
```

## What happens when a Pod mounts a PVC

1. **Scheduler** places the Pod on a node (if `WaitForFirstConsumer`, PVC binding also considers node topology).
2. **AttachDetach controller** tells the cloud/CSI driver to attach the volume to that node.
3. **Kubelet** calls CSI `NodeStageVolume` + `NodePublishVolume` (or in-tree equivalent).
4. Volume appears at the `volumeMounts.mountPath` inside the container.

For **RWO** volumes, attach is exclusive to one node. If another Pod tries to mount the same PVC on a different node, you get a **multi-attach error**.

## Volume binding modes in detail

### Immediate

PVC is provisioned and bound the moment it is created — before any Pod exists. Risk: disk may be created in `us-east-1a` but your Pod schedules to `us-east-1b`. Pod stays Pending with volume zone mismatch.

### WaitForFirstConsumer

PVC stays `Pending` until a Pod that references it is scheduled. The provisioner receives topology hints from the scheduler and creates the disk in the correct zone. Required pattern for multi-AZ EBS/GCE PD.

## Reclaim lifecycle

When you delete a PVC:

| PV reclaimPolicy | What happens |
|------------------|--------------|
| `Delete` | Provisioner deletes the PV object and destroys the underlying disk |
| `Retain` | PV moves to `Released`; `spec.claimRef` remains; admin must manually clean up |

A PV in `Released` state cannot bind to a new PVC until an admin clears `spec.claimRef`.

## Storage protection finalizers

Kubernetes adds finalizers to prevent accidental data loss:

- **PV protection** — PV cannot be deleted while bound to a PVC.
- **PVC protection** — PVC cannot be deleted while in use by a Pod.

This is why `kubectl delete pvc foo` hangs if a Pod still mounts it — you must delete the Pod first (or remove the volume from the Pod spec).

## CSI vs in-tree provisioners

Modern clusters use **CSI** (Container Storage Interface) drivers:

```
API Server
    │
    ├── external-provisioner  → CreateVolume → cloud API
    ├── external-attacher     → ControllerPublishVolume
    └── kubelet + CSI node plugin → NodeStage/Publish
```

In-tree provisioners (deprecated) lived inside Kubernetes itself. EBS, GCE PD, Azure Disk all moved to CSI. You install the driver as a DaemonSet + controller Deployment.

## Volume expansion

If `StorageClass.allowVolumeExpansion: true`:

1. Edit PVC: bump `spec.resources.requests.storage`.
2. **external-resizer** sidecar calls CSI `ControllerExpandVolume`.
3. Cloud resizes the disk.
4. Node plugin may need to expand the filesystem (`NodeExpandVolume`).
5. Some setups require a Pod restart for the OS to see the new size.

You cannot shrink a PVC.

## Access modes — what the kubelet enforces

| Mode | Kubelet behavior |
|------|------------------|
| RWO | Only one node may have the volume attached RW |
| ROX | Multiple nodes may mount RO |
| RWX | Multiple nodes may mount RW — requires shared filesystem backend |
| RWOP | Only one Pod cluster-wide may mount RW (stricter than RWO) |

RWO is about **nodes**, not Pods. Two Pods on the **same node** can technically share an RWO volume (not recommended — file locking issues). Two Pods on **different nodes** cannot.

## Common failure modes

| Symptom | Likely cause |
|---------|--------------|
| PVC `Pending` forever | No StorageClass, wrong class name, no provisioner, quota exceeded |
| Pod `Pending` + "unbound PVC" | PVC not bound yet; WaitForFirstConsumer waiting for scheduler |
| Pod `ContainerCreating` + multi-attach | RWO volume still attached to another node (crashed node) |
| Pod `ContainerCreating` + mount timeout | CSI node plugin not running, IAM/permission issue |
| Data gone after PVC delete | reclaimPolicy was `Delete` (default) |

## Relationship to StatefulSets

This folder uses a **Deployment + single PVC** — the simplest PV/PVC pattern.

StatefulSets add **per-Pod PVCs** via `volumeClaimTemplates` and stable Pod identity. The storage primitives (PV, PVC, StorageClass) are identical — only the *ownership model* changes. See [statefulsets-storage/INTERNALS.md](../statefulsets-storage/INTERNALS.md) for the StatefulSet layer.

## Key internals summary

1. **Binder** matches PVC ↔ PV by size, access mode, StorageClass.
2. **Provisioner** (CSI) creates PV + real disk on demand for dynamic StorageClasses.
3. **AttachDetach** ensures RWO volumes attach to exactly one node at a time.
4. **Kubelet** mounts the volume into the container filesystem namespace.
5. **Reclaim policy** on StorageClass/PV determines whether data survives PVC deletion.
6. **Finalizers** prevent deleting PVCs/PVs that are still in use.
