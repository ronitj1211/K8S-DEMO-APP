# Services — Deep Dive for Interviews

The narrative version. Why Services exist, what problem they actually solve, and how to talk about them like you've debugged real ones.

---

## The origin story

Pods have IPs. Pods die. When a Pod dies, its IP goes with it — the replacement Pod has a new IP. So if one app hardcoded another app's Pod IP, everything breaks the moment either app restarts. Every microservice ecosystem needs stable addresses, and hardcoding IPs won't work.

Two solutions were possible:
1. **Every app implements its own service discovery** — polls the K8s API, watches Pod events, maintains its own address book. Ugly, everyone reimplements it, hard to secure.
2. **The platform provides stable addresses.** That's what Services are.

A Kubernetes Service is a **stable virtual IP + DNS name** that transparently load-balances across a set of Pods matching a label selector. Pods come and go; the Service stays. Clients hit `http://backend/` and never think about it.

The other quiet thing Services did: they decoupled workload identity from workload location. In pre-K8s days you'd say "deploy `backend` to server `web03`." Now you say "run a backend Deployment," "put a Service in front of it," and the Service handles all of the "where is it running" bookkeeping. That's a huge conceptual shift.

## The mental model

Think of a Service as a **rendezvous point with a load balancer built in**. It has:
- A stable identity (name + namespace + cluster DNS).
- A backing pool it maintains (via label selector → matching Pods → matching Endpoints).
- A distribution policy (round-robin over healthy backends).

Clients talk to the rendezvous point. The rendezvous point figures out who's actually there right now.

Different Service types (ClusterIP, NodePort, LoadBalancer, ExternalName, headless) are just different rendezvous *scopes* — where the address is reachable from, and how outside traffic gets in.

## How it actually works

The magic lives in **kube-proxy**, a component running on every node. When you create a Service:

1. **API server** stores the Service and its selector.
2. **Endpoints controller** watches Pods matching the selector; maintains an `Endpoints` (or `EndpointSlice` in newer versions) object listing Pod IPs and ports of Pods that are `Ready` (readiness probe passing).
3. **kube-proxy** watches the API for Service + Endpoints changes. On each change, it programs the node's data plane:
   - **iptables mode (default)** — writes DNAT rules: "traffic to `<ServiceIP>:<port>` gets rewritten to one of `<PodIP1>:<targetPort>`, `<PodIP2>:...`, etc., chosen randomly with equal weight." All in kernel.
   - **IPVS mode (large clusters)** — uses an in-kernel L4 load balancer. Better performance and more algorithms (round-robin, least-conn, source-hash).
   - **nftables mode (newer)** — modernizes iptables mode using nftables syntax.

**No proxy Pod exists.** The Service isn't running anywhere — it's a virtual IP that the kernel on each node knows how to forward. That's why Services are basically free (no CPU tax).

The DNS layer (CoreDNS) maps Service names to their ClusterIPs. From a Pod, `curl http://backend/` resolves via DNS, hits the Service ClusterIP, gets DNAT'd to a Pod IP, response comes back with reverse-NAT — client thinks it talked to `backend` the whole time.

### Service types, actually

- **ClusterIP** — the default. Virtual IP reachable only within the cluster. This is what 90% of Services are.
- **NodePort** — opens a static port on every node's IP, in the 30000–32767 range. Traffic to `<any-node-ip>:<nodePort>` gets forwarded to a Pod. External access without a load balancer, for dev/demo or behind a manual LB.
- **LoadBalancer** — asks the cloud provider (or ServiceLB on-prem/k3s) to provision an external load balancer. Layers on top of NodePort — cloud LB → NodePort → Pod.
- **ExternalName** — no proxying. Just a CNAME record in cluster DNS pointing to an external hostname. Used to give a stable K8s name to external services (RDS, third-party APIs).
- **Headless** (`clusterIP: None`) — no VIP, no kube-proxy involvement. DNS returns all Pod IPs directly. Used for StatefulSets and clients that want to implement their own load balancing (gRPC, custom sharding).

## When to use it (and when not to)

Every workload that needs to be reachable by anything else — internal or external — sits behind a Service. So the question is which type:

- **App-to-app inside the cluster** → **ClusterIP**. Always.
- **External access, one service, quick demo** → **NodePort**. Cheap, direct.
- **Production external HTTP(S)** → don't use LoadBalancer per service. Use **Ingress** (or Gateway API), with one shared LB in front. LoadBalancer per service = LB bill per service.
- **Production external TCP/UDP** → **LoadBalancer** (NLB on AWS). Ingress is HTTP only.
- **StatefulSet where clients need to hit specific Pods by name** → **Headless**. Gives per-Pod DNS.
- **Alias an external hostname** → **ExternalName**. Say `db` in code; point it wherever per environment.

## Common misunderstandings

**"Services proxy traffic."** They don't — kube-proxy programs kernel-level DNAT rules on each node. There's no user-space proxy. The Service is a rule, not a Pod. This confuses everyone new to K8s.

**"NodePort exposes the container port on the node."** No — NodePort opens an *arbitrary port in the 30000-32767 range*, and traffic to that port routes via iptables to the container's port. The container port doesn't change.

**"LoadBalancer gives you a cloud LB per Service in K8s."** Yes, and that's the problem. Every LoadBalancer Service = one cloud LB = separate bill. Ingress consolidates.

**"Service load balancing is per-request."** It's per-**connection**. HTTP keep-alive means one client can send many requests over one TCP connection, all landing on the same backend Pod. That's why "unbalanced traffic" in the wild is often a client-side connection reuse problem, not a Service problem. Fix: use gRPC with a proper client-side LB, or force short-lived connections, or use a service mesh with L7 balancing.

**"Endpoints and EndpointSlices are the same."** Endpoints is the older, single object per Service, capped at ~1000 entries. EndpointSlices split into chunks of 100 to scale beyond that. Modern kube-proxy prefers EndpointSlices. Both are auto-maintained.

**"A Service load-balances across all matching Pods."** Only *healthy* ones — Pods whose readiness probe is passing. If readiness is broken, dead Pods stay in Endpoints and the Service keeps routing to them. That's a common cause of intermittent 5xx.

## The war stories

**"Traffic isn't hitting our new Pod."** Endpoints was empty — the Pod's readiness probe was failing. Once the probe passed, Endpoints populated, kube-proxy reprogrammed iptables (within seconds), and traffic flowed. Debug path: `kubectl get endpoints <svc>` first, always.

**"NodePort works from one node's IP but not another's."** Turns out `externalTrafficPolicy: Local` was set — traffic only accepted on nodes that host a matching Pod. On a 5-node cluster with 2 Pods, 3 nodes drop the traffic. Fix: use `Cluster` policy (default), or accept that only some nodes will accept traffic and configure your LB to only route to those (some cloud LBs do this via health checks).

**"Client IP is `10.42.0.1` in our logs — we can't tell who's calling us."** kube-proxy SNATed the source. With `externalTrafficPolicy: Cluster`, traffic gets forwarded with the node's IP as source. Fix: `Local` policy preserves source IP, or use a proxy that sets `X-Forwarded-For` and trust it in the app.

**"Cross-namespace DNS doesn't resolve."** Same as intra-ns, but you have to use the fully-qualified name: `<service>.<namespace>.svc.cluster.local`, not just `<service>`. Same-namespace shortening only works when the caller and callee are in the same namespace.

**"After a rolling deploy, traffic spikes on old Pods for a moment."** Connection drain — old Pods still had established TCP connections. Terminate gracefully in the app on SIGTERM, and Service load balancing on new connections will naturally shift to new Pods.

**"Someone deleted the Service but the Pods are fine."** Correct — Services and Pods are independent objects. The Deployment keeps making Pods; there's just no rendezvous point for callers. Symptom: everyone hitting `http://backend/` gets DNS NXDOMAIN. Fix: re-create the Service.

## What to actually say in an interview

If asked "what's a Service?":

> A Service is a stable network endpoint for a set of Pods. It solves two problems: service discovery (Pods have ephemeral IPs, but the Service has a stable DNS name), and load balancing (traffic to the Service is distributed across matching healthy Pods). Under the hood, kube-proxy on every node programs iptables or IPVS rules so that traffic to the Service's virtual IP gets DNAT'd to a real Pod IP. There's no proxy Pod — it's kernel-level routing. Pods are chosen by label selector, and only Pods passing their readiness probe get traffic.

If asked "what Service types are there?":

> Five, and they nest. ClusterIP is the default — internal virtual IP. NodePort opens a port on every node in the 30k range for external access. LoadBalancer builds on NodePort by asking the cloud to provision an external load balancer. ExternalName is just a DNS CNAME — no proxying, useful for aliasing external hostnames as K8s services. Headless — `clusterIP: None` — skips the virtual IP entirely and returns Pod IPs directly in DNS, which StatefulSets use for per-Pod addressability.

If asked about Ingress vs LoadBalancer:

> Ingress is L7, Service LoadBalancer is L4. For HTTP APIs, you usually don't want a cloud LoadBalancer per service — that's one LB bill per service. Instead you use Ingress: one shared LoadBalancer in front, one Ingress controller doing HTTP routing based on host and path. Service LoadBalancer is right for non-HTTP protocols (databases exposed externally, gRPC-only where you need L4, etc.).

Say the words: **stable virtual IP**, **label selector**, **Endpoints/EndpointSlice**, **kube-proxy programs iptables**, **connection-level not request-level**, **readiness gate**. That's how the mechanism works.
