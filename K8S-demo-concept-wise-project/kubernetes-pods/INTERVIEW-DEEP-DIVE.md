# Pods — Deep Dive for Interviews

Narrative explanations you can actually say out loud. Not Q&A. This is the "sit down and tell me about Pods" version.

---

## The origin story

Before Kubernetes, people ran containers directly — `docker run`. That worked for one host, but the moment you needed helper processes (a log shipper, a proxy, a service-mesh sidecar), the primitive broke down. You'd either bake helpers into the same image (coupling everything into one big container) or run separate containers and hand-wire their networking. Neither scaled.

Kubernetes' answer: **the Pod**. A Pod is a small logical box containing one or more containers that share a network namespace, share storage volumes, and are scheduled together onto the same node with the same lifecycle. You don't ship "a container" to Kubernetes — you ship a Pod, which happens to contain a container (or several).

The name "Pod" comes from a **pod of whales** — a group traveling together. That's exactly what it is: a small group of processes that must live together to be useful.

## The mental model

Think of a Pod as a **lightweight virtual machine** where the "VM" is the Pod itself and the "processes" are the containers inside. That VM has one IP address; processes share `localhost`; they share mounted volumes; they start and stop together.

This mental model gets you 90% of the way. The other 10%: unlike a VM, a Pod is **ephemeral by design**. When a node dies, the Pod dies with it. If you want the Pod to come back, something else (a Deployment, a StatefulSet, a DaemonSet) has to be watching and recreating it. A "naked" Pod — one created directly without a controller — is a demo artifact, not a production pattern.

The other angle: a Pod is the **atomic unit of scheduling**. The scheduler places Pods, not containers. When you say "I need 3 replicas," you get 3 Pods, each with the same container(s). When resource requests say "give me 200m CPU," the requests are per-Pod, summed across containers.

## How it actually works

When you `kubectl apply -f pod.yaml`, this happens:

1. **API server** validates the manifest, writes it to etcd. State: `Pending`.
2. **Scheduler** watches for unscheduled Pods, picks a node that satisfies CPU/memory requests, node selectors, taints, tolerations, and affinity. Writes `spec.nodeName` back to etcd.
3. **Kubelet on that node** notices a new Pod destined for it. It creates the network namespace (via CNI plugin), pulls the images, starts the containers via the container runtime (containerd, CRI-O). Sets Pod IP.
4. **Kubelet reports back**: containers running, readiness probe passing → `Ready`. That's when Service endpoints start including this Pod.

Networking: every Pod gets **one IP** shared by all its containers. Container A can talk to container B via `localhost:port`. From outside the Pod, everyone hits `<PodIP>:<port>`. Kubernetes assumes a flat network — every Pod can reach every other Pod without NAT. The CNI plugin (Calico, Cilium, flannel, AWS VPC CNI, etc.) makes this happen.

Storage: volumes are declared on the Pod (not the container). Containers mount them via `volumeMounts`. When the Pod dies, an `emptyDir` volume dies with it; a `persistentVolumeClaim` volume survives (it's backed by external storage).

Lifecycle: kubelet runs `initContainers` first, in order, each to completion. Then it starts the main containers concurrently. Readiness probes gate Service traffic. Liveness probes trigger container restart when they fail. On Pod delete, kubelet sends SIGTERM to each container, waits `terminationGracePeriodSeconds` (default 30s), then SIGKILL.

## When to use raw Pods (and when not to)

**Basically never in production.** Naked Pods are for:
- Debugging (`kubectl run debug --rm -it --image=busybox`).
- Ad-hoc one-off tasks where you'll delete the Pod manually.
- Static Pods (managed directly by kubelet, used for control-plane components).

For anything that needs to survive a node death, you use a **controller**: Deployment for stateless apps, StatefulSet for stateful, DaemonSet for one-per-node, Job for run-to-completion.

The exception where Pod-level thinking still matters: you're **writing a controller** or a Helm chart. Then you're specifying the Pod template that the controller uses.

## Common misunderstandings

**"A Pod is a container."** No — a Pod is a wrapper around one or more containers plus the network and volume glue. The single-container Pod is common but is a *convention*, not a definition.

**"Pod IPs are stable."** They're not. When a Pod restarts (or gets replaced by its controller), it gets a fresh IP. Anything that needs a stable address uses a Service.

**"Sidecars are separate Pods."** No — sidecars are additional containers in the *same* Pod. That's the whole point: they share network, so an Envoy proxy sidecar can intercept traffic on `localhost` without any special config.

**"initContainers and sidecars are the same."** They're not. Init containers run once to completion before the main containers start. Sidecars run alongside the main container for the Pod's whole life. Since K8s 1.29, sidecars have their own field (`initContainers` with `restartPolicy: Always`) so they start before and stop after the main container — but they were always distinct from init containers in intent.

**"Pod = Deployment."** People conflate these because you usually create Pods through Deployments. But the Pod is the primitive; the Deployment is a controller that manages Pods. When someone deletes a Pod they created via Deployment, the Deployment creates a *new* Pod (different UID, different IP). They can look the same to the eye.

## The war stories

**"Our Pods keep getting evicted and we don't know why."** Node under memory pressure. Pods with no resource requests (`BestEffort` QoS class) are the first to go. Fix: set requests on everything, at least memory. The kubelet's eviction algorithm looks at QoS class first, then how far a Pod is over its request.

**"Our new deploy has 5xx errors for the first 20 seconds."** No readiness probe, or readiness probe is too lenient. The Pod starts, Service adds it to endpoints, requests come in, app isn't warmed up yet. Fix: set `readinessProbe` to a real check (not `/health` returning 200 on startup — an actual test that the app can serve traffic).

**"CrashLoopBackOff after we bumped the image."** Common causes: env var typo (app crashes on missing config), missing Secret or ConfigMap the Pod references (`kubectl describe pod` shows `CreateContainerConfigError`), OOMKilled (bumping the image bloated memory footprint past the limit), or the entrypoint changed.

**"Pod says Running but the app is broken."** `Running` just means "at least one container is running." Check readiness (`kubectl get pods` shows `READY 0/1`) and drill into the container's actual logs. `Running` is not the same as `Healthy`.

**"Deleting a Pod took 30 seconds."** That's the default `terminationGracePeriodSeconds`. On delete, kubelet sends SIGTERM, then waits 30s for the container to exit, then SIGKILL. If your app doesn't handle SIGTERM (graceful shutdown), or handles it and takes 45s to drain, you either need to raise the grace period or fix the app.

## What to actually say in an interview

If asked "what's a Pod?" — don't just say "smallest deployable unit." Say:

> A Pod is Kubernetes' scheduling primitive — one or more tightly-coupled containers that share a network namespace, storage volumes, and lifecycle, scheduled together onto one node. In practice, most Pods have one container; the multi-container pattern is for sidecars like log shippers, service-mesh proxies, or init containers that do migrations. The important property is that Pods are ephemeral — if you want self-healing, you wrap them in a controller like Deployment or StatefulSet. Naked Pods are only for debugging.

If asked how to debug a Pod:

> `kubectl describe pod` for events (image pull errors, scheduling failures, probe failures), `kubectl logs` with `--previous` for the crashed container's output, and `kubectl exec -it` to shell in if it's actually running. For a Pod stuck Pending, describe shows the reason — usually insufficient resources or unmatched selectors.

If asked about sidecars:

> The classic example is a log shipper — your app writes to stdout, and a Fluent Bit sidecar in the same Pod reads the shared volume and ships logs to Elasticsearch. Or a service-mesh sidecar like Envoy that intercepts all outbound traffic transparently. The reason sidecars work at all is the Pod's shared network — the sidecar can talk to the main container on localhost without config.

Interviewers listen for: "shared network + storage + lifecycle," "ephemeral," "scheduled together as one unit," "you don't run Pods directly, you wrap them in a controller." Say those things.
