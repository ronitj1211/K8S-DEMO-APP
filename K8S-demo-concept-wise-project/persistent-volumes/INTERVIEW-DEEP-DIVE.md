# PersistentVolumes & PVCs — Deep Dive for Interviews

The narrative version. Why storage is a separate concern from Pods, how the three objects fit together, and the traps that cause production incidents.

---

## The origin story

Early Docker deployments treated containers as cattle — spin up, serve traffic, kill, repeat. Data lived in external databases or object stores. Local disk inside a container was throwaway.

But many workloads need **local persistent disk**: SQLite, embedded search indexes, upload directories, WAL logs, ML model caches. When Kubernetes schedules a Pod, it can land on any node. When that Pod dies, the replacement has no memory of where the old one's disk was.

The first hack was `hostPath` — mount a directory on the node's filesystem. Fragile: data is tied to a specific node; reschedule to another node and the path is empty or wrong.

Kubernetes needed a proper storage abstraction. The answer was three objects:

- **PersistentVolume (PV)** — the actual storage resource in the cluster.
- **PersistentVolumeClaim (PVC)** — the user's request for storage.
- **StorageClass** — the template for creating PVs on demand.

This decouples "I need 50 GiB" (PVC) from "here is an EBS volume in us-east-1a" (PV) from "provision gp3 encrypted disks" (StorageClass).

## The mental model

Think of it like renting an apartment:

| K8s object | Analogy |
|------------|---------|
| StorageClass | The property management company's offerings (studio, 1BR, 2BR) |
| PV | A specific apartment unit that exists |
| PVC | Your lease application: "I need a 1BR" |
| Pod | You, the tenant, living in the leased unit |

The Pod never signs the lease directly — it mounts the PVC. The PVC controller finds (or creates) a matching PV.

```
StorageClass → provisioner creates PV → PVC binds to PV → Pod mounts PVC
```

PVCs are **namespaced** (like Pods). PVs and StorageClasses are **cluster-scoped**.

## Static vs dynamic — which world you live in

### Static (legacy / special cases)

An admin creates PVs ahead of time — maybe NFS exports, pre-purchased EBS volumes, or bare-metal SAN LUNs. Developers create PVCs that match. The binder pairs them.

You still see this for NFS shares that many teams consume, or air-gapped environments where dynamic cloud APIs are unavailable.

### Dynamic (everything in cloud-native land)

Developer creates a PVC. The StorageClass's CSI provisioner calls AWS/GCP/Azure APIs, creates a disk, creates a PV object pointing at it, binds the PVC. The developer never touches PV YAML.

On EKS, the default `gp2`/`gp3` StorageClass does this automatically. On minikube, `standard` uses hostPath under the hood. On k3s, `local-path` writes to the node's filesystem.

## Access modes — the question nobody asks until production breaks

This is the #1 source of storage confusion in interviews and incidents.

**ReadWriteOnce does not mean "one Pod."** It means **one node** can mount the volume read/write at a time.

Two Pods on the same node *can* mount the same RWO volume (kubelet allows it). Two Pods on different nodes *cannot*. A Deployment with 3 replicas and 1 RWO PVC will have 2 Pods stuck in ContainerCreating forever.

| Need | Solution |
|------|----------|
| One app, one disk, survives restarts | Deployment (replicas: 1) + PVC — this demo |
| Many Pods, each with own disk | StatefulSet + volumeClaimTemplates |
| Many Pods, shared disk | RWX backend (EFS, NFS) + PVC |

## The attach/detach dance

For block storage (EBS, GCE PD), the disk is a network-attached device. It must be:

1. **Attached** to the node where the Pod runs.
2. **Mounted** into the container's filesystem namespace.

When a Pod moves from node A to node B:

1. AttachDetach controller detaches from A (waits if A is NotReady — this is where incidents start).
2. Attaches to B.
3. Kubelet mounts into the new Pod.

During detach/attach, the Pod is not running. For stateless apps this is seconds of downtime. For databases, you need careful failover design — which is why operators exist.

## WaitForFirstConsumer — why it exists

With `Immediate` binding, a PVC provisions a disk the moment you create it — possibly in `us-east-1a`. Your Pod might schedule to `us-east-1b`. EBS cannot attach across zones. Pod Pending forever.

`WaitForFirstConsumer` delays provisioning until the scheduler picks a node. The provisioner receives topology hints and creates the disk in the right zone. Always use this for multi-AZ block storage.

## Reclaim policy — the data loss trap

Dynamic StorageClasses default to `reclaimPolicy: Delete`. Delete the PVC → PV deleted → cloud disk destroyed. Data gone.

For production databases, many teams:
- Use a StorageClass with `Retain`.
- Or rely on VolumeSnapshots + backup operators (Velero, native CSI snapshots).
- Or use managed database services outside Kubernetes entirely.

The `Released` state with `Retain` is awkward — the PV lingers with a stale `claimRef`. Admins must manually clear it before rebinding. But it beats silent data destruction.

## Volume expansion

Cloud disks can often grow without downtime:

```bash
kubectl patch pvc my-data -p '{"spec":{"resources":{"requests":{"storage":"100Gi"}}}}'
```

Requires `allowVolumeExpansion: true` on the StorageClass and a CSI driver that supports it. Filesystem resize may need a Pod restart on some platforms. You cannot shrink — plan capacity carefully.

## CSI — the modern plumbing

Pre-1.13, storage drivers lived inside Kubernetes ("in-tree"). Upgrading K8s meant upgrading storage code. CSI moved drivers out:

- **Controller plugin** — CreateVolume, DeleteVolume, ControllerPublish (attach).
- **Node plugin** (DaemonSet) — NodeStageVolume, NodePublishVolume (mount).

You install `aws-ebs-csi-driver`, `gcp-compute-persistent-disk-csi-driver`, etc. as cluster add-ons. The `StorageClass.provisioner` field points to the CSI driver name.

## How this demo maps to production

This folder's Deployment + single PVC is the simplest production pattern for:
- Single-replica workers with local state
- CI cache volumes
- Small SQLite / BoltDB apps
- Upload directories for monoliths being lifted into K8s

For anything with multiple replicas and per-replica disk, graduate to StatefulSets ([statefulsets-storage](../statefulsets-storage/)). For shared read/write across nodes, use RWX + NFS/EFS. For production databases, use an operator or managed service.

## Interview closing lines

Strong candidates mention:
1. Pods are ephemeral; PVCs decouple storage lifecycle.
2. Dynamic provisioning via StorageClass + CSI is the cloud-native default.
3. RWO ≠ one Pod — it's one node; multi-replica Deployments need RWX or per-Pod PVCs.
4. Reclaim policy `Delete` vs `Retain` is a data-loss decision, not a devops detail.
5. `WaitForFirstConsumer` for multi-AZ; VolumeSnapshots for backup; operators for databases.

See [PRODUCTION-INCIDENTS.md](./PRODUCTION-INCIDENTS.md) for incident stories that demonstrate these concepts under pressure.
