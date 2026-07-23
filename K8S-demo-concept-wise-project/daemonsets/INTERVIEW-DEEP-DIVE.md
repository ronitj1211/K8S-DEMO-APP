# DaemonSets — Deep Dive for Interviews

The narrative version. Why "one Pod per node" needed its own primitive.

---

## The origin story

Most workloads scale by request volume: more users, more Pods. Some workloads scale by nodes: **every node needs a copy**. Log collectors need to read `/var/log/containers` on each node. Network plugins need to run on each node to program iptables. Storage CSI drivers need to attach volumes to nodes. Monitoring agents (node-exporter, Datadog) need to sample each node's system metrics.

You could try to fake this with a Deployment and node affinity. Doesn't work well — Deployments don't reason about "one per node." A new node joining the cluster wouldn't automatically get a Pod. A Deployment with 3 replicas doesn't guarantee 3 different nodes.

**DaemonSet** is the K8s primitive designed exactly for this: "run one Pod on every node matching a selector." When a new node joins, a Pod is added automatically. When a node leaves, the Pod is garbage-collected.

## The mental model

Think of DaemonSet as **"per-node service."** You don't say how many replicas — you say what pool of nodes to cover. The DaemonSet controller derives the count from cluster state.

Contrast with Deployment:
- Deployment: "run N interchangeable Pods anywhere."
- DaemonSet: "run one Pod on every matching node."

The workload usually needs node-level access to be useful:
- `hostPath` volumes to read node filesystem (log collectors reading `/var/log/containers`).
- `hostNetwork: true` to share the node's networking (kube-proxy, CNI agents).
- `hostPort` to bind a port on the node's IP (rare — usually a Service is better).
- Access to node-level APIs (via privileged containers, for storage/networking plugins).

If your workload doesn't need any of that, it's probably a Deployment, not a DaemonSet.

## How it actually works

The DaemonSet controller watches Node objects. For each node that matches the DaemonSet's `nodeSelector` / `affinity` / tolerations:
- If a matching Pod isn't running there, create one with `nodeName` pre-set to the target node.
- If the node is removed, the Pod is garbage-collected.

Pods created by a DaemonSet don't go through the normal scheduler's ranking — they're pinned to specific nodes at creation time. (Before K8s 1.12, the DaemonSet controller bypassed the scheduler entirely. Since 1.17 stable, DS pods go through the scheduler with nodeAffinity that forces the target node — this unified path lets taints/tolerations/priority work uniformly.)

**Taints & tolerations matter.** The control plane nodes have a taint (`node-role.kubernetes.io/control-plane:NoSchedule`) that prevents ordinary workloads from scheduling there. A DaemonSet that needs to also cover control-plane nodes (like kube-proxy) has to add a toleration for that taint. Otherwise it silently skips control-plane nodes.

**Update strategies:**
- `RollingUpdate` (default) — replace Pods node-by-node, controlled by `maxUnavailable` (or newer `maxSurge` in 1.22+).
- `OnDelete` — only replace when you manually delete a Pod. Used when upgrades are risky (storage plugins, network plugins) and you want to control the pace.

## When to use it (and when not to)

**Perfect fit:**
- Log collectors (Fluent Bit, Filebeat, Vector).
- Node-level metrics (node-exporter, Datadog agent, New Relic infra).
- CNI plugins (Calico, Cilium, Weave agents).
- CSI drivers (EBS CSI, Azure Disk).
- Security agents (Falco, Aqua, Wiz).
- kube-proxy itself (K8s ships it as a DaemonSet).

**Wrong tool:**
- App workloads. "We want one API replica per node" is not a good design — you can't scale independently of node count, and you're coupling deploy planning to infrastructure planning.
- Workloads that need horizontal scaling based on load. Use a Deployment + HPA.

## Common misunderstandings

**"DaemonSet has a `replicas` field."** It doesn't. Count is implicit — one per matching node.

**"DaemonSets automatically cover new nodes."** Only if the new node matches the DS's selector / affinity / tolerations. A new node with an unusual taint may be skipped.

**"`hostPath` volumes are just like PVCs."** No — hostPath mounts a directory from the *node's filesystem*. It's tied to a specific node. If the Pod moves nodes, it sees a completely different filesystem. That's fine for DaemonSets (which are pinned to a node) but disastrous for anything else.

**"`hostNetwork: true` gives the Pod normal cluster networking plus more."** Actually it replaces the Pod's own network namespace with the node's — the Pod loses its own IP, uses the node's IP directly. This is what kube-proxy needs to program iptables on the node.

**"DaemonSet rolling updates are safe."** They kill Pods one at a time by default (`maxUnavailable: 1`). For a critical DaemonSet like the CNI, "one node without networking" isn't zero-impact — workloads on that node lose network briefly. In 1.22+, `maxSurge: 1` lets a new Pod start before the old is removed.

**"DaemonSet Pods count against my Pod resource quota."** They do — same as any other Pod. Big DaemonSets on big clusters can eat quota surprisingly fast (100 nodes × one Pod per DS × 10 DSes = 1000 Pods).

## The war stories

**"Fluent Bit DaemonSet CPU is spiking on one node."** That node had a Pod logging in a tight loop (accidental `while true; do log; done` in code). Fluent Bit was drinking from a firehose. Investigate the log volume per Pod, not just the collector.

**"Our new node isn't running the log collector."** New node has a `node-role.kubernetes.io/gpu:NoSchedule` taint. The DaemonSet doesn't tolerate it. Fix: add a toleration for the taint on the DaemonSet's Pod template.

**"CNI DaemonSet upgrade brought down networking for 30 seconds per node."** `updateStrategy: RollingUpdate` with `maxUnavailable: 1` on a large cluster means one node at a time, one node worth of networking outage each time, and the whole cluster's Pods on that node can't reach anything for 30 seconds. Fix on 1.22+: `maxSurge: 1` to have a new agent up before the old is killed. Or use `OnDelete` and do it manually node-by-node with health checks between.

**"DaemonSet Pod is Pending forever."** Node has insufficient resources for the DS Pod's requests (rare but happens on very small nodes or if the DS asks for too much). Or the DS Pod requires a specific label the node doesn't have.

**"Someone made a `hostPath: /` mount."** Reads/writes anywhere on the node. Massive security hole — Pod can read `/etc/shadow`, write to system binaries. Only give DaemonSets the specific hostPath they need (`/var/log/containers`, not `/`), and use a `PodSecurityPolicy` or admission controller to block wildcards.

## What to actually say in an interview

If asked "what's a DaemonSet?":

> DaemonSet is the "one Pod per node" primitive. You don't specify replicas — the controller derives the count from the number of matching nodes. When a new node joins the cluster, a Pod is added automatically; when a node leaves, the Pod is garbage-collected. It's for per-node workloads — log collectors reading `/var/log/containers`, node-level metrics agents, CNI plugins, CSI drivers, security agents. Anything that needs `hostPath` or `hostNetwork` to be useful is probably a DaemonSet.

If asked about the difference between DaemonSet and Deployment:

> Deployment scales by request volume — N interchangeable Pods anywhere. DaemonSet scales by node count — one Pod per matching node. If a new node joins, DaemonSet adds a Pod there; Deployment does nothing until you change replica count. The workloads are also different: Deployments run app code; DaemonSets typically need node-level access (hostPath, hostNetwork, privileged containers) to do their job.

If asked about tolerations:

> Control-plane nodes have taints that keep normal Pods off them. A DaemonSet that needs to also cover control-plane nodes — like kube-proxy — has to tolerate the taint. Otherwise it silently skips those nodes. Same for GPU nodes or any node with a specific taint. The pattern for a "must run everywhere" DaemonSet is a broad toleration for `NoSchedule` and `NoExecute` effects with no key/value — tolerates everything. That's rarely what you want; usually you tolerate specific taints.

If asked about update strategy:

> Default is RollingUpdate with maxUnavailable: 1 — replaces Pods node by node. That's safe for most DaemonSets, but not great for critical ones like CNI where "one node without networking" isn't cheap. Since 1.22 you can add maxSurge: 1 so a new Pod comes up before the old dies. For genuinely risky upgrades — storage drivers, security agents — use OnDelete strategy: nothing happens until you manually delete a Pod. You control the pace and verify between nodes.

Say the words: **one Pod per node**, **implicit replica count**, **hostPath / hostNetwork**, **taints and tolerations**, **RollingUpdate with maxUnavailable / maxSurge or OnDelete for risky upgrades**.
