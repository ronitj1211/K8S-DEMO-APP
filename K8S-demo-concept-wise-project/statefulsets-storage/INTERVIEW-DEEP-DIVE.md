# StatefulSets & Storage — Deep Dive for Interviews

The narrative version. Why databases needed their own primitive, and how PVs / PVCs / StorageClasses actually fit together.

---

## The origin story

Deployments assume Pods are interchangeable — random-suffix names, any Pod can serve any request, storage is either shared or unimportant. That works for stateless HTTP APIs. It's a **disaster for databases**.

A database Pod needs:
- **Stable identity** — Postgres primary vs replica; MongoDB shard-01 vs shard-02. When Pod-01 dies and restarts, the replacement needs to keep being "Pod-01."
- **Stable storage** — the data written to disk yesterday has to still be there tomorrow, on the same Pod's replacement.
- **Ordered start-up** — you don't start replica-2 before replica-0 exists; the leader has to be up before followers try to join.

The K8s answer was **StatefulSet**: a controller that gives each Pod a stable numbered name (`pod-0`, `pod-1`, `pod-2`), its own PersistentVolumeClaim from a template, per-Pod DNS via a headless Service, and ordered rollout.

Storage got its own vocabulary too: **PersistentVolume** (the actual disk in the cluster), **PersistentVolumeClaim** (the request for storage that Pods reference), **StorageClass** (how to provision new PVs on demand).

## The mental model

StatefulSet is Deployment's stateful cousin. Both manage Pods, both do rolling updates. The difference is per-Pod identity:

| | Deployment | StatefulSet |
|---|---|---|
| Pod names | random suffix | ordered (`sts-0`, `sts-1`, ...) |
| Storage | shared or ephemeral | per-Pod PVC via template |
| Start order | parallel | sequential (`0` before `1` before `2`) |
| Delete order | any | reverse (`2` before `1` before `0`) |
| DNS | ClusterIP or none | per-Pod via headless Service |
| Rollout | any-Pod-first | reverse-ordinal |

Storage flow:
```
StorageClass (how)  →  provisioner creates PV (what)  →  PVC binds to PV (claim)  →  Pod mounts PVC (use)
```

PVCs are namespaced (like Pods). PVs are cluster-scoped. StorageClasses are cluster-scoped.

## How it actually works

### StatefulSet mechanics

When you create a StatefulSet with `replicas: 3` and `serviceName: db`:

1. Controller creates `db-0` first. It waits until `db-0` is Ready.
2. Creates `db-1`. Waits for Ready.
3. Creates `db-2`. Waits for Ready.

At scale-down, reverse order: `db-2` terminates first, then `db-1`, then `db-0`.

The `serviceName` **must reference a headless Service** (`clusterIP: None`) with the same selector. That gives each Pod a stable DNS name: `db-0.db.<namespace>.svc.cluster.local`. Clients can address specific replicas (`db-0` for primary, `db-1`/`db-2` for read replicas).

### volumeClaimTemplates

The magic that gives each Pod its own storage:

```yaml
spec:
  volumeClaimTemplates:
    - metadata: { name: data }
      spec:
        accessModes: [ReadWriteOnce]
        resources: { requests: { storage: 10Gi } }
```

For each replica, the StatefulSet creates a PVC named `data-<sts-name>-<ordinal>`. When `db-0` is created, a PVC `data-db-0` is created; when the PVC binds to a PV (via the StorageClass's dynamic provisioner), `db-0` mounts it.

Delete `db-0` and the StatefulSet recreates it — with the same PVC still bound. Data survives.

Scale down from 3 → 1: `db-2` and `db-1` Pods disappear, but their **PVCs stay** by default. Scale back to 3 → same PVCs re-attach to new `db-2` / `db-1` Pods. Data preserved. This is intentional protection against accidental data loss.

Since 1.27, `persistentVolumeClaimRetentionPolicy` lets you opt into deleting PVCs on scale-down or on StatefulSet deletion — useful for dev/CI environments.

### Storage machinery

**StorageClass** describes a type of storage: which provisioner (EBS, GCE PD, local-path, Ceph), what parameters (disk type, IOPS), reclaim policy (Delete or Retain), volume binding mode. Most clusters have a default class.

**Dynamic provisioning**: PVC asks for `10Gi` in class `gp3` → CSI driver provisions an EBS gp3 volume → creates a PV bound to the PVC. All automatic.

**Static provisioning**: admin pre-creates PVs (e.g., pointing at existing disks). PVCs bind to them by matching size and access mode. Rare in modern clusters.

**Access modes**: `ReadWriteOnce` (RWO, one node RW — most cloud block storage), `ReadOnlyMany` (ROX), `ReadWriteMany` (RWX, needs NFS/EFS/Azure Files), and newer `ReadWriteOncePod` (RWOP, exactly one Pod RW — stricter than RWO).

**Volume binding mode**: `Immediate` binds and provisions the PV right when the PVC is created — but may pick a zone that doesn't match where Pods actually schedule. `WaitForFirstConsumer` waits until a Pod actually mounts the PVC, then provisions in the right zone. Required for multi-zone clusters.

## When to use StatefulSet vs Deployment

**StatefulSet:**
- Databases (Postgres, MySQL, MongoDB).
- Distributed data systems (Cassandra, Kafka, Elasticsearch, etcd).
- Message queues (RabbitMQ clusters).
- Anything with a leader-election protocol that requires stable identity.
- Anything where "the disk with yesterday's data" matters.

**Deployment:**
- Stateless HTTP APIs.
- Workers that read from a queue and write to a database (state lives in the DB, not in the worker).
- Redis used as a disposable cache (accept cold start on restart).

**Gray area:**
- Redis with replication + persistence: StatefulSet (data on disk matters).
- Redis as cache-only: Deployment is fine.
- WebSocket servers: often Deployment; if you need to shard connections to specific replicas, maybe StatefulSet with headless DNS.

## Common misunderstandings

**"StatefulSet Pods can't be replaced."** They can — the controller recreates them. What's stable is the **name and PVC**, not the individual Pod. When `db-0` dies, a new Pod with the same name comes up and reattaches to `data-db-0`.

**"StatefulSet PVCs are deleted with the StatefulSet."** By default, no — PVCs survive. Since 1.27, `persistentVolumeClaimRetentionPolicy.whenDeleted: Delete` opts into deletion, but the default is `Retain` for safety.

**"ReadWriteMany means many Pods can write to the same disk."** In principle yes, but the underlying filesystem needs to support it (NFS, CephFS, Azure Files, EFS). AWS EBS is RWO — one node at a time.

**"Scaling down the StatefulSet frees storage."** Only the Pods go away. PVCs stay, PVs stay, disks keep costing money. Explicit delete: `kubectl delete pvc data-db-1 data-db-2` etc.

**"You can change the volumeClaimTemplates size later."** You can, but StatefulSet's PVC templates aren't retroactively re-applied to existing PVCs. To resize existing PVCs: enable `allowVolumeExpansion` on the StorageClass, then patch the existing PVCs' `resources.requests.storage`. The provisioner resizes the underlying disk.

**"Multiple StatefulSet Pods share one PVC."** They don't — each Pod gets its own PVC from the template. If you want shared storage across replicas, that's a Deployment with a manually-created RWX PVC.

## The war stories

**"Postgres StatefulSet's pod-0 restarted and lost data."** PVC wasn't bound — someone had deleted it accidentally, or the StorageClass provisioner failed silently. When `pod-0` recreated, it got a *new* empty PVC. Rule: always monitor the PVC's `Bound` status, alert on `Lost` or `Pending`.

**"We migrated from gp2 to gp3 and it took a weekend."** PVCs can't switch StorageClass in place. Options: snapshot each PVC → restore with new class → migrate data manually. Or use volume-expansion + type-change if the cloud allows it (AWS does; some in-place). Either way it's coordinated per-Pod downtime.

**"StatefulSet's rolling update stuck after pod-2 crashed."** With default `podManagementPolicy: OrderedReady`, the rollout goes highest-ordinal first. `pod-2` failed → rollout halts, `pod-1` and `pod-0` stay on the old version. That's actually protection: don't take down the whole cluster on a bad rollout. Fix `pod-2` or roll back.

**"`db-0` is stuck in `ContainerCreating` with `multi-attach error`."** The PVC (RWO) is still attached to another node — usually because the previous Pod died on a node that hasn't been marked NotReady yet, or the cloud hasn't auto-detached. Fix: wait for the cloud's attach timeout (~5 min on AWS), force-detach via cloud API, or delete the stuck node from K8s.

**"Cassandra cluster's seed discovery broke."** The headless Service was set to `clusterIP: 10.x.x.x` (not `None`), so DNS returned a virtual IP instead of Pod IPs. Cassandra tried to gossip with the VIP. Fix: `clusterIP: None`, and ensure `spec.serviceName` on the StatefulSet references the headless one.

**"PVCs from a deleted StatefulSet are still costing money."** Yeah — `persistentVolumeClaimRetentionPolicy` defaults to Retain. `kubectl delete pvc -l app=<name>` cleans up. And in cloud, verify the underlying PV also cleaned up (StorageClass `reclaimPolicy: Delete` deletes the disk; `Retain` leaves it in the cloud, still billing).

## What to actually say in an interview

If asked "what's a StatefulSet?":

> StatefulSet is the K8s controller for stateful workloads. It gives each Pod a stable numbered name — sts-0, sts-1, sts-2 — a stable per-Pod DNS record via a headless Service, its own PersistentVolumeClaim from a template, and ordered startup and shutdown. Used for databases, distributed data systems like Kafka or Elasticsearch, anything that cares about "which replica am I" or has persistent per-Pod state. The Pod itself is still ephemeral — sts-0 can be replaced by a new Pod with the same name — but the identity and storage survive across the replacement.

If asked about PV / PVC / StorageClass:

> Three-layer stack. StorageClass describes *how* to provision storage — which CSI driver, which disk type, what parameters. PersistentVolume is the actual disk resource in the cluster (created dynamically by the class's provisioner, or statically by an admin). PersistentVolumeClaim is a Pod's request: "give me 10Gi RWO." The claim binds to a PV that satisfies it; the Pod mounts the PVC. For StatefulSets, `volumeClaimTemplates` creates one PVC per replica automatically. Access modes matter — most cloud block storage is RWO, meaning one node at a time; RWX requires a shared filesystem like NFS or EFS.

If asked about StatefulSet vs Deployment:

> Deployment: interchangeable Pods, random names, shared or no persistent storage. Perfect for stateless HTTP APIs. StatefulSet: stable numbered names, per-Pod PVCs, ordered start/stop. Perfect for databases and distributed systems that care about which Pod is which. The trade-off is complexity — StatefulSets are harder to operate, updates are per-Pod sequential, and you have to think about PVC lifecycle explicitly. Don't reach for it just because "my Pod writes to disk"; reach for it when Pod identity matters.

If asked about a subtle scenario like scaling down:

> Scale a StatefulSet from 3 → 1: sts-2 and sts-1 terminate in that order, but their PVCs stay by default — this is deliberate protection against accidental data loss. Scale back to 3, same PVCs re-attach to new sts-2 / sts-1 Pods. If you want ephemeral behavior in dev, set `persistentVolumeClaimRetentionPolicy` (K8s 1.27+) to delete PVCs on scale-down.

Say the words: **stable per-Pod identity**, **volumeClaimTemplates**, **headless Service**, **ordered start/stop**, **PVCs survive scale-down by default**, **RWO vs RWX**, **StorageClass + dynamic provisioning**.
