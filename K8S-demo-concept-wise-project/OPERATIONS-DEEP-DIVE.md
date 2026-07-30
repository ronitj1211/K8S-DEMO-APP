# Kubernetes Operations — Deep Dive

Cross-cutting operational topics that don't fit into any single concept folder: storage lifecycle, multi-cluster architecture, cluster & node debugging playbooks, service discovery internals.

Companion to the per-concept INTERNALS.md files.

---

## Table of contents

- [Part 1: Storage management](#part-1-storage-management)
- [Part 2: Multi-cluster architecture](#part-2-multi-cluster-architecture)
- [Part 3: Debugging — node down](#part-3-debugging--node-down)
- [Part 4: Debugging — cluster-wide issues](#part-4-debugging--cluster-wide-issues)
- [Part 5: Debugging — application not accessible](#part-5-debugging--application-not-accessible)
- [Part 6: Service discovery — how it actually works](#part-6-service-discovery--how-it-actually-works)
- [Part 7: Networking — the full picture](#part-7-networking--the-full-picture)

---

# Part 1: Storage management

## The layered model

Kubernetes storage sits in three layers, from bottom to top:

```
                                  ┌────────────┐
                                  │   Pod      │
                                  └──────┬─────┘
                                         │ mounts
                                         ▼
                                  ┌────────────┐
                                  │    PVC     │ (namespaced — Pod's request)
                                  └──────┬─────┘
                                         │ binds
                                         ▼
                                  ┌────────────┐
                                  │     PV     │ (cluster-scoped — actual storage)
                                  └──────┬─────┘
                                         │ provisioned by
                                         ▼
                                  ┌────────────┐
                                  │StorageClass│ (template for provisioning)
                                  └──────┬─────┘
                                         │ uses
                                         ▼
                                  ┌────────────┐
                                  │ CSI Driver │ (EBS, GCE PD, NFS, ...)
                                  └────────────┘
```

Understanding this stack is the difference between "I applied a PVC" and knowing why one is stuck Pending.

## StorageClass — how storage gets provisioned

A StorageClass declares "when a PVC asks for storage of this class, do this."

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3-encrypted
provisioner: ebs.csi.aws.com          # which CSI driver handles this class
parameters:
  type: gp3
  encrypted: "true"
  kmsKeyId: alias/prod-eks
  iops: "3000"
  throughput: "125"
reclaimPolicy: Delete                  # what happens when the PVC is deleted
volumeBindingMode: WaitForFirstConsumer  # when to actually provision
allowVolumeExpansion: true             # can the PVC grow later
```

**Key fields:**

- **`provisioner`** — the CSI driver's identifier. Must be installed as a DaemonSet + controller in the cluster (typically `kube-system` or its own namespace).
- **`reclaimPolicy`** — `Delete` (destroy the disk when PVC is deleted) or `Retain` (keep the disk, admin must clean up). Delete for ephemeral test data; Retain for anything you might need to recover.
- **`volumeBindingMode`**:
  - `Immediate` — provision as soon as the PVC is created. Wrong for multi-zone clusters — the PV might be in a zone the Pod can't reach.
  - `WaitForFirstConsumer` — provision when a Pod actually needs it. Right answer for cloud clusters spanning zones.
- **`allowVolumeExpansion`** — can you grow a bound PVC later? Cloud CSI drivers usually support this; some legacy ones don't.

## PVC — the request

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: data-postgres-0
spec:
  storageClassName: gp3-encrypted
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 20Gi
```

**Access modes** — critically important:

| Mode | Abbrev | Meaning | Common backends |
|---|---|---|---|
| ReadWriteOnce | RWO | One node RW at a time | Cloud block storage (EBS, GCE PD, Azure Disk) |
| ReadOnlyMany | ROX | Many nodes RO | Rare in practice |
| ReadWriteMany | RWX | Many nodes RW | NFS, EFS, Azure Files, CephFS |
| ReadWriteOncePod | RWOP | Exactly one Pod RW (stricter than RWO) | K8s 1.22+, requires CSI driver support |

**Access mode is a promise, not a guarantee.** A PVC declared RWO doesn't prevent two Pods from binding it — the underlying storage is what enforces it. Multiple Pods trying to mount an RWO PVC results in `Multi-Attach error for volume` failures.

## PV — the actual resource

Almost never authored by hand in modern clusters. Dynamic provisioning creates PVs automatically when a PVC requests them.

```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: pvc-abc-123
spec:
  capacity: { storage: 20Gi }
  accessModes: [ReadWriteOnce]
  persistentVolumeReclaimPolicy: Delete
  storageClassName: gp3-encrypted
  csi:
    driver: ebs.csi.aws.com
    volumeHandle: vol-0abc123def456           # AWS EBS volume ID
    fsType: ext4
  nodeAffinity:                                # which nodes can mount this?
    required:
      nodeSelectorTerms:
        - matchExpressions:
            - key: topology.ebs.csi.aws.com/zone
              operator: In
              values: [us-east-1a]
```

The `nodeAffinity` at the bottom is the reason for `WaitForFirstConsumer` binding mode — the PV can only be mounted by Pods scheduled in the same zone as the underlying EBS volume.

## Volume snapshots

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: ebs-snapshots
driver: ebs.csi.aws.com
deletionPolicy: Delete
---
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: postgres-0-snap-20260730
spec:
  volumeSnapshotClassName: ebs-snapshots
  source:
    persistentVolumeClaimName: data-postgres-0
```

**Under the hood:** the CSI driver calls the cloud API to create a snapshot of the underlying disk. Snapshots are point-in-time; they're incremental in most cloud implementations (only changed blocks stored).

To restore from a snapshot:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: data-postgres-restored
spec:
  storageClassName: gp3-encrypted
  accessModes: [ReadWriteOnce]
  resources: { requests: { storage: 20Gi } }
  dataSource:
    kind: VolumeSnapshot
    name: postgres-0-snap-20260730
    apiGroup: snapshot.storage.k8s.io
```

## Storage patterns by workload

| Workload | Storage pattern | Notes |
|---|---|---|
| Stateless web API | `emptyDir` or none | Container filesystem, ephemeral. No PVCs needed. |
| Database (single) | StatefulSet + RWO PVC | 1 Pod, 1 PVC. Backups via VolumeSnapshot. |
| Database (replicated) | StatefulSet + `volumeClaimTemplates` | Each replica gets its own PVC via the template. |
| Shared file storage across Pods | RWX PVC (NFS/EFS) | For legacy apps that expect shared filesystems. |
| Large ephemeral data (build cache) | `emptyDir` with `medium: Memory` (tmpfs) or a local SSD Node | For CI-like workloads. |
| Config / secrets as files | `configMap` / `secret` volumes | Not for data, for config. |

## Storage failure modes and remediation

**PVC stuck Pending** — see [MORE-PRODUCTION-INCIDENTS.md #8](MORE-PRODUCTION-INCIDENTS.md).

**Volume expansion stuck** — after `kubectl patch pvc data-x -p '{"spec":{"resources":{"requests":{"storage":"50Gi"}}}}'`:
- CSI driver resized the cloud disk, but the filesystem inside hasn't grown. Some CSI drivers do this online; some require a Pod restart.
- Check `kubectl describe pvc data-x` — look for `FileSystemResizePending` condition. If present, restart the Pod: `kubectl delete pod <pod>` (StatefulSet recreates with same PVC, resize completes on mount).

**PV stuck Terminating** — finalizer stuck. Common when the underlying cloud resource is already deleted but K8s doesn't know:
```bash
kubectl patch pv <name> -p '{"metadata":{"finalizers":null}}'
```
Destructive; only after confirming the underlying storage is really gone.

**Multi-Attach error** — RWO PVC is still attached to a node that's not responding. Cloud can't detach a volume from a node it can't talk to. On AWS:
```bash
aws ec2 detach-volume --volume-id vol-0abc123 --force
```

---

# Part 2: Multi-cluster architecture

## Why multi-cluster?

Reasons that come up in practice:
- **Blast radius** — a bad deploy or upgrade shouldn't take down every environment. Prod and staging on separate clusters.
- **Regional presence** — one cluster per region for latency and data residency.
- **Regulatory boundaries** — HIPAA, PCI, GDPR data on isolated clusters.
- **Tenant isolation** — heavy multi-tenancy can outgrow namespace isolation.
- **Version isolation** — old app on old K8s while new app on new K8s.

## Patterns

### Pattern 1: Independent clusters + GitOps sync

Each cluster is fully independent. A GitOps controller (Argo CD, Flux) on each cluster watches its slice of a shared Git repo.

```
Git repo
  clusters/
    prod-us-east/
      apps/
    prod-eu-west/
      apps/
    staging/
      apps/

Each cluster's Argo:
  - watches its own subfolder
  - syncs manifests to itself
  - reports status back to its own instance
```

**Pros**: simple, low-blast-radius, easy failover model.
**Cons**: no built-in cross-cluster discovery. Apps in cluster A can't easily reach services in cluster B without external networking (Ingress, VPN peering).

### Pattern 2: Cluster mesh / service mesh federation

Istio, Linkerd, or Cilium ClusterMesh let services in one cluster call services in another cluster by the same name. The mesh sidecar handles cross-cluster routing.

```
cluster A                        cluster B
  frontend Pod ─┐                    ┌─ backend Pod
                │                    │
                └── istio-proxy ────┴─ istio-proxy
                    (routes cross-cluster)
```

**Pros**: apps don't know or care about cluster boundaries.
**Cons**: complex to operate. Adds real dependencies on the mesh's control plane.

### Pattern 3: Kubernetes Federation (KubeFed)

Historically the "official" multi-cluster answer. Never got wide adoption because it added complexity without solving unique problems. **Skip it in 2026.**

### Pattern 4: Fleet management platforms

Anthos, Rancher, OpenShift ACM, EKS Anywhere + control plane. Central pane of glass across all clusters. Popular in large orgs.

## Cluster registration + workload placement

Modern platforms use CRDs like `Cluster` and `Placement`:

```yaml
apiVersion: cluster.open-cluster-management.io/v1beta2
kind: ManagedClusterSet
metadata:
  name: prod-clusters
spec:
  clusterSelector:
    labelSelector:
      matchLabels:
        environment: production
---
apiVersion: cluster.open-cluster-management.io/v1beta1
kind: Placement
metadata:
  name: place-web-workload
spec:
  clusterSets: [prod-clusters]
  numberOfClusters: 3
```

The controller then reconciles: pick 3 clusters that match `environment=production`, deploy the workload there.

## Cross-cluster networking

The hard part. Options:

- **VPN mesh** — every cluster's VPC peered. Pods in cluster A can reach Pod IPs in cluster B directly. Complex routing table maintenance.
- **Ingress-only** — services expose via Ingress with public/private DNS. Cross-cluster traffic goes through the Ingress. Simpler, less performant.
- **Service mesh** — Istio multi-cluster with a shared control plane and mTLS between meshes.
- **Cilium ClusterMesh** — eBPF-based; two Cilium clusters interconnect their service discovery.

## Multi-cluster secrets, config, RBAC

- **Central secret store** (Vault, AWS Secrets Manager) with External Secrets Operator on each cluster syncing → K8s Secrets. Keeps values out of Git.
- **RBAC federation** via SSO/OIDC — same identity provider issues tokens for all clusters.
- **Policy as code** — Kyverno / OPA policies stored in Git, deployed to every cluster.

---

# Part 3: Debugging — node down

## Symptom set

- `kubectl get nodes` shows a node `NotReady`.
- Pods on that node marked as `NodeLost` after ~5 minutes.
- Workloads evacuating to remaining nodes; those nodes now under pressure.
- If it's a control-plane node in a self-managed cluster, `kubectl` itself may be slow or failing.

## Playbook — worker node NotReady

**Step 1: Describe the node — what does K8s think is wrong?**

```bash
kubectl describe node node-x
```

Focus on the `Conditions` block:

```
Conditions:
  Type              Status
  MemoryPressure    True  ← node evicting due to memory
  DiskPressure      True  ← node evicting due to disk
  PIDPressure       False
  Ready             False (KubeletNotReady, "container runtime is not ready")
```

Match to the appropriate remediation:
- **MemoryPressure / DiskPressure** — resource exhaustion. See [MORE-PRODUCTION-INCIDENTS.md #11](MORE-PRODUCTION-INCIDENTS.md).
- **Ready: False, KubeletNotReady** — kubelet crashed or lost API connection.
- **Ready: Unknown** — node hasn't heartbeat in > 40s (default `node-monitor-grace-period`). Network partition or node crashed.

**Step 2: If accessible, ssh to the node**

```bash
# On managed clusters, use the debug pod
kubectl debug node/node-x -it --image=busybox
```

Inside:

```bash
chroot /host              # switch into the node's real filesystem
systemctl status kubelet  # is the kubelet running?
journalctl -u kubelet -n 100  # last 100 lines of kubelet logs
```

**Common causes visible in kubelet logs:**
- `container runtime is unhealthy` — containerd or Docker socket unreachable. Restart: `systemctl restart containerd`.
- `no space left on device` — see disk pressure remediation.
- `Failed to update Node lease` — API server unreachable from this node. Check networking / DNS.

**Step 3: Container runtime**

```bash
systemctl status containerd
crictl ps                 # list running containers
crictl images             # list images
```

If containerd is dead but kubelet is alive, kubelet reports NotReady immediately. Restart containerd; kubelet re-connects.

**Step 4: If truly unrecoverable, evacuate and replace**

```bash
# On the control plane / your laptop:
kubectl cordon node-x                     # stop new Pods from landing here
kubectl drain node-x --ignore-daemonsets --delete-emptydir-data
# ... replace the node (cloud auto-repair, or terraform apply, or ...)
kubectl delete node node-x                # remove from cluster state
```

Managed clusters (EKS, GKE, AKS) with node auto-repair enabled do this automatically.

## Playbook — control plane / etcd issues

If the control plane is affected, `kubectl` itself is degraded. Signs:
- `kubectl get pods` takes 10+ seconds.
- Deploys stall in `Waiting for deployment to be updated`.
- New Pods slow to schedule.

**Step 1: Check control-plane pod health**

```bash
kubectl get pods -n kube-system
```

Look for `kube-apiserver`, `kube-controller-manager`, `kube-scheduler`, `etcd` — all should be Running.

**Step 2: etcd health** (self-managed clusters)

```bash
# From an etcd Pod
kubectl exec -n kube-system etcd-master-0 -- etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  endpoint status --write-out=table
```

Should show `IS LEADER: true` for one member, `false` for others. If no leader, etcd has lost quorum. Recovery involves rebuilding from a snapshot — plan for downtime.

**Step 3: API server latency**

```bash
kubectl get --raw='/metrics' | grep apiserver_request_duration_seconds
```

Or look at `apiserver_request_total{code="..."}` for error rates. Common cause of API server slowness: etcd disk latency. See [MORE-PRODUCTION-INCIDENTS.md #7's cousin — the etcd incident in PRODUCTION-INCIDENTS.md](PRODUCTION-INCIDENTS.md).

---

# Part 4: Debugging — cluster-wide issues

## "Everything is slow"

Almost always control plane. See node-down playbook step 2-3.

## "New Pods aren't scheduling anywhere"

**Scheduler stuck or unhealthy:**

```bash
kubectl get pods -n kube-system -l component=kube-scheduler
kubectl logs -n kube-system -l component=kube-scheduler --tail=100
```

**Every node full:**

```bash
kubectl describe nodes | grep -A 5 "Allocated resources"
```

Sum of requests across all nodes = cluster capacity. If it's above 80%, new Pods struggle.

**Admission webhooks blocking:**

```bash
kubectl get validatingwebhookconfigurations
kubectl get mutatingwebhookconfigurations
```

A broken webhook (target Pod is down, but K8s still tries to call it on Pod creation) rejects every new Pod. Fix: delete the webhook config or set `failurePolicy: Ignore`.

## "Half the Pods can't reach the other half"

CNI issue. Common on:
- Node networking blip (recent auto-scaling event, node reboot).
- CNI plugin (Calico, Cilium) has a problem on some nodes.

**Diagnose:**

```bash
# From Pod A, try to reach Pod B by IP
kubectl exec -it pod-a -- ping <pod-b-ip>
```

If it fails: CNI. Check the CNI plugin's DaemonSet:

```bash
kubectl get pods -n kube-system -l k8s-app=<cni-plugin>
kubectl logs -n kube-system <cni-pod> --tail=100
```

## "DNS is broken cluster-wide"

CoreDNS Pods are failing or overwhelmed. See [MORE-PRODUCTION-INCIDENTS.md #7](MORE-PRODUCTION-INCIDENTS.md#incident-7-in-cluster-dns-lookups-intermittently-failing).

---

# Part 5: Debugging — application not accessible

## The systematic walk-through

The user says "the app is down." You don't know where the failure is. Walk the traffic path from outside in:

### 1. Can you reach the Ingress?

```bash
curl -v https://api.example.com/health
```

- Connection refused → DNS or network before the LB. Check DNS resolution: `dig api.example.com`. Check the LB status in the cloud console.
- 502/503 → Ingress controller is up but has no healthy backends. Continue.
- Timeout → network path broken. Firewall, security group, VPC.

### 2. Does the Ingress route to the right Service?

```bash
kubectl describe ingress api-ingress
```

Verify rules: right host, right path, right backend Service name.

### 3. Does the Service have Endpoints?

```bash
kubectl get endpoints <svc-name>
```

Empty means no Pod matches the selector, OR matching Pods are all not-Ready. Both are common.

Compare Service selector to Pod labels:

```bash
kubectl get svc <name> -o jsonpath='{.spec.selector}'
kubectl get pods --show-labels
```

If they don't match: fix the Service selector or Pod labels.

### 4. Are the Pods actually Ready?

```bash
kubectl get pods -l app=<label>
kubectl describe pod <not-ready-pod>
```

Focus on:
- `Conditions.Ready` — if False, readiness probe is failing. Look at the probe config vs the app's actual health endpoint.
- `Containers.<name>.State` — if `Terminated` with `Reason: OOMKilled`, resource issue. If `Waiting` with `Reason: ImagePullBackOff`, image issue.

### 5. Can traffic actually reach the Pod?

From a debug Pod in the same namespace:

```bash
kubectl run debug --rm -it --image=curlimages/curl --restart=Never -- \
  sh -c "curl -v http://<service-name>/"
```

If that works and external doesn't: NetworkPolicy or LB config.

If neither works: the Pod itself is broken. Read the Pod's logs.

### 6. Are the Pod's logs telling us the app is broken?

```bash
kubectl logs <pod> --tail=200
kubectl logs <pod> --previous       # if the container has been restarting
```

Look for exceptions, DB connection failures, timeouts to dependencies.

### 7. Is a dependency down?

If the app is up but returning 5xx: something downstream is failing. Common:
- Database unreachable → check Pod logs for connection errors.
- Cache (Redis) down → check its Pods.
- External API down → check outbound network.

## The 30-second version

1. `kubectl get ingress` — Ingress exists?
2. `kubectl get svc` — Service exists?
3. `kubectl get endpoints` — Endpoints populated?
4. `kubectl get pods -l app=X` — Pods running and Ready?
5. `kubectl logs -l app=X --tail=50` — What's the app saying?

If those 5 commands all show green and the app is still broken, it's an app-code issue.

---

# Part 6: Service discovery — how it actually works

## Two mechanisms

Kubernetes gives you service discovery via **two independent mechanisms**:

1. **DNS** — CoreDNS translates Service names to virtual IPs.
2. **Environment variables** — kubelet injects `<SVC>_SERVICE_HOST` and `<SVC>_SERVICE_PORT` env vars into Pods for Services that existed *before the Pod started*.

You almost always use DNS. The env-var mechanism is legacy and can bite you if your app reads env at startup.

## DNS end-to-end flow

Assume your Pod is in namespace `default`, and it wants to reach `backend.staging.svc.cluster.local`.

**Step 1: `/etc/resolv.conf` inside the Pod**

Kubelet writes this file when the Pod starts:

```
search default.svc.cluster.local svc.cluster.local cluster.local
nameserver 10.43.0.10
options ndots:5
```

- `nameserver 10.43.0.10` — the ClusterIP of the CoreDNS Service (`kube-dns` in kube-system).
- `search` — search domains. Bare hostnames are tried against each.
- `options ndots:5` — if the hostname has fewer than 5 dots, try search domains first. This is why `curl backend` inside a Pod does multiple DNS lookups.

**Step 2: The DNS query**

App calls `getaddrinfo("backend.staging.svc.cluster.local")`. Libc → `/etc/resolv.conf` → sends a DNS UDP query to `10.43.0.10:53`.

**Step 3: kube-proxy intercepts**

`10.43.0.10` is a Service ClusterIP — not a real network IP. kube-proxy's iptables/IPVS rules DNAT the query to one of the CoreDNS Pod IPs (e.g., `10.42.0.4:53`).

**Step 4: CoreDNS answers**

CoreDNS has the `kubernetes` plugin loaded. It:
1. Parses the query name: `backend.staging.svc.cluster.local`.
2. Recognizes the `cluster.local` suffix as its zone.
3. Looks up the `backend` Service in the `staging` namespace via the K8s API (cached).
4. Returns the Service's ClusterIP (say `10.43.55.12`) as an A record.

**Step 5: App connects to the ClusterIP**

App now has `10.43.55.12:80`. Sends TCP SYN.

**Step 6: kube-proxy intercepts again**

`10.43.55.12` is another ClusterIP. kube-proxy's rules DNAT the traffic to one of the backend Pod IPs from the Service's EndpointSlices, chosen randomly.

**Step 7: Reply**

Backend Pod responds. Reverse-NAT translates the source back so the calling app sees the response from `10.43.55.12:80`, not the Pod IP directly.

**Net effect:** app said "call backend"; K8s routed it, load-balanced it, and hid all the plumbing.

## Service DNS naming rules

Given a Service `foo` in namespace `bar`:

| From caller in namespace | You can use |
|---|---|
| `bar` (same ns) | `foo` |
| any | `foo.bar` |
| any | `foo.bar.svc.cluster.local` (fully-qualified) |

For a **headless Service** (StatefulSet's per-Pod DNS):

```
<pod-name>.<service-name>.<namespace>.svc.cluster.local
e.g. postgres-0.postgres.default.svc.cluster.local
```

Each Pod gets a stable DNS record. Clients can pick a specific replica.

## Why `ndots: 5` is a problem

Default `ndots: 5` means: for any lookup with fewer than 5 dots, try search domains first. So looking up `redis` becomes:

```
1. redis.default.svc.cluster.local     → miss
2. redis.svc.cluster.local              → miss
3. redis.cluster.local                  → miss
4. redis.                                → miss (as external)
5. actual attempt at "redis" as external → resolves
```

Five DNS queries for one bad-luck hostname. Multiplied across every service-to-service call, this floods CoreDNS.

**Fix**: set `dnsConfig` on the Pod:

```yaml
spec:
  dnsConfig:
    options:
      - name: ndots
        value: "2"
```

Or use fully-qualified names in app config (with trailing dot: `backend.default.svc.cluster.local.`).

## Env-var service discovery (legacy)

For Services created *before* a Pod starts, kubelet injects env vars into the Pod:

```
BACKEND_SERVICE_HOST=10.43.55.12
BACKEND_SERVICE_PORT=80
```

Legacy Docker link-style. **Prefer DNS**. Env-var discovery fails silently if the Service is created after the Pod — the Pod has stale env with no service to connect to.

---

# Part 7: Networking — the full picture

## The Kubernetes network model

Baseline requirements every K8s network must satisfy:

1. **Every Pod gets a unique IP** — allocated by the CNI plugin (Calico, Cilium, flannel, AWS VPC CNI).
2. **Pods can reach any other Pod without NAT** — flat network across all nodes.
3. **Node processes can reach all Pods** — kubelet health checks, node-local logic.
4. **Pods can reach the outside** — usually via NAT on the node's egress path.

## How Pod IPs are allocated

**AWS VPC CNI** (default on EKS): every Pod gets an actual VPC IP. Requires many IPs per node (limited by instance type). Direct routing — no overlay.

**Calico** / **Cilium** in default modes: Pods get IPs from a cluster-managed CIDR. Cross-node traffic uses either BGP routing (Calico BGP) or an overlay (VXLAN, IPIP).

**flannel** (default on k3s): VXLAN overlay. Simple. Doesn't enforce NetworkPolicies without an extra plugin.

## Traffic flow — external client to Pod

```
User at 192.0.2.1
    │  HTTPS
    ▼
Cloud LB (ALB, NLB, or nginx-ingress' LB)
    │  Terminates TLS
    │  Routes based on Host + Path (if L7 Ingress)
    ▼
Kubernetes Node (any node's IP:NodePort — or Pod IP directly for ALB with target-type ip)
    │  kube-proxy iptables DNAT: NodePort → PodIP
    ▼
Pod on some node
    │  Container network namespace
    ▼
Application process listening on 0.0.0.0:3000
```

Traffic can bounce between nodes if `externalTrafficPolicy: Cluster` (default) — the arriving node might not host a backend. `Local` mode keeps traffic on the arrival node (preserves client IP but risks uneven distribution).

## Traffic flow — Pod to Pod (same or different namespace)

Fastest path. Pod A's outbound to `backend`:
1. DNS resolves `backend` to ClusterIP `10.43.55.12`.
2. Pod A's TCP SYN goes to `10.43.55.12:80`.
3. Node's iptables (kube-proxy) DNAT rewrites to a backend Pod IP.
4. If the backend Pod is on the same node: local delivery via the bridge.
5. If on a different node: through the CNI overlay/routing to the other node's bridge, into the Pod.

No hairpin through kube-proxy for return traffic — connection tracking handles it.

## Egress (Pod to internet)

1. Pod sends packet to public IP.
2. Node's iptables MASQUERADE rule rewrites source IP from Pod IP to Node IP.
3. Packet leaves node's default interface.
4. Internet.

Reverse path: internet → node → SNAT-reverse → Pod.

To identify Pod-originating traffic externally: use an egress gateway (Istio, dedicated egress node) that gives distinct source IPs per namespace/service.

## Diagnosing network issues

**"Pod can't reach Service"**:
- Endpoints empty? Fix labels.
- kube-proxy broken? `kubectl get pods -n kube-system -l k8s-app=kube-proxy`.
- NetworkPolicy blocking? `kubectl get networkpolicies -A`.

**"Pods on some nodes can't reach Pods on others"**:
- CNI health: `kubectl get pods -n kube-system -l k8s-app=<cni>`.
- MTU mismatch — VXLAN overhead means Pod MTU must be lower than node MTU. Look for fragmentation.

**"DNS lookups are slow"**:
- CoreDNS resource contention — see [MORE-PRODUCTION-INCIDENTS.md #7](MORE-PRODUCTION-INCIDENTS.md).
- `ndots: 5` — install NodeLocal DNSCache, tune Pods.

**"Traffic to a specific IP is broken"**:
- `conntrack` table full — high-throughput proxy Pods can hit the node's connection tracking limit. Alert on `nf_conntrack_count`.

---

## Where to go from here

- **Per-concept how-it-works**: see `INTERNALS.md` in each project folder.
- **Command-level debugging**: [KUBECTL-GUIDE.md](KUBECTL-GUIDE.md).
- **Real incident narratives**: [PRODUCTION-INCIDENTS.md](PRODUCTION-INCIDENTS.md) and [MORE-PRODUCTION-INCIDENTS.md](MORE-PRODUCTION-INCIDENTS.md).
