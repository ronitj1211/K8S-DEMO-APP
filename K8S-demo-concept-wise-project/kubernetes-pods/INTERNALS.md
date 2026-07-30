# Pods — Internals

How Pods actually work under the hood: the pause container, namespace sharing, volume plumbing, log flow through the kubelet.

---

## Purpose of a Pod (in one paragraph)

The Pod is Kubernetes' **unit of scheduling and networking**. Everything the scheduler places, everything the network model assigns an IP to, everything the kubelet manages — it's Pods, not containers. Containers are how you package software; Pods are how Kubernetes runs it. A Pod is a wrapper that groups tightly-coupled containers, gives them a shared network stack, and lets them share storage — so a helper container (log shipper, proxy, migration runner) can co-exist with the main app as if they were processes on the same VM.

## The pause container — the container you never wrote

Every Pod has a hidden extra container: the **pause container** (also called the "infra container" or "sandbox container"). Kubelet starts it first, and it's the container that actually owns the Pod's network namespace, IPC namespace, and (usually) PID namespace.

Why? Because if the main app container dies and restarts, the network namespace has to survive — otherwise every restart would change the Pod's IP. Solution: park the namespaces in a container that does nothing, and reference it from every other container in the Pod.

You can see it:

```bash
kubectl exec -it <pod> -- ps aux    # from the app's PID namespace, you don't see pause
```

On the node itself:

```bash
crictl pods --name my-pod
crictl inspectp <pod-sandbox-id>
```

The `pause` image is tiny (~500 KB). It loops on `pause(2)` syscall forever. That's it. Its only job is to hold the namespaces open.

## How multi-container Pods communicate

Containers in the same Pod share resources via Linux namespaces. Which ones are shared is controlled by the Pod spec:

| Namespace | Shared by default? | Field to change |
|---|---|---|
| Network | **Yes** | (always shared) |
| IPC | **Yes** | (always shared) |
| UTS (hostname) | **Yes** | (always shared) |
| PID | No | `spec.shareProcessNamespace: true` |
| Mount | No — each container has its own | (per-container `volumeMounts` reveal shared *volumes*) |
| User | No — each container has its own | (rarely tuned) |

### Communication via localhost

Because the network namespace is shared, all containers see the same set of network interfaces including the same loopback (`lo`).

Container A binds to `0.0.0.0:8080`. Container B in the same Pod reaches it at `localhost:8080` (or `127.0.0.1:8080`). Same as processes on one machine.

Practical implication: **two containers in the same Pod can't both listen on the same port.** Port 8080 is one port in one network namespace. First one wins, second gets `EADDRINUSE`.

### Communication via IPC

System V semaphores, POSIX message queues, shared memory segments — all work across containers in the same Pod because IPC namespace is shared. Rare in modern apps but underlies things like Postgres shared_buffers if you ever run Postgres containers side-by-side.

### Communication via shared volumes

Volumes are declared at the Pod level. Containers can mount them into their own filesystem view.

```yaml
spec:
  volumes:
    - name: work
      emptyDir: {}
  containers:
    - name: producer
      volumeMounts:
        - { name: work, mountPath: /out }
    - name: consumer
      volumeMounts:
        - { name: work, mountPath: /in }
```

`producer` writes to `/out/foo.log`; `consumer` reads from `/in/foo.log`. Same file on disk. Volumes bridge the otherwise-separate mount namespaces of the two containers.

### Communication via shared PID namespace

If you set `spec.shareProcessNamespace: true`, all containers see each other's processes. Container A can `ps aux` and see container B's process. Container A can `kill -9 <b's pid>`. Rarely needed, but useful for debugging sidecars.

## Volumes — where "shared storage" actually lives

Volumes come in many flavors. Each is realized differently on the node:

| Volume type | Where it lives on the node |
|---|---|
| `emptyDir` | `/var/lib/kubelet/pods/<uid>/volumes/kubernetes.io~empty-dir/<name>` — a plain directory. Deleted when the Pod dies. |
| `emptyDir` with `medium: Memory` | tmpfs mount — RAM-backed. Fast but counts against Pod memory limits. |
| `configMap` / `secret` | `/var/lib/kubelet/pods/<uid>/volumes/kubernetes.io~configmap/<name>` — kubelet syncs from API. Uses symlinks for atomic updates. |
| `hostPath` | Literally a bind mount from a node directory. Same path on the node = same directory in the container. Node-local, breaks Pod portability. |
| PersistentVolumeClaim | Depends on the CSI driver. On EBS: EBS volume attached to the node, formatted, and bind-mounted into the container. |
| `projected` | A composite of multiple sources merged into one mount. Used by service-account tokens. |

Each container in the Pod picks which volumes it wants to mount and where. Two containers can mount the same volume at different paths.

## Where the Pod's containers actually run

On a node running containerd (most modern K8s):

- **Container root filesystem**: overlayed union filesystem, based on the container image layers, at `/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/`.
- **Pod-level state**: `/var/lib/kubelet/pods/<pod-uid>/` — includes `volumes/`, `plugins/`, `etc-hosts`, and container-specific dirs.
- **Container process**: a runc-created process, in the namespaces the pause container established.

You can inspect a Pod's on-node state:

```bash
kubectl debug node/<node> -it --image=busybox
chroot /host
ls /var/lib/kubelet/pods/<pod-uid>/
```

## Log flow — from stdout to /var/log/containers

This is the flow you'll debug most:

**Step 1: The container writes to stdout / stderr.**

Your app just does `console.log(...)`. In C, `write(1, ...)`. Nothing K8s-specific.

**Step 2: The container runtime captures it.**

containerd (or CRI-O, or Docker via cri-dockerd) redirects the container's stdout/stderr to a file managed by the runtime. Path (containerd default):

```
/var/log/pods/<namespace>_<pod-name>_<pod-uid>/<container-name>/<restart-count>.log
```

Each line is wrapped in a runtime-specific format. For containerd (CRI format):

```
2026-07-30T14:15:22.123456Z stdout F {"level":"info","msg":"handled request"}
```

For Docker JSON logs:

```json
{"log":"handled request\n","stream":"stdout","time":"2026-07-30T14:15:22.123456Z"}
```

Fluent Bit's `multiline.parser docker, cri` handles both.

**Step 3: The kubelet creates a symlink for discoverability.**

Kubelet creates `/var/log/containers/<pod-name>_<namespace>_<container-name>-<container-id>.log` as a symlink to the file in `/var/log/pods/`.

```bash
ls -la /var/log/containers/
# lrwxrwxrwx  ...  backend-pod_default_backend-abc123.log -> /var/log/pods/default_backend-pod_uid/backend/0.log
```

The `/var/log/containers/*.log` layout is what tooling (Fluent Bit, Filebeat, promtail) expects. The filename encodes pod/namespace/container so log shippers know what to enrich each line with.

**Step 4: Log rotation.**

Kubelet rotates the log file when it exceeds `containerLogMaxSize` (default 10 MB). Older files are named `<n>.log.<timestamp>.gz`. Kubelet keeps up to `containerLogMaxFiles` (default 5) rotated files per container.

**Step 5: `kubectl logs` reads the file.**

When you run `kubectl logs pod-x`, the API server proxies to the kubelet, which reads and returns the file's content. `--previous` reads the log from the *previous* container instance (`<restart-count-1>.log`).

**Step 6: Node-level log shipper (Fluent Bit / Filebeat / Vector).**

A DaemonSet on each node tails `/var/log/containers/*.log`, parses the runtime wrapper, enriches with K8s metadata (by calling the API for the Pod), and ships to Elasticsearch / Loki / CloudWatch.

The whole flow, once more, compactly:

```
Container process (stdout/stderr)
      │
      ▼
Container runtime (containerd)
      │  writes to
      ▼
/var/log/pods/<ns>_<pod>_<uid>/<container>/<restart>.log
      │
      │  kubelet symlinks
      ▼
/var/log/containers/<pod>_<ns>_<container>-<id>.log
      │
      ├── kubectl logs (reads via kubelet API)
      │
      └── Fluent Bit DaemonSet (tails, ships)
                │
                ▼
          Elasticsearch / Loki / etc.
```

If the app writes logs to a **file inside the container** instead of stdout, kubelet doesn't see them. Options:
1. Change the app to log to stdout (12-factor).
2. Add a sidecar container that tails the file and prints to its own stdout — kubelet catches that.
3. Mount an `emptyDir` volume shared between the app and a Fluent Bit sidecar.

## Static Pods

Not managed by the API server — managed directly by the kubelet on the node. Kubelet watches `/etc/kubernetes/manifests/` (default) and runs whatever YAML is there.

Used for **the control plane itself**: kube-apiserver, kube-controller-manager, kube-scheduler, etcd on managed-cluster control-plane nodes are all static Pods. That's how they start before the API server exists to schedule them.

You rarely write static Pods yourself. If you're on a self-managed cluster and need one, drop the YAML in the manifests dir; kubelet picks it up.

## Pod lifecycle — the state machine

```
Pending
  └── (scheduler assigns node)
  └── (kubelet pulls image, creates namespaces)
  └── (initContainers run in order, must complete)
  └── (main containers start; readiness probe passes)
       │
       ▼
Running
  │
  │  container may die, kubelet restarts it (per restartPolicy)
  │  probes may fail; readiness -> exclude from Service Endpoints
  │
  ├── (all containers terminate with success) → Succeeded
  ├── (a container exits non-zero with restartPolicy=Never) → Failed
  └── (node lost / kubelet not heartbeating) → Unknown
```

## Init containers vs sidecars (K8s 1.29+)

Both live in `spec.initContainers` array but sidecars have `restartPolicy: Always`:

```yaml
initContainers:
  # regular init — runs to completion before main containers start
  - name: migrate
    image: my-migrator
    command: ["./migrate.sh"]

  # sidecar init (K8s 1.29+)
  - name: log-shipper
    image: fluent/fluent-bit
    restartPolicy: Always              # this makes it a sidecar
    volumeMounts:
      - { name: work, mountPath: /var/log/app }
```

The sidecar starts before main containers (guaranteed running when main starts), keeps running for the Pod's lifetime, and terminates *after* main containers stop.

Pre-1.29 sidecars were just extra containers in `spec.containers` — worked but with subtler ordering guarantees.

---

## The 30-second summary

- A Pod holds a group of containers that share network, IPC, and (optionally) PID + storage.
- A hidden **pause container** owns the shared namespaces so they survive individual container restarts.
- Containers talk to each other via `localhost` (same net namespace), shared volumes (same or different mount paths), or IPC.
- Logs flow from the container's stdout → container runtime → `/var/log/pods/*.log` → symlink at `/var/log/containers/*.log` → kubelet or DaemonSet log shipper.
- kubelet rotates log files at 10 MB by default; `kubectl logs --previous` reads the pre-restart file.
- Static Pods are managed by the kubelet directly, not the API server — used for control-plane bootstrap.
