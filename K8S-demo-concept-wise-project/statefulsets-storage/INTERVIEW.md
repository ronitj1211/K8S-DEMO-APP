# Interview Questions — StatefulSets, Storage, PVCs

---

## Basic

### Q1. What's a StatefulSet?
A controller for **stateful** workloads. It guarantees:
- **Stable, ordered names**: `pod-0`, `pod-1`, `pod-2`.
- **Stable per-Pod DNS** via a headless Service.
- **Each Pod gets its own PersistentVolumeClaim** (from `volumeClaimTemplates`).
- **Ordered start, stop, and rolling updates** — `pod-0` before `pod-1` before `pod-2`.

Used for: databases, distributed queues, anything where Pods aren't interchangeable.

### Q2. StatefulSet vs Deployment?
| | Deployment | StatefulSet |
|---|---|---|
| Pod identity | random suffix | stable index (0, 1, …) |
| Per-Pod storage | shared / none | each gets its own PVC |
| Startup order | parallel | sequential |
| Use case | stateless | stateful (DB, queue) |

### Q3. What's a PersistentVolume (PV) and PersistentVolumeClaim (PVC)?
- **PV** — a piece of storage in the cluster, provisioned by an admin or dynamically by a StorageClass.
- **PVC** — a request for storage by a Pod. Specifies size and access mode.

Binding: a PVC binds to one PV that satisfies its requirements. Pod mounts the PVC. The Pod doesn't know which PV it got.

### Q4. What's a StorageClass?
The template for **dynamic** provisioning. It says "when a PVC asks for storage in class `gp3`, use provisioner X with these parameters." K8s creates the PV (and the underlying disk) on demand. Each cluster typically has a default StorageClass (k3s ships with `local-path`).

### Q5. Access modes?
- `ReadWriteOnce` (RWO) — mountable RW by one node at a time. Most cloud block storage (EBS, GCE PD).
- `ReadOnlyMany` (ROX) — mountable RO by many nodes.
- `ReadWriteMany` (RWX) — mountable RW by many nodes. Requires NFS, EFS, Azure Files, etc.
- `ReadWriteOncePod` (RWOP) — RW by exactly one Pod (newer than RWO; stricter).

### Q6. What's `volumeClaimTemplates`?
A field on the StatefulSet that auto-creates a PVC per Pod. PVC names follow `<template-name>-<sts-name>-<ordinal>`, e.g., `data-counter-0`. Deleting the StatefulSet does **not** delete these PVCs by default — they're considered precious.

### Q7. What's a "headless" Service in this context?
`spec.clusterIP: None` — DNS resolves to all Pod IPs (no virtual IP). For a StatefulSet, this also gives **per-Pod DNS** like `pod-0.svc.<ns>.svc.cluster.local`. The StatefulSet's `serviceName` field must reference the headless Service.

### Q8. What's `reclaimPolicy` on a PV?
What happens when the PVC is deleted:
- **`Delete`** — the PV and the underlying storage are deleted. Default for dynamic provisioning.
- **`Retain`** — the PV stays but moves to `Released` phase. An admin must clean up. Use for "I want a chance to back up before deleting."
- **`Recycle`** — deprecated.

---

## Intermediate

### Q9. Why does a StatefulSet start Pods one at a time?
Many stateful systems need this: leader election, sequential replication, primary-then-secondary setup. The default `podManagementPolicy: OrderedReady` enforces it. Set `Parallel` if your app doesn't need ordering — Pods come up concurrently, names are still stable.

### Q10. Can you scale a StatefulSet down without losing data?
Yes. Scaling from 5 → 3 deletes `pod-4` and `pod-3` but **keeps their PVCs**. Scaling back to 5 reattaches the same PVCs to new Pods with the same names. The data is preserved unless you explicitly delete the PVCs.

### Q11. `persistentVolumeClaimRetentionPolicy` — what does it do?
A StatefulSet field (stable in 1.27) that controls PVC lifecycle:
- `whenScaled: Retain | Delete` — what happens when scaling down.
- `whenDeleted: Retain | Delete` — what happens when the StatefulSet itself is deleted.

Default is `Retain` for both — change to `Delete` if your tests / dev environments shouldn't pile up PVCs.

### Q12. What's `WaitForFirstConsumer` volume binding mode?
A StorageClass setting. With `Immediate`, a PVC binds and provisions immediately — possibly on the wrong zone for the Pod. With `WaitForFirstConsumer`, binding is deferred until a Pod actually consumes the PVC — the provisioner picks a zone/topology that matches the Pod's placement. Required for multi-zone clusters.

### Q13. Can you change a StatefulSet's volume size?
Sometimes. The StorageClass must have `allowVolumeExpansion: true`. Then edit the PVC's `resources.requests.storage` — the provisioner resizes the underlying disk. Some filesystems require online resize (works on GCE PD, AWS EBS); some need a Pod restart. **You cannot resize via the StatefulSet's `volumeClaimTemplates`** directly in older versions — you have to patch the PVCs and let the StatefulSet's next Pod use the new template.

### Q14. Headless Service — DNS specifics?
- `svc-name.ns.svc.cluster.local` → SRV records of all Pod endpoints.
- `pod-name.svc-name.ns.svc.cluster.local` → A record of one specific Pod's IP.

Apps that need to enumerate cluster members (e.g., a Cassandra node discovering its peers) use the SRV records.

### Q15. What's the difference between `subPath` and a full mount?
`subPath` mounts a specific subdirectory or file from a volume — useful if many Pods share a PVC but each wants its own directory. Combined with `volumeMounts`, you can layout a single PV like:
```
/data/pod-0/
/data/pod-1/
```
… and each Pod sees its own `/data` (via `subPath: pod-0`, etc.). But for StatefulSets, the more common pattern is one PVC per Pod via `volumeClaimTemplates`.

### Q16. How does the kube-controller-manager handle a stuck `Terminating` Pod with a PVC?
If the node is unreachable, the controller waits for the kubelet to confirm Pod termination — otherwise it can't safely detach the volume (could cause split-brain RWO mounts). You can force-delete with `kubectl delete pod <pod> --grace-period=0 --force` — but data corruption is on you. Usually you wait for the node-monitor-grace-period to expire.

---

## Scenario-based

### S1. Your database StatefulSet's `pod-0` is stuck in `Pending`. PVC also `Pending`.
Likely the PVC can't bind:
- **No matching StorageClass**: PVC names a non-existent class or the StorageClass needs `WaitForFirstConsumer` and the Pod can't schedule.
- **No PV** with capacity/access mode large enough.
- **Quota** exceeded.

`kubectl describe pvc data-pod-0` — events tell you. On cloud, "could not find suitable disk" usually means zone/IAM/EBS quota.

### S2. You deleted the StatefulSet but the PVCs are still there. Is that a bug?
No — it's intentional protection against data loss. To clean up:
```bash
kubectl delete pvc -l app=mydb
```
Or set `persistentVolumeClaimRetentionPolicy.whenDeleted: Delete` for ephemeral environments.

### S3. Your Cassandra cluster needs each node to discover the others. Service or DNS?
**Headless Service.** Cassandra reads `seeds: cassandra-0.cassandra,cassandra-1.cassandra`. Each `pod-N` has a stable DNS name. A regular ClusterIP Service would only give you a single VIP — Cassandra needs individual addresses for seed discovery and gossip.

### S4. A StatefulSet rolls out, and `pod-2` crashes during update. What happens to `pod-1` and `pod-0`?
With the default `OrderedReady` policy, the rolling update goes from highest ordinal to lowest. `pod-2` is updated first; if it fails (probe times out, image bad), the rollout **halts**. `pod-1` and `pod-0` stay on the old version, still serving. This is intentional — don't take down the whole cluster on a bad rollout. Fix `pod-2` or `kubectl rollout undo`.

### S5. Recover from a PV in `Released` state (PVC deleted, but `reclaimPolicy: Retain`).
1. Inspect the underlying storage (EBS volume, etc.) for usable data.
2. Edit the PV: clear `spec.claimRef`.
3. The PV becomes `Available` again — a new PVC matching its size/StorageClass can bind to it (if you pre-create with `volumeName: <pv>`).
4. Mount it into a recovery Pod and copy data out, or directly hand it to the new workload.

### S6. You moved from EBS gp2 to gp3. How to migrate StatefulSet PVCs?
Two main paths:
- **In-place via volume expansion / type change** if the cloud supports it (AWS allows changing EBS type without re-creating). Then update the StorageClass annotation for new PVs.
- **Snapshot + restore**: take a VolumeSnapshot of each PVC, create a new PVC from the snapshot with the new StorageClass, shut down the old Pod, attach the new PVC. Slower but works across regions / providers.

Don't blindly delete PVCs — data goes with them.

### S7. Pod is stuck `ContainerCreating` with `MountVolume.SetUp failed for volume "data": ... multi-attach error`.
The PVC is RWO and another node still has it attached. Common after a hard node crash where the cloud doesn't auto-detach. Fix:
- Wait for the cloud to time-out the attachment (a few minutes on AWS).
- Force-detach from the old node via cloud API.
- For known good cases, use `force-delete` on the old Pod *only after* confirming the node is truly down.

### S8. A StatefulSet's headless DNS isn't resolving the per-Pod name (`pod-0.svc.ns.svc.cluster.local` → NXDOMAIN).
Three checks:
- `Service.spec.clusterIP` must be `None`.
- `StatefulSet.spec.serviceName` must match the Service name exactly.
- The Pod must be `Ready` — DNS for non-Ready Pods is gated by `publishNotReadyAddresses` on the Service (default false). For init/discovery use cases, set `publishNotReadyAddresses: true`.
