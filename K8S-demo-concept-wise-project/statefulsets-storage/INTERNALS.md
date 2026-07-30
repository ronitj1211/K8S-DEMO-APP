# StatefulSets & Storage — Internals

Ordered Pod lifecycle, per-Pod PVCs from templates, headless-Service DNS, dynamic provisioning via CSI.

---

## Purpose

StatefulSet manages Pods that need **stable identity** and **stable per-Pod storage**. Databases, message queues, distributed systems — anything where "which replica am I" matters.

## The controller loop

The StatefulSet controller watches:
- StatefulSet objects.
- Pods owned by the StatefulSet.
- PVCs created from the STS's `volumeClaimTemplates`.

Reconcile invariants:
1. Pods are created in order: `sts-0` first, then `sts-1`, then `sts-2`.
2. Before creating Pod N+1, Pod N must be **Ready**.
3. Deletion / scale-down is in reverse order: highest ordinal first.
4. Each Pod has a stable name (`<sts-name>-<ordinal>`) and stable DNS record via the headless Service.
5. Each Pod's PVC (from `volumeClaimTemplates`) persists across Pod recreations.

**Order matters** because many stateful systems need it:
- Leader election: `pod-0` becomes primary; others join as followers.
- Bootstrapping: cluster-forming needs a stable seed list.
- Ordered shutdown: shut down followers before the primary.

## The `pod-template-hash` — StatefulSets don't have one

Unlike Deployments, StatefulSets don't create per-revision ReplicaSets. Rolling updates work by directly updating Pods, one at a time, in reverse order.

The revision is tracked by the `controller-revision-hash` label — used to detect drift.

## `volumeClaimTemplates` — one PVC per Pod, automatically

```yaml
spec:
  replicas: 3
  volumeClaimTemplates:
    - metadata: { name: data }
      spec:
        accessModes: [ReadWriteOnce]
        storageClassName: gp3
        resources: { requests: { storage: 10Gi } }
```

For each replica (0, 1, 2), the controller creates a PVC named:
```
<template-name>-<sts-name>-<ordinal>
e.g. data-mydb-0, data-mydb-1, data-mydb-2
```

When Pod `mydb-0` starts, it mounts PVC `data-mydb-0`. Even if Pod `mydb-0` is deleted and recreated, the new Pod also mounts `data-mydb-0` — same disk, same data.

**PVCs are NOT deleted when the StatefulSet scales down.** Scale from 3 → 1: `mydb-2` and `mydb-1` Pods are deleted, but `data-mydb-2` and `data-mydb-1` remain. Scale back to 3: same PVCs re-attach to newly created Pods.

This is intentional — data preservation. To opt into deletion (K8s 1.27+):

```yaml
spec:
  persistentVolumeClaimRetentionPolicy:
    whenDeleted: Delete       # delete PVCs when the STS itself is deleted
    whenScaled: Delete        # delete PVCs when scaling down
```

## Headless Service — per-Pod DNS

The StatefulSet's `spec.serviceName: mydb` refers to a **headless Service**:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: mydb
spec:
  clusterIP: None           # headless
  selector:
    app: mydb
  ports:
    - port: 5432
```

`clusterIP: None` means no virtual IP is allocated. DNS resolution behaves differently:

- **Service name** `mydb.default.svc.cluster.local` → CoreDNS returns A records for **each Pod**'s IP.
- **Per-Pod name** `mydb-0.mydb.default.svc.cluster.local` → CoreDNS returns just that Pod's IP.
- SRV records include port info + Pod name — enabling clients to enumerate the cluster.

**Effect**: clients can reach specific replicas. Postgres primary at `mydb-0.mydb.default.svc`, followers at `mydb-1.mydb.default.svc`, `mydb-2.mydb.default.svc`.

**In CoreDNS's logic**: for headless Services, when you query the Service name, CoreDNS enumerates the EndpointSlices and returns all Pod IPs. Without the headless mode, Services return one virtual IP (kube-proxy load-balances internally).

## Pod ordinals and startup

Ordinals are the numeric suffix: `mydb-0`, `mydb-1`, `mydb-2`. Available inside the Pod via:

```
hostname                     # mydb-0
$POD_NAME                    # if you set it via downward API
```

Applications parse the hostname to know their identity:
```bash
if [ "$HOSTNAME" = "mydb-0" ]; then
  ./run-as-primary.sh
else
  ./run-as-replica.sh
fi
```

**Startup order (default OrderedReady)**:
1. Create Pod `mydb-0`. Wait for `Ready` condition.
2. Create Pod `mydb-1`. Wait for `Ready`.
3. Create Pod `mydb-2`. Wait for `Ready`.

**Parallel option** (`spec.podManagementPolicy: Parallel`):
Create all Pods at once. Order-agnostic apps use this to bootstrap faster.

## Rolling updates — reverse-ordinal

Change `spec.template` (new image, new env). The controller:
1. Updates `mydb-2` (highest ordinal). Waits for Ready.
2. Updates `mydb-1`. Waits for Ready.
3. Updates `mydb-0`.

If any Pod fails to become Ready, the rollout **halts** and doesn't touch lower-ordinal Pods. This is deliberate protection — never take down the leader (usually `mydb-0`) on a bad rollout.

## Partition — canary-style STS rollouts

```yaml
spec:
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      partition: 2       # only Pods with ordinal >= 2 get updated
```

With 3 replicas and `partition: 2`:
- New template applied.
- Only `mydb-2` gets the update. `mydb-1` and `mydb-0` stay on the old template.
- Verify `mydb-2` is healthy.
- Lower partition to 1 → `mydb-1` updates.
- Lower to 0 → `mydb-0` updates.

Effectively per-ordinal canary. Used for cautious upgrades of stateful systems.

## Storage layer — PV, PVC, StorageClass

```
StorageClass (template for provisioning)
   │
   │ CSI driver provisions
   ▼
PersistentVolume (the actual cloud disk / NFS share / etc.)
   │
   │ bound to
   ▼
PersistentVolumeClaim (request from Pod / STS)
   │
   │ mounted by
   ▼
Pod's container
```

### Dynamic provisioning walkthrough

1. Pod (from STS) requests a PVC `data-mydb-0` — 10Gi, RWO, class `gp3`.
2. PVC is created but Pending (no matching PV yet).
3. If StorageClass has `volumeBindingMode: WaitForFirstConsumer`, provisioning waits until a Pod actually schedules to mount the PVC. Once scheduled:
4. CSI controller (in the CSI driver's Deployment) sees the pending PVC + assigned node's topology.
5. Calls the cloud API: "create a 10Gi gp3 EBS volume in us-east-1a".
6. Cloud returns a volume ID.
7. CSI creates a PV pointing at that volume ID + node affinity (topology).
8. PVC binds to the PV. Status: `Bound`.
9. Kubelet on the target node calls the CSI node plugin: "attach this volume and mount it".
10. CSI node plugin runs `mount ... /var/lib/kubelet/pods/<uid>/volumes/...`.
11. Kubelet bind-mounts the mount into the container's filesystem.

## Access modes

| Mode | Meaning | Enforced by |
|---|---|---|
| ReadWriteOnce (RWO) | One node RW at a time | The underlying storage (cloud block volumes) |
| ReadOnlyMany (ROX) | Many nodes RO | Filesystem support |
| ReadWriteMany (RWX) | Many nodes RW | Requires shared filesystem (NFS, EFS, Azure Files) |
| ReadWriteOncePod (RWOP) | Exactly one Pod RW (K8s 1.22+) | CSI driver + K8s |

**RWO is not "one Pod at a time" — it's one *node* at a time.** Two Pods on the same node can both mount an RWO PVC. That's how sidecar patterns work.

## Volume expansion

Enable on the StorageClass:
```yaml
allowVolumeExpansion: true
```

Then edit the PVC:
```bash
kubectl patch pvc data-mydb-0 -p '{"spec":{"resources":{"requests":{"storage":"20Gi"}}}}'
```

Two-step process:
1. **Controller resize**: CSI driver resizes the underlying cloud volume. Immediate on most cloud providers.
2. **Filesystem resize**: the filesystem inside needs to grow to use the new space. Online resize (grow filesystem while mounted) works on ext4/xfs/etc. — some CSI drivers do this automatically; some require a Pod restart.

Watch:
```bash
kubectl describe pvc data-mydb-0
# Conditions: FileSystemResizePending? FileSystemResizeSuccessful?
```

## Volume snapshots

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: mydb-0-daily-20260730
spec:
  volumeSnapshotClassName: ebs-snapshots
  source:
    persistentVolumeClaimName: data-mydb-0
```

CSI driver calls the cloud API to create a snapshot of the underlying disk. Snapshots are typically incremental (only changed blocks stored).

Restore by creating a new PVC with `dataSource:`:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: data-restored }
spec:
  storageClassName: gp3
  dataSource:
    kind: VolumeSnapshot
    name: mydb-0-daily-20260730
    apiGroup: snapshot.storage.k8s.io
  accessModes: [ReadWriteOnce]
  resources: { requests: { storage: 10Gi } }
```

New PV is provisioned from the snapshot.

## The lifecycle when a StatefulSet Pod is deleted

1. `kubectl delete pod mydb-0` (or Pod dies for another reason).
2. Kubelet gets termination signal → sends SIGTERM to container → drains → SIGKILL after `terminationGracePeriodSeconds` (default 30s).
3. Kubelet unmounts the volume from the node.
4. CSI node plugin: unmount.
5. CSI controller plugin: detach volume from node.
6. StatefulSet controller notices `mydb-0` is gone → creates a new `mydb-0`.
7. Scheduler picks a node (potentially different from before).
8. CSI controller plugin: attach volume to new node (this is the "multi-attach error" scenario if the old node hasn't released).
9. CSI node plugin: mount.
10. New Pod starts, mounts the same PVC. Reads its data. Life continues.

## Multi-attach error — the common pain

When the previous node dies suddenly (kernel panic, network partition), the old volume attachment may not release immediately. K8s's node-monitor-grace-period is 40s; then the Pod is force-terminated; then attach-detach controller starts detach; if the node truly can't respond, the cloud won't detach.

Symptom: new Pod stuck in `ContainerCreating` with `Multi-Attach error for volume "..."`.

Fix (destructive, cloud-specific):
```bash
# AWS
aws ec2 detach-volume --volume-id vol-xxx --force
```

Long-term: use PodDisruptionBudget + graceful shutdown; use RWX filesystems for genuinely shared data; use K8s 1.28+ `Non-graceful Node Shutdown` feature.

---

## The 30-second summary

- StatefulSet controller creates Pods in ordinal order (0, 1, 2), each waiting for the previous to be Ready.
- `volumeClaimTemplates` produces one PVC per replica; PVCs survive scale-down by default.
- Headless Service (`clusterIP: None`) provides per-Pod DNS (`pod-0.svc.ns.svc.cluster.local`).
- Rolling updates go highest-ordinal-first; failure halts the rollout.
- `partition: N` gates updates to Pods with ordinal >= N — canary-style STS rollouts.
- Storage stack: StorageClass → CSI provisions PV → PVC binds → Pod mounts. RWO enforced at the block-storage layer.
- Volume expansion needs `allowVolumeExpansion: true` on the class, then patch the PVC. Some CSIs need a Pod restart for filesystem resize.
