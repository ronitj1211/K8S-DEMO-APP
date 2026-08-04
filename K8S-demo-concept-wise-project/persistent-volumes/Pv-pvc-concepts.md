# Kubernetes Storage — PV, PVC & StorageClass Notes

---

## 1. Core concepts

| Object | Who creates it | What it represents |
|---|---|---|
| `PersistentVolume` (PV) | Admin (static) or CSI provisioner (dynamic) | The actual piece of storage — cluster-scoped, points at real disk/NFS/cloud volume |
| `PersistentVolumeClaim` (PVC) | Developer / app team | A **request** for storage ("I need 5Gi, ReadWriteOnce") — namespace-scoped |
| `StorageClass` | Admin (usually pre-installed by cloud provider) | A "recipe" telling Kubernetes *how* to dynamically create a PV on demand |
| `Pod` | Developer | References a PVC by name in `volumes:` — never talks to PV/storage directly |

**Why this layered design exists:** it separates *what storage exists* (PV — infrastructure concern) from *what an app asks for* (PVC — developer concern). A developer writing a Pod spec never needs to know if it's EBS, NFS, or local disk underneath — same abstraction pattern as a Service hiding backend Pod IPs from whatever calls it.

---

## 2. Static vs dynamic provisioning

### Static provisioning
- Admin manually creates one or more `PersistentVolume` objects **ahead of time**, pointing at already-existing storage (e.g. a specific EBS volume, an NFS export).
- When a PVC shows up asking for matching size/access mode, Kubernetes' PV controller scans existing PVs and **binds** one — a 1:1 lock, that PV is now reserved for that PVC only.
- No new disk gets created — it already existed.
- Used when: on-prem clusters, compliance/audit requirements, needing to control *exactly* which physical storage backs a workload.

### Dynamic provisioning
- No PV exists yet. The PVC references a `StorageClass` (explicitly, or via the cluster's default).
- The StorageClass's `provisioner` field points to a plugin (e.g. `ebs.csi.aws.com`, `kubernetes.io/gce-pd`) that calls the cloud provider's API, creates a **brand-new disk**, and Kubernetes auto-generates a matching PV object for it.
- Used when: cloud environments, elastic/scaling workloads, fast-moving teams that don't want to hand-provision disks per claim.

### What actually decides which path is used

There's no single "static/dynamic" flag — it's the outcome of what's present when a new PVC appears:

| PVC's `storageClassName` | Behavior |
|---|---|
| `storageClassName: ""` (explicit empty string) | Forces **static only** — never triggers a provisioner, only binds to an existing PV. Stays `Pending` forever if none matches. |
| Omitted entirely | Uses the cluster's **default StorageClass** (if one exists) → dynamic. If no default exists, falls back to trying to match an existing static PV. |
| `storageClassName: <name>` | Explicit — dynamic provisioning using that specific StorageClass. |

**Kubernetes is not order-dependent.** The PersistentVolume controller runs continuously in the background and re-evaluates every time *any* PVC or PV changes — it doesn't matter whether you `kubectl apply` the Pod, PVC, PV, or StorageClass first. Whichever objects exist at any given moment determine whether a PVC binds, provisions, or stays `Pending` — and it keeps re-checking until it can satisfy the request.

---

## 3. Real-world scenario examples

### Scenario A: Static — a bank's on-prem cluster with a compliance-audited NFS share

A bank runs Kubernetes in its own datacenter — no cloud provider, no CSI auto-provisioner. Compliance rules require all transaction logs to land on a specific, pre-audited NFS array that the infra team controls by hand.

**Infra team creates the PV manually, ahead of time:**
```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: audit-log-pv
spec:
  capacity:
    storage: 100Gi
  accessModes: [ReadWriteMany]
  storageClassName: ""
  nfs:
    server: nfs-audit-01.bank.internal
    path: /exports/audit-logs
```

**App team later requests storage:**
```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: transaction-logger-pvc
spec:
  accessModes: [ReadWriteMany]
  resources:
    requests:
      storage: 100Gi
```

Kubernetes' PV controller sees the new PVC, scans existing PVs, finds `audit-log-pv` matches on size/access mode, and binds them 1:1 — no new disk is created, it already existed.

```bash
kubectl get pvc
NAME                     STATUS   VOLUME         CAPACITY   AGE
transaction-logger-pvc   Bound    audit-log-pv   100Gi      5s
```

**Why static:** the bank needs to guarantee exactly *which* physical hardware backs this workload for audit purposes — letting Kubernetes auto-create arbitrary disks would break that guarantee.

### Scenario B: Dynamic — a startup spinning up preview environments on AWS EKS

A startup deploys a Postgres-backed service on EKS and spins up a fresh environment for every pull request. Nobody wants to manually create an EBS volume 30 times a week.

**Already exists in the cluster (ships by default on EKS):**
```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
```

**Developer just requests storage — no PV written by hand:**
```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data-pvc
spec:
  storageClassName: gp3
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 20Gi
```

The moment this is applied, the `ebs.csi.aws.com` driver calls the AWS EC2 API, creates a new 20Gi gp3 EBS volume, and Kubernetes auto-generates a matching PV — bound within seconds.

```bash
kubectl get pvc
NAME                 STATUS   VOLUME                                     CAPACITY   AGE
postgres-data-pvc    Bound    pvc-8f21a3c0-...                            20Gi       8s
```

Spin up 30 preview environments this week → 30 EBS volumes get created automatically, zero manual AWS console work.

**Why dynamic:** speed. A fast-moving team can't have someone hand-provisioning a disk every time a developer opens a PR.

| | Static (Scenario A) | Dynamic (Scenario B) |
|---|---|---|
| Who creates the PV | Admin, manually, ahead of time | CSI provisioner, automatically, on demand |
| Best fit | Regulated/on-prem, specific hardware requirements | Cloud, elastic scaling, dev speed |
| Trigger | `storageClassName: ""` + matching PV exists | `storageClassName: <name>` (or default) + provisioner exists |

### How Kubernetes actually decides — walking through the logic

Given a new PVC, the PV controller's decision tree is:

```
New/unbound PVC appears
        │
        ▼
Is storageClassName == "" (explicitly empty)?
        │
   ┌────┴─────┐
  YES          NO
   │            │
   ▼            ▼
Static-only   Is storageClassName set to a name (or a default exists)?
path only.        │
Scan existing  ┌───┴────┐
PVs for a     YES        NO (omitted, no default)
size/access    │            │
mode match.    ▼            ▼
   │      Look up that   Fall back to
   │      StorageClass.  scanning existing
   ▼      Does it have a  PVs for a match
Found?     working         (same as static
 │  │      provisioner?    path).
YES NO      │    │
 │   │     YES   NO
 ▼   ▼      │     │
Bind Pending▼     ▼
      Call the  Pending
      provisioner,
      create disk,
      auto-generate
      PV, bind it.
```

**Example walkthrough — same cluster, two different PVCs:**

```yaml
# PVC 1 — will go dynamic
spec:
  storageClassName: gp3       # named class, provisioner exists
  resources:
    requests:
      storage: 10Gi
```
→ No `""`, class exists with a live provisioner → dynamic path → new EBS volume created.

```yaml
# PVC 2 — will go static, or stay Pending
spec:
  storageClassName: ""        # explicitly blocks dynamic provisioning
  resources:
    requests:
      storage: 10Gi
```
→ Only static PVs are considered. If one matching 10Gi+ RWO PV already exists → bound. If not → `Pending` forever, since dynamic provisioning is explicitly disabled for this claim.

This is why the exact same cluster, same StorageClass installed, can have one PVC dynamically provision a disk in seconds while another sits `Pending` indefinitely — the difference is entirely in what that one PVC's `storageClassName` field says.

---

## 4. Volume request flow (both modes)

```
Pod
 │  references PVC by claimName (never touches storage directly)
 ▼
PersistentVolumeClaim (PVC)
 │  "I need 5Gi, ReadWriteOnce"
 ▼
   ┌─────────────── static ───────────────┐   ┌────────────── dynamic ──────────────┐
   │ PV controller scans existing PVs      │   │ PVC references a StorageClass        │
   │ for a match on size/accessMode/class  │   │ → provisioner plugin creates a new   │
   │ → binds 1:1                            │   │   disk via cloud API → auto-creates  │
   │                                        │   │   a matching PV → binds it           │
   └───────────────┬────────────────────────┘   └───────────────┬───────────────────────┘
                    ▼                                            ▼
             PersistentVolume (PV) — bound to the PVC
                    │
                    ▼
        Physical storage (EBS / GCE PD / NFS / local disk / etc.)
```

---

## 5. Deployment vs StatefulSet — how many volumes actually get created

| Workload type | PVC reference | Result with 10 replicas |
|---|---|---|
| `Deployment` + `persistentVolumeClaim.claimName` (hardcoded, same name in every pod template) | 1 shared PVC/volume for **all 10 pods** | Needs `ReadWriteMany` (RWX) storage to work safely across nodes. `ReadWriteOnce` (RWO) across multiple nodes causes a **Multi-Attach error**. |
| `StatefulSet` + `volumeClaimTemplates` | Auto-generates a **uniquely-named PVC per replica** (`data-my-db-0`, `data-my-db-1`, ...) | 10 separate PVCs/PVs — one per pod, no sharing, each pod keeps its own data even across restarts. |

**Rule of thumb:** `Deployment` + shared PVC → stateless apps needing a shared cache/file store (with genuine RWX-capable storage like NFS/EFS). Anything needing **per-instance independent data** (databases, queues) → `StatefulSet`.

---

## 6. Troubleshooting a stuck PVC (`Pending` forever)

Kubernetes never throws a hard failure for unmet storage requests — it just leaves the PVC (and any Pod depending on it) waiting indefinitely. Common causes:

1. **PVC references a StorageClass name that doesn't exist** (typo) → stays `Pending`.
2. **No `storageClassName` set, and no default StorageClass in the cluster** → no dynamic provisioning possible; falls back to static match, or stays `Pending`.
3. **StorageClass exists, but its CSI provisioner/driver isn't actually running** (e.g. AWS-targeted manifest applied to a bare-metal/local cluster with no AWS CSI driver installed) → `Pending`, with a provisioning error in events.

**Checklist:**
```bash
kubectl get pvc                      # confirm STATUS: Pending
kubectl describe pvc <name>          # THE key command — check the Events section
kubectl get storageclass             # does the referenced class exist? is one marked (default)?
kubectl get pods -n kube-system      # (cloud clusters) is the CSI driver pod actually running?
```

---

## 7. YAML reference — every file and its important fields

### `storageclass.yaml`

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Delete
```

| Field | Purpose |
|---|---|
| `metadata.name` | The name PVCs reference via `storageClassName`. |
| `metadata.annotations["storageclass.kubernetes.io/is-default-class"]` | Marks this as the cluster's default — used automatically by any PVC that omits `storageClassName`. |
| `provisioner` | The CSI driver plugin responsible for actually creating disks (e.g. `ebs.csi.aws.com`, `kubernetes.io/gce-pd`, `nfs.csi.k8s.io`). No provisioner running for this name = dynamic provisioning fails silently (PVC stuck `Pending`). |
| `parameters` | Driver-specific options (disk type, IOPS, encryption, etc.) — passed straight through to the cloud API call. |
| `volumeBindingMode` | `Immediate` (provision as soon as PVC is created) vs `WaitForFirstConsumer` (wait until a Pod actually needs it, so the disk gets created in the right zone/node). |
| `reclaimPolicy` | What happens to the underlying disk when the PVC is deleted — `Delete` (destroy the disk) or `Retain` (keep it, requires manual cleanup). |

---

### `pv.yaml` (static provisioning only)

```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: audit-log-pv
spec:
  capacity:
    storage: 100Gi
  accessModes:
    - ReadWriteMany
  storageClassName: ""
  persistentVolumeReclaimPolicy: Retain
  nfs:
    server: nfs-audit-01.internal
    path: /exports/audit-logs
```

| Field | Purpose |
|---|---|
| `spec.capacity.storage` | Total size this PV offers — must be ≥ what a PVC requests to bind. |
| `spec.accessModes` | `ReadWriteOnce` (single node), `ReadOnlyMany` (many nodes, read-only), `ReadWriteMany` (many nodes, read-write) — must match what the PVC requests. |
| `spec.storageClassName` | `""` marks it for static/manual binding only (won't be touched by dynamic provisioning logic). Can also be a named class to restrict which PVCs can match it. |
| `spec.persistentVolumeReclaimPolicy` | What happens after the bound PVC is deleted — `Retain` (keep data, needs manual cleanup) or `Delete` (auto-remove the underlying storage). |
| `spec.nfs` / `spec.awsElasticBlockStore` / etc. | The actual backend-specific connection details — this is where the real storage location lives (varies by storage type). |

---

### `pvc.yaml`

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: my-pvc
spec:
  storageClassName: gp3
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 10Gi
```

| Field | Purpose |
|---|---|
| `metadata.name` | Referenced by Pods via `claimName`. |
| `spec.storageClassName` | Decides static-only (`""`), default-class dynamic (omitted), or a specific class (named) — see section 2. |
| `spec.accessModes` | Must be satisfiable by the PV it binds to / the StorageClass's backend. |
| `spec.resources.requests.storage` | Minimum size needed — binds to any PV ≥ this size (static), or requests exactly this size (dynamic). |

---

### `pod.yaml`

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: my-app
spec:
  containers:
    - name: app
      image: my-app:1.0
      volumeMounts:
        - name: data
          mountPath: /data
  volumes:
    - name: data
      persistentVolumeClaim:
        claimName: my-pvc
```

| Field | Purpose |
|---|---|
| `spec.containers[].volumeMounts[].mountPath` | Where inside the container's filesystem the volume appears. |
| `spec.containers[].volumeMounts[].name` | Links to the `spec.volumes[].name` below — must match. |
| `spec.volumes[].persistentVolumeClaim.claimName` | The **only** thing the Pod knows about storage — just a PVC name. It has no idea whether that PVC is backed by NFS, EBS, or a local disk. |

---

## 8. `StatefulSet` variant — one volume per replica

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: my-db
spec:
  replicas: 10
  serviceName: my-db
  template:
    spec:
      containers:
        - name: db
          volumeMounts:
            - name: data
              mountPath: /var/lib/data
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: [ "ReadWriteOnce" ]
        storageClassName: gp3
        resources:
          requests:
            storage: 5Gi
```

| Field | Purpose |
|---|---|
| `spec.volumeClaimTemplates` | Generates a **separate, uniquely-named PVC per replica** (`data-my-db-0` ... `data-my-db-9`) instead of one shared PVC — this is what makes each pod get its own independent volume. |
| `spec.serviceName` | Required for StatefulSets — pairs with a headless Service for stable per-pod network identity (separate topic, but always present alongside `volumeClaimTemplates`). |

---

## 9. Key takeaways

1. A Pod only ever knows a PVC name — never a PV, StorageClass, or backend detail. This abstraction mirrors how a Service hides backend Pod IPs.
2. Static provisioning = admin pre-creates a PV, Kubernetes matches it to a PVC. Dynamic provisioning = a StorageClass's provisioner creates a brand-new disk on demand.
3. The deciding factor between the two is the PVC's `storageClassName` field: empty string forces static-only, omitted uses the cluster default (if any), named uses that specific class.
4. Kubernetes reconciles PV/PVC binding continuously in the background — apply order of your YAML files doesn't matter, only what currently exists in the cluster at any given moment.
5. `Deployment` + a hardcoded `claimName` means **all replicas share one volume** (needs `ReadWriteMany`, or breaks across nodes with a Multi-Attach error). `StatefulSet` + `volumeClaimTemplates` gives **each replica its own separate volume**.
6. A stuck PVC always shows `Pending` with no loud error — `kubectl describe pvc <name>` and its `Events` section is the first and most useful troubleshooting step.
