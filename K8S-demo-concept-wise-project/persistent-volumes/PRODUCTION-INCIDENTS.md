# Production Incidents — PV, PVC & Storage

Real-world incident stories focused on PersistentVolumes, PVCs, and StorageClasses. Same framework as [PRODUCTION-INCIDENTS.md](../PRODUCTION-INCIDENTS.md): symptom → diagnosis → root cause → fix → prevention.

Use these as interview answers or postmortem templates.

---

## Incident #1: PVC Stuck Pending — StatefulSet Won't Start

### Symptom

New database StatefulSet deployed to production. Pods stuck `Pending` for 20+ minutes. PagerDuty: "postgres-0 not Ready."

```bash
kubectl get pods
# postgres-0   0/1   Pending   0   22m

kubectl get pvc
# data-postgres-0   Pending   <none>   0   22m
```

### Diagnosis path

**Step 1: Describe the Pod**

```bash
kubectl describe pod postgres-0
```

Events show:
```
Warning  FailedScheduling  0/3 nodes available: 3 pod has unbound immediate PersistentVolumeClaims.
```

The Pod cannot schedule because its PVC is not bound.

**Step 2: Describe the PVC**

```bash
kubectl describe pvc data-postgres-0
```

Events:
```
Warning  ProvisioningFailed  storageclass.storage.k8s.io "gp3-encrypted" not found
```

**Step 3: List StorageClasses**

```bash
kubectl get storageclass
# gp3 (default)
# local-path
```

The StatefulSet's `volumeClaimTemplates` referenced `storageClassName: gp3-encrypted`, but that class does not exist in the cluster.

### Root cause

Typo / environment mismatch — the manifest was copied from a cluster that had a custom encrypted StorageClass. This cluster only has `gp3`.

### Fix

**Immediate:** Patch the StatefulSet template to use the correct class, delete the Pending PVC, delete and recreate the StatefulSet.

```bash
# Fix the YAML: storageClassName: gp3
kubectl delete statefulset postgres
kubectl delete pvc data-postgres-0
kubectl apply -f postgres-statefulset.yaml
```

**Alternative:** Create the missing StorageClass if it was intentionally named differently.

### Prevention

1. CI lint: validate `storageClassName` against allowed list per environment.
2. Helm/Kustomize overlays per cluster — never copy-paste raw YAML between prod/staging without review.
3. Pre-deploy check: `kubectl get storageclass` in the target cluster before apply.

---

## Incident #2: Multi-Attach Error After Node Failure

### Symptom

After an AWS node became NotReady (hardware failure), the replacement Pod for `worker-7d4f9-xk2m` stuck in `ContainerCreating` for 15 minutes.

```bash
kubectl describe pod worker-7d4f9-xk2m
```

Events:
```
Warning  FailedAttachVolume  Multi-Attach error for volume "pvc-abc123"
  Volume is already used by pod(s) worker-7d4f9-xk2m on node ip-10-0-1-42
```

### Diagnosis path

**Step 1: Check the node**

```bash
kubectl get nodes
# ip-10-0-1-42   NotReady   45m
```

The old node is still registered but unreachable. The RWO EBS volume is still attached to it.

**Step 2: Check volume attachment in AWS**

EC2 console → Volumes → volume `vol-0abc123` → Attached to `i-oldinstance`.

**Step 3: Confirm PVC access mode**

```bash
kubectl get pvc data-worker -o yaml | grep accessModes
# - ReadWriteOnce
```

RWO allows only one node attachment at a time.

### Root cause

Node hard failure without clean kubelet shutdown. AttachDetach controller waits for the node to be declared dead before force-detaching (default `node-monitor-grace-period` ~5 min, but can be longer). Cloud volume still attached to the dead instance.

### Fix

**Immediate:** After confirming the node is truly dead and workloads were evicted:

```bash
# Force detach via AWS CLI (after node declared dead)
aws ec2 detach-volume --volume-id vol-0abc123 --force

# Or wait for K8s node controller to remove NotReady node and AD controller to detach
kubectl delete node ip-10-0-1-42   # only after confirmed dead
```

Pod eventually attaches to the new node and starts.

### Prevention

1. Set appropriate PodDisruptionBudgets and use operators with proper failover for stateful apps.
2. Monitor node NotReady duration — alert if > 10 min.
3. For critical RWO workloads, document the force-detach runbook.
4. Consider `ReadWriteOncePod` or shared storage (RWX) where multi-node failover is required.

---

## Incident #3: Accidental Data Loss on PVC Delete

### Symptom

Developer ran `kubectl delete namespace staging` to clean up a test environment. Monday morning: staging database is empty. No backups.

### Diagnosis path

**Step 1: Check if PVCs existed**

Git history shows a Postgres Deployment with PVC `postgres-data`.

**Step 2: Check StorageClass reclaim policy**

```bash
kubectl get storageclass gp3 -o yaml
```

```yaml
reclaimPolicy: Delete
```

**Step 3: Cloud audit logs**

AWS CloudTrail shows `DeleteVolume` events for `vol-xyz` immediately after the namespace deletion timestamp.

### Root cause

Namespace deletion cascades to PVC deletion. StorageClass had `reclaimPolicy: Delete`. CSI provisioner destroyed the EBS volume. Data permanently gone.

### Fix

**Immediate:** Restore from backup — none existed. Re-seed staging from production snapshot (with data masking). Downtime: 1 day.

**Long-term fix:**
- Create a production StorageClass with `reclaimPolicy: Retain`.
- Enable automated VolumeSnapshots (daily).
- Add Velero for namespace-level backup.
- RBAC: restrict `delete namespace` in staging to CI only.

### Prevention

1. Never use `Delete` reclaim policy for anything you care about.
2. Backup before any namespace deletion — automate snapshots.
3. Use `ResourceQuota` + separate AWS accounts for staging vs prod.
4. Finalizer-aware cleanup scripts that snapshot before delete.

---

## Incident #4: Zone Mismatch — Pod Pending After Scale-Up

### Symptom

Scaled a Deployment from 1 to 3 replicas. Two new Pods Pending. The original Pod runs fine.

```bash
kubectl get pods -o wide
# app-old   1/1   Running   ip-10-0-2-10   us-east-1b
# app-new1  0/1   Pending   <none>         <none>
# app-new2  0/1   Pending   <none>         <none>
```

All three Pods share one RWO PVC (anti-pattern, but common in legacy migrations).

### Diagnosis path

**Step 1: Describe Pending Pods**

```
Warning  FailedScheduling  0/6 nodes available: 3 node(s) had volume node affinity conflict,
  3 node(s) didn't match PersistentVolume's node affinity.
```

**Step 2: Check PV node affinity**

```bash
kubectl get pv $(kubectl get pvc shared-data -o jsonpath='{.spec.volumeName}') -o yaml
```

PV has node affinity for `us-east-1b` (where the EBS volume lives). Only nodes in that zone can mount it. Cluster autoscaler added nodes in `us-east-1a` and `us-east-1c`.

**Step 3: Confirm shared PVC**

Deployment has `replicas: 3` but only one PVC in `volumes`. RWO + multi-replica = broken.

### Root cause

Two problems stacked:
1. Architecture: multiple replicas sharing one RWO PVC (invalid for multi-node).
2. Even for single replica, `Immediate` binding created disk in one zone; new nodes in other zones cannot attach.

### Fix

**Immediate:** Scale back to 1 replica.

**Proper fix:** Redesign — either StatefulSet with per-Pod PVCs, or RWX storage (EFS), or externalize state to RDS.

Change StorageClass to `volumeBindingMode: WaitForFirstConsumer` for future PVCs.

### Prevention

1. Lint: Deployments with PVC volumes must have `replicas: 1` unless accessMode is RWX.
2. Use `WaitForFirstConsumer` on all block StorageClasses.
3. Architecture review for any workload mounting persistent storage.

---

## Incident #5: CSI Driver Missing — All PVCs Pending After Cluster Upgrade

### Symptom

After EKS upgrade from 1.28 to 1.29, every new PVC stuck Pending. Existing workloads fine. New deployments cannot start.

```bash
kubectl describe pvc new-app-data
```

```
Warning  ProvisioningFailed  failed to provision volume with StorageClass "gp3":
  rpc error: code = Unavailable desc = connection error: desc = "transport: Error while dialing"
```

### Diagnosis path

**Step 1: Check CSI controller Pods**

```bash
kubectl get pods -n kube-system -l app=ebs-csi-controller
# ebs-csi-controller-xxx   0/6   CrashLoopBackOff
```

**Step 2: Controller logs**

```
Error: failed to initialize driver: Incompatible Kubernetes version
```

The EBS CSI driver version bundled with the old cluster addon was incompatible with 1.29.

**Step 3: Check existing PVs**

Old PVs still work — they are already provisioned and attached. Only **new** provisioning fails.

### Root cause

Cluster upgrade without upgrading CSI driver addon to a version compatible with the new Kubernetes minor version.

### Fix

```bash
# Upgrade EBS CSI driver addon to latest compatible version
eksctl update addon --name aws-ebs-csi-driver --version v1.xx-eksbuild.x --cluster prod

kubectl rollout status deployment/ebs-csi-controller -n kube-system
```

New PVCs provision successfully.

### Prevention

1. Pre-upgrade checklist: verify all CSI drivers, CNI, and core addons support target K8s version.
2. Staging cluster upgrade first — test PVC create/delete cycle.
3. Monitor CSI controller health as part of cluster upgrade runbook.

---

## How to use these in interviews

Pick the incident closest to the role:

| Role focus | Best incident |
|------------|---------------|
| Platform / SRE | #2 (multi-attach), #5 (CSI upgrade) |
| App team / DevOps | #1 (wrong StorageClass), #4 (RWO + replicas) |
| Data / DBA | #3 (data loss on delete) |

Always end with **prevention** — interviewers want to know you think beyond the firefight.

**Related:** [MORE-PRODUCTION-INCIDENTS.md #8](../MORE-PRODUCTION-INCIDENTS.md) (PVC Pending variant), [INTERNALS.md](./INTERNALS.md) (how binding works).
