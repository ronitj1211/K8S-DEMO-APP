# Interview Questions — DaemonSets

---

## Basic

### Q1. What's a DaemonSet?
A controller that ensures **one Pod runs on every node** (or every node matching a selector). When a node joins, a Pod is added; when a node leaves, the Pod is garbage-collected. You don't pick the replica count — Kubernetes does, based on node count.

### Q2. When to use DaemonSet vs Deployment?
- **Deployment** — "run N copies anywhere." Stateless apps.
- **DaemonSet** — "one per node." Per-node infrastructure: log shippers (Fluent Bit), metrics agents (node_exporter, Datadog), network plugins (Calico, Cilium), storage CSI drivers, security agents (Falco).

The rule of thumb: if the workload needs to see what's happening on *that* node, it's a DaemonSet.

### Q3. How do you limit a DaemonSet to a subset of nodes?
```yaml
spec:
  template:
    spec:
      nodeSelector:
        role: monitoring
```
Or with `affinity.nodeAffinity` for richer expressions (`In`, `NotIn`, `Exists`). DaemonSets ignore taints **unless** you add tolerations.

### Q4. How do you run a DaemonSet on tainted nodes (e.g., control plane)?
Add tolerations:
```yaml
tolerations:
  - key: node-role.kubernetes.io/control-plane
    effect: NoSchedule
  - key: node.kubernetes.io/not-ready
    effect: NoExecute
    tolerationSeconds: 300
```
Kube-proxy is a DaemonSet that tolerates the control-plane taint so it actually runs on every node.

### Q5. What's `hostPath` and why do DaemonSets use it?
`hostPath` mounts a directory from the **node's** filesystem into the Pod. DaemonSets use it to read node-local state — `/var/log` for log shippers, `/proc` for metrics agents, `/var/lib/docker/containers` for container log enrichment.

### Q6. What's `hostNetwork: true`?
The Pod shares the node's network namespace — same IP, same interfaces. Used by CNI agents, kube-proxy, etc., where you need to manipulate or observe the node's networking. Loses normal Pod IP allocation. Don't use for apps.

### Q7. DaemonSet update strategies?
- **`RollingUpdate`** (default) — replace Pods node-by-node, controlled by `maxUnavailable` (or the newer `maxSurge` in 1.21+).
- **`OnDelete`** — only replace a Pod when you manually delete it. Used when an upgrade is risky and you want explicit control.

---

## Intermediate

### Q8. Can a DaemonSet have `maxSurge`?
Since K8s 1.22: yes. `maxSurge` lets a temporary extra Pod run on a node during update, so there's no gap. Before 1.22, only `maxUnavailable` existed and rolling updates always had a brief gap. `maxSurge` requires sufficient node resources to hold both Pods briefly.

### Q9. Difference between `hostPort` and a NodePort Service for DaemonSet?
- **`hostPort`** — exposes the container port on the node's IP directly. Reachable at `<nodeIP>:<hostPort>`. Skips Service / kube-proxy entirely.
- **NodePort Service** — kube-proxy routes the NodePort to the right Pod via iptables, with load balancing if multiple Pods match the selector.

DaemonSets often use `hostPort` because there's exactly one Pod per node — the node IP and port uniquely identify the Pod, no load-balancing needed.

### Q10. How does DaemonSet handle a new node joining the cluster?
The DaemonSet controller watches Node objects. On a new Node that matches the DaemonSet's affinity/tolerations, it creates a Pod with `nodeName` set to the new node's name (which is why DaemonSet Pods don't go through the scheduler the same way — they're already pinned). When a Node is deleted, the Pods are garbage-collected.

### Q11. What's the DaemonSet's relationship with the scheduler?
Historically the DaemonSet controller assigned Pods to nodes itself, bypassing the scheduler. Since K8s 1.12 (stable 1.17), DaemonSets use the default scheduler — Pods go through normal scheduling with `nodeAffinity` to pin them to the specific node. This unified path made taints/tolerations / Pod priority work uniformly.

### Q12. Why don't DaemonSets have a `replicas` field?
Because the replica count is implicit — one per matching node. The DaemonSet manages this dynamically; you can't override it.

### Q13. Can two DaemonSets target the same node?
Yes, each runs its own Pod. They can also share `hostNetwork`/`hostPath` if they coordinate (e.g., one writes logs and another tails them) — but that's coordination you build, not isolation K8s gives you.

### Q14. What's a sensible PriorityClass for DaemonSets?
**High.** Per-node infrastructure (logging, networking, security) should evict normal workloads under resource pressure, not the other way around. The standard `system-node-critical` PriorityClass (-2147483647... wait, +2000000000) is reserved for critical DaemonSets like kube-proxy.

---

## Scenario-based

### S1. Your DaemonSet has 0 Pods on a 5-node cluster. Why?
- Node label mismatch with `nodeSelector` / `nodeAffinity`. `kubectl describe node <n>` shows labels.
- All nodes have a taint the DaemonSet doesn't tolerate.
- Resource requests exceed any node's allocatable capacity.
- Pod template image is broken — Pods stuck in `ImagePullBackOff` show as `DESIRED: 5, CURRENT: 5, READY: 0`.

`kubectl describe daemonset <name>` events usually pinpoint it.

### S2. You want to upgrade a node-agent DaemonSet but one specific node is critical. What's `OnDelete` good for?
`updateStrategy.type: OnDelete` means upgrades only happen when you manually `kubectl delete pod <pod>`. You roll out node-by-node, validating each one. Useful for storage CSI drivers or anything where a bad upgrade causes data loss. Combine with PodDisruptionBudget for further safety.

### S3. A log-collector DaemonSet's CPU usage is spiking on one node. What do you check?
- Is that node receiving abnormally high log volume? (`kubectl logs <ds-pod-on-that-node> | wc -l`)
- A noisy Pod logging in a tight loop?
- Network back-pressure to Elasticsearch — the DaemonSet retries hot.
- A `multiline` parser stuck on a malformed stream.

Look at the DaemonSet Pod's metrics if you instrument them, or compare CPU across the DaemonSet's Pods to identify the outlier.

### S4. How to roll out a DaemonSet without all node agents going unavailable at once?
Default `maxUnavailable: 1` already does that — one node at a time. For a 100-node cluster, that's 100 rollout steps, taking a while. Bump to `maxUnavailable: 10` (or 10%) to parallelize. Add `maxSurge: 1` if you want zero-gap on each node (1.22+).

### S5. The DaemonSet Pod is in CrashLoopBackOff on every node — same error.
Almost certainly config (env var, mounted file, or hostPath wrong). Read logs:
```bash
kubectl logs ds/<name> --tail=50 --all-containers
```
If the error is "permission denied reading /var/lib/something" — the hostPath isn't readable as the Pod's user (likely missing `securityContext: { runAsUser: 0 }` for a privileged DS).
If "host not resolvable" — DNS misconfig or missing `hostNetwork: true`.

### S6. A node is being decommissioned (`kubectl drain`). What happens to its DaemonSet Pod?
`kubectl drain` ignores DaemonSet Pods by default (it has `--ignore-daemonsets=true` baked in). They keep running until the node is removed from the cluster (`kubectl delete node`), at which point the DaemonSet controller GCs the Pod. If you set `--disable-eviction --ignore-daemonsets=false`, drain will try to evict them too — usually wrong.

### S7. Your DaemonSet needs to access the K8s API to discover other Pods on its node. How?
Give it a dedicated ServiceAccount with a Role that allows `list pods`. Use field selector `spec.nodeName=$NODE_NAME` (downward API) so you only list Pods on the local node — limiting the watch scope and reducing API server load.

```yaml
env:
  - name: NODE_NAME
    valueFrom: { fieldRef: { fieldPath: spec.nodeName } }
```

Then in code: `kubectl get pods --field-selector spec.nodeName=$NODE_NAME`.
