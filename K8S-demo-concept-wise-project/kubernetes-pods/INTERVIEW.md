# Interview Questions — Pods

Quick reference for interviews. Questions ranked by depth.

---

## Basic

### Q1. What is a Pod?
A Pod is the smallest deployable unit in Kubernetes. It wraps **one or more containers** that share the same network namespace (same IP, same `localhost`), shared storage volumes, and the same lifecycle (scheduled together to one node, started/stopped together).

### Q2. Why do we deploy Pods instead of containers directly?
Kubernetes manages scheduling, networking, and storage at the Pod level — not the container level. A Pod is a logical host that lets multiple tightly-coupled containers (app + sidecar) share an IP, volumes, and node, without you wiring it up manually. The container is the runtime unit; the Pod is the K8s API unit.

### Q3. Can a Pod have multiple containers? When would you?
Yes. The main container is your app; additional ones are **sidecars** that augment it. Common patterns:
- **Log shipper** (Fluent Bit) reading the app's logs from a shared volume.
- **Proxy / service mesh** (Envoy / Linkerd) intercepting traffic.
- **Adapter** translating the app's API to a different protocol.
- **Init containers** that run *before* the main containers (migrations, dependency checks).

### Q4. What's the difference between an init container and a sidecar?
Init containers run sequentially **before** the main containers, must complete successfully, and exit. Sidecars run **alongside** the main container for the Pod's lifetime. As of K8s 1.29, sidecars have their own field (`spec.initContainers` with `restartPolicy: Always`) so they start before and stop after the main container.

### Q5. What happens when a Pod's node dies?
Depends on what created the Pod:
- **Naked Pod** (created directly): gone. Not recreated.
- **Pod managed by a controller** (Deployment, ReplicaSet, StatefulSet, DaemonSet, Job): the controller creates a replacement on a healthy node.

This is why production never uses naked Pods.

### Q6. How do you reach a Pod from your laptop?
- `kubectl port-forward pod/<name> <local>:<podPort>` — quick and dirty.
- Put a Service in front of it for stable access (ClusterIP for in-cluster, NodePort/LoadBalancer/Ingress for outside).

### Q7. What are readiness and liveness probes?
- **Readiness probe** — "is this Pod ready to serve traffic?" If false, kube-proxy removes it from Service endpoints. Used during startup or temporary unhealthy states.
- **Liveness probe** — "is this container alive?" If false, kubelet restarts the container.

Probe types: `httpGet`, `tcpSocket`, `exec`. A common bug is reusing the same probe for both — use a cheap endpoint for liveness, a real check for readiness.

### Q8. What is a Pod's restart policy?
Set on `spec.restartPolicy`. Values: `Always` (default for Pods in Deployments), `OnFailure` (for Jobs), `Never`. Applies to **all containers** in the Pod. Note: this is about container restart within the Pod, not Pod-level recreation.

---

## Intermediate

### Q9. How do containers in the same Pod communicate?
Two ways:
1. **Network** — same IP and port space, so `localhost:<port>` works.
2. **Shared volume** — declare a volume in `spec.volumes` and mount it in each container's `volumeMounts`.

They can also see each other's process namespace if `shareProcessNamespace: true`.

### Q10. Explain the Pod lifecycle phases.
- **Pending** — accepted, waiting for scheduling or image pull.
- **Running** — bound to a node, at least one container running.
- **Succeeded** — all containers terminated with success (Jobs).
- **Failed** — at least one container exited non-zero and won't restart.
- **Unknown** — node lost contact.

Beyond `phase`, the `conditions` array has finer detail: `PodScheduled`, `Initialized`, `ContainersReady`, `Ready`.

### Q11. What's `imagePullPolicy: IfNotPresent` vs `Always`?
- `Always` — pull on every Pod start. Required for `:latest` tags to work as expected.
- `IfNotPresent` — use the local image if present (default for non-`:latest` tags).
- `Never` — never pull; require the image to be preloaded.

Pinning to a specific tag + `IfNotPresent` is the safest combo for reproducibility.

### Q12. What are resource requests and limits?
- **Requests** — guaranteed reservation. The scheduler uses requests to decide which node has room.
- **Limits** — hard ceiling. CPU > limit → throttled. Memory > limit → OOMKilled.

The ratio of requests/limits sets the **QoS class**: `Guaranteed` (equal, last evicted), `Burstable` (different), `BestEffort` (neither set, first evicted under pressure).

### Q13. What is a static Pod?
A Pod managed directly by the kubelet on a node — not by the API server. Defined in `/etc/kubernetes/manifests/*.yaml` on the node. The control plane (kube-apiserver, kube-controller-manager, kube-scheduler, etcd) typically run as static Pods on the control plane nodes. You rarely write them yourself.

### Q14. What's `hostNetwork`, `hostPort`, and `hostPath`? When are they appropriate?
- `hostNetwork: true` — Pod shares the node's network namespace. The Pod's port == the node's port.
- `hostPort` — exposes a container port on the node's IP without sharing the whole network namespace.
- `hostPath` — mounts a directory from the node's filesystem.

All three break the abstraction K8s gives you. Use them for **per-node infrastructure** (CNI plugins, log shippers, kube-proxy) — never for app workloads.

### Q15. What is a Pod Disruption Budget (PDB)?
A PDB sets a minimum number / percentage of Pods that must remain available during **voluntary disruptions** (node drains, cluster upgrades). It does not protect against involuntary disruptions (node failure, kernel panic). Example: `minAvailable: 2` on a 3-replica Deployment ensures rolling node drains don't take all 3 down.

---

## Scenario-based

### S1. A Pod is stuck in `Pending`. How do you debug?
Start with `kubectl describe pod <name>` and read the **Events** at the bottom:
- "FailedScheduling 0/3 nodes are available: insufficient cpu" → resource requests too large or no node has room. Reduce requests or add a node.
- "FailedScheduling node(s) didn't match Pod's node affinity/selector" → fix or remove the nodeSelector/affinity.
- "FailedScheduling node(s) had untolerated taint" → add a toleration or schedule elsewhere.
- No events → kubelet hasn't picked it up; check node health (`kubectl get nodes`).

If scheduled but stuck Pending, check `ImagePullBackOff` / `ErrImagePull` → image typo, private registry without imagePullSecret, or registry rate-limited.

### S2. A Pod keeps restarting. What do you check?
- `kubectl logs <pod> --previous` — logs from the crashed instance.
- `kubectl describe pod <pod>` — last termination state, exit code, restart count, OOMKilled flag.
- Common causes:
  - Liveness probe failing too aggressively → tune `failureThreshold`, `periodSeconds`.
  - App crashes on startup → check config (env vars, mounted Secret/ConfigMap missing).
  - OOMKilled → memory limit too low.
  - Missing dependency at startup → use an init container or a `wait-for-it` loop.

### S3. Your app needs to wait for a database to be ready before starting. How?
Use an **init container** that loops until the dependency is reachable:

```yaml
initContainers:
  - name: wait-for-db
    image: busybox:1.36
    command: ["sh", "-c", "until nc -z db 5432; do echo waiting; sleep 2; done"]
```

The main containers don't start until this init container exits 0. Cleaner than baking a wait loop into your app image.

### S4. You need to capture every container's stdout and ship it to S3. Pod-level or cluster-level?
Cluster-level — a **DaemonSet** of log shippers (Fluent Bit, Vector) reading `/var/log/containers/*.log` from each node's filesystem. Per-Pod sidecar log shippers are wasteful (one extra container per Pod) and don't capture containers that aren't in your control (system Pods). Sidecars are only the right answer when the app writes to a *file inside the container* that the kubelet doesn't see (rare).

### S5. A Pod has two containers; one is healthy, the other crashed. What's the Pod's status?
`Running` (the Pod has at least one container running) but **not** `Ready` (because `ContainersReady` condition is false). Service endpoints will exclude it. The crashing container will keep restarting per the restart policy. You'll see `READY 1/2` in `kubectl get pods` until both are up.
