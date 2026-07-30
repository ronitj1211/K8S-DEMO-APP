# DaemonSets — Internals

Controller mechanics, node-selection, hostPath/hostNetwork/hostPID, update strategies.

---

## Purpose

A DaemonSet ensures **exactly one Pod runs on every matching node**. Node joins → Pod added. Node leaves → Pod garbage-collected. You don't set replicas — the controller derives them from the current set of matching nodes.

Used exclusively for **per-node workloads**: log collectors (Fluent Bit), metrics agents (node-exporter), CNI plugins, CSI drivers, security scanners.

## The DaemonSet controller

Watches:
- **DaemonSet** objects.
- **Node** objects.
- **Pods** owned by the DaemonSet.

**Reconcile loop:**

1. Compute the set of nodes matching the DaemonSet's `spec.template.spec.nodeSelector` / `affinity`.
2. For each matching node:
   - If no DS-owned Pod exists on that node → create one with `spec.nodeName` pre-set to that node.
   - If a Pod exists but is stuck (terminating, unhealthy for too long) → remove and re-create.
3. For nodes that stopped matching (label removed, node deleted) → delete the Pod.

**Pods don't go through the scheduler in the normal sense.** Since K8s 1.12+ (stable 1.17), DaemonSet Pods are created with a nodeAffinity that forces the target node, and the scheduler's role is minimal — it just accepts the pre-assigned node. This ensures taints/tolerations, PodPriority, and PriorityClasses work uniformly (they didn't in older versions where DS bypassed the scheduler entirely).

## Node matching — what "matching" means

A node "matches" a DaemonSet if:

1. Node's labels satisfy the DaemonSet's `nodeSelector` (or all `nodeAffinity` `required` terms).
2. Node's taints are either not `NoSchedule` or the DaemonSet has a matching toleration.
3. Node is Ready (usually; there are edge cases).

**Common taints DaemonSets need to tolerate**:
- `node-role.kubernetes.io/control-plane: NoSchedule` — control-plane nodes. kube-proxy tolerates this; app DaemonSets usually don't.
- `node.kubernetes.io/not-ready: NoExecute` — added when a node goes not-ready. DaemonSets that tolerate this stay running on troubled nodes (useful for network plugins that might help recover the node).

A "run everywhere" DaemonSet:

```yaml
spec:
  template:
    spec:
      tolerations:
        - operator: Exists   # tolerate ALL taints — rare, use with care
```

## Update strategies

`RollingUpdate` (default) — kill and replace Pods node-by-node.

Key knob:
- `maxUnavailable: 1` (default) — at most 1 node at a time without an updated DS Pod.
- `maxSurge: 1` (K8s 1.22+) — allow a new Pod to start before killing the old one on that node. Zero-gap on each node's coverage, requires slightly more resources.

For a 100-node cluster with `maxUnavailable: 10%`, updates roll 10 nodes at a time.

**`OnDelete`** — no automatic rollout. New Pods only come up when you manually delete an old one. Used for risky updates (storage CSI, network plugins) where you want to verify per-node.

## `hostPath` — mounting node filesystem

```yaml
volumes:
  - name: host-logs
    hostPath:
      path: /var/log
      type: DirectoryOrCreate
```

**Under the hood**: kubelet performs a bind mount. `/var/log` on the node's filesystem becomes `/host-logs` (or wherever) inside the Pod's mount namespace.

**Security implication**: whatever the Pod's UID has access to on the host is now accessible from the Pod. `hostPath: /` is a full node filesystem escape. Restrict to specific dirs, use `type:` (Directory, File, Socket, etc.) to prevent creating unexpected paths.

**Types**:
- `DirectoryOrCreate` — create if missing (kubelet mkdir).
- `Directory` — must exist.
- `File` — must be a regular file.
- `Socket` — Unix socket (for talking to node daemons like Docker socket).

## `hostNetwork: true`

The Pod shares the node's network namespace directly.

- The Pod has no unique IP — it uses the node's IP.
- Ports the Pod binds are bound on the node itself.
- `netstat -tln` on the node lists the Pod's listeners.

**Used by**:
- kube-proxy (programs the node's iptables).
- CNI agents (Calico's Felix, Cilium).
- kube-controller-manager on some setups.

**Trade-off**: Pod loses network isolation; a compromise on the Pod means access to the node's networking.

## `hostPID: true` and `hostIPC: true`

Rarely used. Give the Pod visibility into the node's process list and IPC namespace. Debugging tools sometimes need this; regular apps never.

## Log collectors — how they work as DaemonSets

A canonical DaemonSet workload:

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: fluent-bit
  namespace: logging
spec:
  selector: { matchLabels: { app: fluent-bit } }
  template:
    metadata:
      labels: { app: fluent-bit }
    spec:
      serviceAccountName: fluent-bit          # needs API access for Pod metadata
      tolerations:
        - operator: Exists                     # run on all nodes including control-plane
      containers:
        - name: fluent-bit
          image: fluent/fluent-bit:3.0.7
          volumeMounts:
            - { name: varlog,     mountPath: /var/log }
            - { name: containers, mountPath: /var/lib/containerd/containers, readOnly: true }
            - { name: config,     mountPath: /fluent-bit/etc/ }
      volumes:
        - name: varlog
          hostPath: { path: /var/log }
        - name: containers
          hostPath: { path: /var/lib/containerd/containers }
        - name: config
          configMap: { name: fluent-bit-config }
```

Every node runs a Fluent Bit Pod that:
1. Bind-mounts the node's `/var/log` to see all container log files.
2. Watches `/var/log/containers/*.log`.
3. Calls the K8s API (via its ServiceAccount) to enrich with Pod metadata.
4. Ships to Elasticsearch/Loki/etc.

Because it's a DaemonSet, a new node added to the cluster automatically gets Fluent Bit — no manual step.

## CNI plugin DaemonSets

Calico, Cilium, Weave, flannel — all run as DaemonSets. They program the node's networking (IP allocation for Pods, routing for cross-node traffic, iptables/eBPF for policies).

Prior to K8s 1.13, CNI plugin startup was a chicken-and-egg problem: the plugin needs to run before Pods have networking, but the plugin itself is a Pod that needs... networking. Modern kubelet handles this — Pods with `hostNetwork: true` don't need the CNI to be up, so CNI DaemonSets bootstrap themselves.

## DaemonSet vs static Pod

For control-plane components running on every node (like kube-proxy), why DaemonSet and not static Pod?

- **Static Pod** — declared in a file on the node (`/etc/kubernetes/manifests/`), only manageable by editing files on nodes.
- **DaemonSet** — declared once in the cluster; auto-applies to new nodes.

DaemonSet wins for anything that scales with node count. Static Pods stay in use for **the API server itself** and other pre-API-server bootstrap needs on control-plane nodes.

## DaemonSets and PDBs

You can attach a PodDisruptionBudget to a DaemonSet's Pods:

```yaml
kind: PodDisruptionBudget
metadata:
  name: fluent-bit-pdb
spec:
  minAvailable: 3          # never fewer than 3 nodes running fluent-bit
  selector:
    matchLabels: { app: fluent-bit }
```

Effect: `kubectl drain` (voluntary disruptions) will refuse to evict a Pod that would drop below `minAvailable`. Great for critical DaemonSets during rolling node upgrades.

## Common patterns

**Node problem detector**: a DaemonSet reports node-level events (kernel deadlocks, disk failures) as Node conditions or Events.

**Prometheus node-exporter**: DaemonSet exposing `/metrics` on each node. Prometheus's Kubernetes SD role: node targets these directly.

**AWS EBS CSI driver**: DaemonSet component (node plugin) handles volume attach/detach on each node. Paired with a Deployment (controller plugin) that handles cloud API calls.

## Debugging DaemonSets

```bash
# DS status
kubectl get ds -n <ns>
# DESIRED = number of matching nodes
# CURRENT = created
# READY = ready to serve
# DESIRED == CURRENT == READY means healthy

kubectl describe ds <name>
# Events section shows scheduling failures

# Which nodes have (or don't have) the DS Pod?
kubectl get pods -l app=<label> -o wide --sort-by=.spec.nodeName

# Compare to node list
kubectl get nodes
```

If `DESIRED < number of nodes` — the DS's nodeSelector or affinity excludes some nodes. Check node labels.

If `DESIRED == CURRENT` but `READY < CURRENT` — some Pods are not passing readiness. Standard Pod-level debug.

---

## The 30-second summary

- DaemonSet controller watches Nodes; ensures one Pod per matching node.
- No `replicas:` field — count is derived.
- Uses `nodeSelector` / `affinity` / `tolerations` to pick which nodes.
- DS Pods usually use `hostPath` (node filesystem access), `hostNetwork` (node network stack), or `hostPID` (node process visibility) — that's what makes DS the right primitive for node-level agents.
- RollingUpdate (default) — one Pod at a time; add `maxSurge` for zero-gap coverage; OnDelete for risky upgrades.
- Common workloads: log collectors, metrics agents, CNI, CSI, security agents.
