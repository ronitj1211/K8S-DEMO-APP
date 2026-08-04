

## 10. Interview Q&A — PersistentVolumes & PVCs (with scenarios)

### Basic

**Q1. What is a PersistentVolume (PV)?**
A cluster-scoped object representing an actual piece of storage — an EBS volume, NFS share, or local disk — independent of any Pod's lifecycle.

*Scenario:* An admin at a bank pre-creates a PV pointing at `nfs-audit-01.bank.internal:/exports/audit-logs`. That PV exists in the cluster as an object regardless of whether any app is using it yet — it's infrastructure, not tied to a workload.

**Q2. What is a PersistentVolumeClaim (PVC)?**
A namespaced request for storage — "give me 10Gi, ReadWriteOnce." Pods never mount a PV directly; they always mount a PVC, and the PV controller does the matching/binding behind the scenes.

*Scenario:* A developer writes `postgres-data-pvc` asking for 20Gi. They never specify which disk — Kubernetes resolves that.

**Q3. What is a StorageClass?**
A cluster-scoped "recipe" for dynamic provisioning — names a `provisioner` (CSI driver), disk parameters, reclaim policy, and binding mode.

*Scenario:* EKS ships a default `gp3` StorageClass using `provisioner: ebs.csi.aws.com`. Every PVC that doesn't specify a class falls back to this one automatically.

**Q4. Static vs dynamic provisioning?**
Static: admin pre-creates PVs; PVCs bind to existing PVs. Dynamic: user creates a PVC only; a StorageClass provisioner auto-creates the PV plus the underlying disk. Dynamic is the standard on managed Kubernetes (EKS, GKE, AKS).

*Scenario:* Same cluster, two PVCs — one with `storageClassName: ""` (static-only, binds to a pre-made PV or stays `Pending`), one with `storageClassName: gp3` (dynamic, EBS volume auto-created in seconds). Same cluster, two totally different outcomes, purely from that one field.

**Q5. What are access modes?**

| Mode | Meaning | Example backend |
|---|---|---|
| RWO | One node, read-write | EBS, GCE PD |
| ROX | Many nodes, read-only | shared config/reference data |
| RWX | Many nodes, read-write | NFS, EFS |
| RWOP | One Pod (not node) RW, cluster-wide | newer, stricter than RWO |

*Scenario:* Two Pods on the same node both mounting an RWO EBS volume works fine (RWO restricts by node, not by Pod count) — but the moment the scheduler places a third replica on a different node, that Pod fails to mount with a Multi-Attach error.

**Q6. What is reclaim policy?**
Controls what happens to the PV/disk when the PVC is deleted: `Delete` destroys the PV and underlying storage (dynamic default); `Retain` keeps the PV in `Released` state for manual recovery.

*Scenario:* A team accidentally runs `kubectl delete pvc postgres-data-pvc` on a StorageClass with `reclaimPolicy: Delete`. The EBS volume is gone permanently within seconds — this is exactly why production StorageClasses should almost always use `Retain`.

**Q7. Can a Deployment with 3 replicas share one RWO PVC?**
No, not safely across nodes. RWO allows one node to attach RW. Only Pods on that same node can mount it; Pods scheduled to other nodes fail with multi-attach errors. Use RWX storage or one PVC per Pod (StatefulSet).

*Scenario:* You scale a Deployment from 1 → 3 replicas. Replicas 1 and 2 land on node-a and mount fine (RWO is node-scoped, so sharing within a node is fine). Replica 3 lands on node-b — `kubectl describe pod` shows `Multi-Attach error for volume "pvc-xxxx" ... already exclusively attached to one node`. Fix: RWX storage (NFS/EFS) or move to a StatefulSet with `volumeClaimTemplates`.

**Q8. Does deleting a Pod delete the PVC?**
No. PVCs are independent objects. Deleting a Deployment does not delete its PVCs unless configured otherwise. Data persists until the PVC is explicitly deleted.

*Scenario:* A Postgres Pod crashes and gets rescheduled by its Deployment controller. The new Pod comes up, references the same PVC name, and reattaches to the same data — nothing was lost, because the PVC (and its underlying disk) outlived the Pod entirely.

### Intermediate

**Q9. What is `volumeBindingMode: WaitForFirstConsumer`?**
Delays PVC binding/provisioning until a Pod that uses the PVC is scheduled. Ensures the disk is created in the same zone/topology as the Pod. Essential for multi-AZ block storage.

*Scenario:* Without this (`Immediate` mode), a PVC could get an EBS volume provisioned in `us-east-1a`, but the scheduler then places the Pod in `us-east-1b` based on other constraints — EBS volumes can't attach cross-zone, so the Pod gets stuck `Pending` permanently. `WaitForFirstConsumer` avoids this by waiting to know the Pod's zone first.

**Q10. What happens when a PVC is deleted with `reclaimPolicy: Retain`?**
The PV enters `Released` state. The underlying disk still exists. An admin must clear `spec.claimRef` on the PV before it can bind to a new PVC, or manually recover data.

*Scenario:* A team deletes `old-analytics-pvc` by mistake but the StorageClass is `Retain`. The disk and data are intact — `kubectl get pv` shows `Released`. To recover: `kubectl edit pv <name>`, remove `spec.claimRef`, then create a new PVC matching size/access mode — it binds to the recovered PV with original data untouched.

**Q11. How do you expand a PVC?**
If `StorageClass.allowVolumeExpansion: true`, patch the PVC to increase `spec.resources.requests.storage`. The CSI resizer expands the cloud disk and filesystem. You cannot shrink.

*Scenario:* A Postgres PVC starts at 20Gi but usage grows to 18Gi:
```bash
kubectl patch pvc postgres-data-pvc -p '{"spec":{"resources":{"requests":{"storage":"50Gi"}}}}'
```
No downtime for most modern CSI drivers — some older drivers required a Pod restart to trigger filesystem-level resize.

**Q12. What is CSI?**
Container Storage Interface — a standard plugin API for storage. CSI drivers run as external components (controller + node plugin) instead of in-tree code in Kubernetes. All major cloud block/file storage uses CSI now.

*Scenario:* A company migrates from AWS to GCP. Instead of Kubernetes core needing hardcoded logic per cloud (the old in-tree approach), they swap the installed CSI driver and change `provisioner` in the StorageClass — the PVC/PV/Pod YAML above that layer stays identical.

**Q13. Why is my PVC stuck in Pending?**
Common causes: no default StorageClass and none specified on the PVC; StorageClass name typo; provisioner not installed or failing; insufficient quota or cloud permissions; `WaitForFirstConsumer` with no Pod referencing the PVC yet. Check `kubectl describe pvc <name>` — the Events section tells you.

*Scenario:* A manifest written for EKS (`storageClassName: gp3`) gets applied to a local k3s cluster with no AWS CSI driver installed.
```
Warning  ProvisioningFailed  ... no CSI driver found for provisioner "ebs.csi.aws.com"
```
The PVC (and any Pod using it) sits `Pending` indefinitely until the driver is installed or the manifest is adjusted for the actual cluster.

**Q14. What is a VolumeSnapshot?**
A point-in-time copy of a PVC's data. Used for backup, clone, and migration. Requires a CSI driver with snapshot support and a `VolumeSnapshotClass`.

*Scenario:* Before a risky schema migration, a team snapshots their production Postgres PVC via a `VolumeSnapshot` referencing `postgres-data-pvc`. If the migration fails, they restore a new PVC from the snapshot instead of losing hours of data.

**Q15. PVC protection finalizer — why does delete hang?**
Kubernetes adds `kubernetes.io/pvc-protection` while a Pod uses the PVC. Delete the Pod (or remove the volume from its spec) first, then delete the PVC.

*Scenario:* `kubectl delete pvc my-pvc` hangs in `Terminating`. `kubectl describe pvc my-pvc` shows the finalizer still attached because `my-app-7x2k9` still mounts it. Deleting that Pod clears the finalizer and the PVC deletion proceeds.

### Scenario-based

**S1. Pod stuck `ContainerCreating` with "Multi-Attach error for volume"**
RWO volume is still attached to another node — usually after a node crash. Wait for the cloud detach timeout, or force-detach via the cloud console. Do not force-delete Pods on healthy nodes without understanding the risk — the wait exists to prevent two nodes writing to the same disk simultaneously (data corruption).

**S2. StatefulSet Pod Pending, PVC also Pending**
PVC cannot bind — wrong StorageClass, missing provisioner, or zone mismatch. `kubectl describe pvc` for events; fix the StorageClass or install the CSI driver.

*Scenario:* A 5-replica StatefulSet has replicas 0-2 running, but replica 3's auto-generated PVC (`data-my-db-3`) is `Pending` because the cloud account hit its EBS volume quota in that region. Raising the quota lets it provision on the next reconciliation.

**S3. You deleted a PVC and lost production data**
Reclaim policy was `Delete` (dynamic default). Prevention: use `Retain` for production StorageClasses, enable VolumeSnapshots, or use an operator that manages backups.

**S4. How to migrate data from one PVC to another?**
1. Create a `VolumeSnapshot` of the source PVC.
2. Create a new PVC from the snapshot (optionally a different StorageClass/size).
3. Update the workload to mount the new PVC.
4. Delete the old PVC after verification.

*Scenario:* A team moves a 100Gi database from a `standard` StorageClass to a faster `io2` class without downtime risk — snapshot, restore into a new PVC on the new class, cut the Deployment over, verify integrity, then remove the old PVC.

**S5. Can two namespaces share a PV?**
Not directly — PVCs are namespaced and bind to one PV. For shared storage, use an RWX backend (NFS/EFS) with separate PVCs in each namespace pointing at the same underlying export, or use a single PVC in one namespace exposed via API.

*Scenario:* `team-a` and `team-b` both need read access to a shared reference dataset on EFS. Each namespace gets its own PVC/PV pair, both configured against the same EFS access point — two Kubernetes objects, one shared filesystem underneath.

**S6. Pod rescheduled to a new node — will RWO PVC follow?**
Yes, but attach/detach takes time. The AttachDetach controller detaches from the old node and attaches to the new one. During this window the Pod may be `ContainerCreating`. If the old node is `NotReady`, Kubernetes waits for the node timeout (~5 minutes default) before reattaching elsewhere.

*Scenario:* A node running a Postgres Pod gets drained for a routine upgrade — reattachment typically takes 10-30 seconds on AWS for a clean drain. An unexpected node crash instead triggers the full timeout wait, for the same data-corruption-prevention reason as S1.

### Quick command reference

```bash
kubectl get storageclass,pv,pvc
kubectl describe pvc <name>
kubectl describe pv <name>
kubectl get events --field-selector involvedObject.name=<name>
```
