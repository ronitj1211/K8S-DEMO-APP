# Interview Questions — PersistentVolumes & PVCs

---

## Basic

### Q1. What is a PersistentVolume (PV)?
A cluster-scoped object representing a piece of storage in the cluster — a cloud disk, NFS share, or local path. It is the actual storage resource.

### Q2. What is a PersistentVolumeClaim (PVC)?
A namespaced object that requests storage (size, access mode, StorageClass). Pods mount PVCs, not PVs directly. The binder pairs a PVC with a matching PV.

### Q3. What is a StorageClass?
A cluster-scoped template for dynamic provisioning. It specifies the provisioner (CSI driver), parameters (disk type, IOPS), reclaim policy, binding mode, and whether expansion is allowed.

### Q4. Static vs dynamic provisioning?
- **Static**: admin pre-creates PVs; PVCs bind to existing PVs.
- **Dynamic**: user creates PVC only; StorageClass provisioner auto-creates PV + underlying disk.

Dynamic is the standard on managed Kubernetes (EKS, GKE, AKS).

### Q5. What are access modes?
- `ReadWriteOnce` (RWO) — one node RW (EBS, GCE PD).
- `ReadOnlyMany` (ROX) — many nodes RO.
- `ReadWriteMany` (RWX) — many nodes RW (NFS, EFS).
- `ReadWriteOncePod` (RWOP) — one Pod RW cluster-wide.

### Q6. What is reclaim policy?
Controls what happens to the PV/disk when the PVC is deleted:
- `Delete` — destroy PV and underlying storage (dynamic default).
- `Retain` — keep PV in `Released` for manual recovery.

### Q7. Can a Deployment with 3 replicas share one RWO PVC?
No (not safely across nodes). RWO allows one node to attach RW. Only one Pod on that node could mount it; Pods on other nodes will fail with multi-attach errors. Use RWX storage or one PVC per Pod (StatefulSet).

### Q8. Does deleting a Pod delete the PVC?
No. PVCs are independent objects. Deleting a Deployment does not delete its PVCs unless you configure otherwise. Data persists until you explicitly delete the PVC.

---

## Intermediate

### Q9. What is `volumeBindingMode: WaitForFirstConsumer`?
Delays PVC binding/provisioning until a Pod that uses the PVC is scheduled. Ensures the disk is created in the same zone/topology as the Pod. Essential for multi-AZ block storage.

### Q10. What happens when a PVC is deleted with reclaimPolicy `Retain`?
The PV enters `Released` state. The underlying disk still exists. An admin must clear `spec.claimRef` on the PV before it can bind to a new PVC, or manually recover data.

### Q11. How do you expand a PVC?
If `StorageClass.allowVolumeExpansion: true`, patch the PVC to increase `spec.resources.requests.storage`. The CSI resizer expands the cloud disk and filesystem. You cannot shrink.

### Q12. What is CSI?
Container Storage Interface — a standard plugin API for storage. CSI drivers run as external components (controller + node plugin) instead of in-tree code in Kubernetes. All major cloud block/file storage uses CSI now.

### Q13. Why is my PVC stuck in Pending?
Common causes:
- No default StorageClass and none specified on PVC.
- StorageClass name typo (PVC references non-existent class).
- Provisioner not installed or failing (check provisioner Pod logs).
- Insufficient quota or cloud permissions.
- `WaitForFirstConsumer` but no Pod references the PVC yet.

Check: `kubectl describe pvc <name>` — Events section tells you.

### Q14. What is a VolumeSnapshot?
A point-in-time copy of a PVC's data. Used for backup, clone, and migration. Requires a CSI driver with snapshot support and `VolumeSnapshotClass`.

### Q15. PVC protection finalizer — why does delete hang?
Kubernetes adds `kubernetes.io/pvc-protection` while a Pod uses the PVC. Delete the Pod (or remove the volume from its spec) first, then delete the PVC.

---

## Scenario-based

### S1. Pod stuck ContainerCreating with "Multi-Attach error for volume"
RWO volume is still attached to another node — usually after a node crash. Wait for cloud detach timeout, or force-detach via cloud console. Do not force-delete Pods on healthy nodes without understanding the risk.

### S2. StatefulSet Pod Pending, PVC also Pending
PVC cannot bind — wrong StorageClass, missing provisioner, or zone mismatch. `kubectl describe pvc` for events. Fix StorageClass or install the CSI driver.

### S3. You deleted a PVC and lost production data
Reclaim policy was `Delete` (dynamic default). Prevention: use `Retain` for production StorageClasses, enable VolumeSnapshots, or use an operator that manages backups.

### S4. How to migrate data from one PVC to another?
1. Create VolumeSnapshot of source PVC.
2. Create new PVC from snapshot (optionally different StorageClass/size).
3. Update workload to mount new PVC.
4. Delete old PVC after verification.

### S5. Can two namespaces share a PV?
Not directly — PVCs are namespaced and bind to one PV. For shared storage, use RWX backend (NFS/EFS) with separate PVCs in each namespace pointing at the same underlying export, or use a single PVC in one namespace and expose via API.

### S6. Pod rescheduled to a new node — will RWO PVC follow?
Yes, but attach/detach takes time. AttachDetach controller detaches from old node, attaches to new node. During this window the Pod may be ContainerCreating. If old node is NotReady, wait for node timeout or manual detach.

---

## Quick command reference

```bash
kubectl get storageclass,pv,pvc
kubectl describe pvc <name>
kubectl describe pv <name>
kubectl get events --field-selector involvedObject.name=<pvc-name>
```
