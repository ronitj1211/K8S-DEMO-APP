# Services — Internals

The machinery: EndpointSlices, kube-proxy modes, iptables/IPVS/nftables data plane, DNS resolution.

---

## Purpose of a Service

A Service is a **stable network endpoint for a moving set of Pods**. Pods have ephemeral IPs; the Service has a stable ClusterIP and DNS name. It also load-balances across Pods matching a selector. Both jobs — discovery and load balancing — happen without any user-space proxy running.

## The control plane side: Service → Endpoints → EndpointSlices

When you create a Service with a selector:

**1. API server stores the Service object.**

**2. Endpoints controller** (in kube-controller-manager) watches Services and Pods. On any change:
- For each Service with a selector, find matching Pods that are Ready.
- Write an `Endpoints` object with the same name as the Service, containing those Pod IPs + ports.

**3. EndpointSlice controller** (added later, more scalable) does the same but writes multiple `EndpointSlice` objects — each slice holds up to 100 endpoints, sharded for large Services.

Both are maintained for backward compatibility. Modern kube-proxy prefers EndpointSlices (better scale — a 10k-endpoint Service is 100 slices, each independently watched).

## The data plane: kube-proxy programs the node

**kube-proxy** runs as a DaemonSet on every node. It watches the API for Services + EndpointSlices, and programs the node's data plane so that traffic to Service IPs gets forwarded to Pod IPs.

There are three modes:

### iptables mode (default)

For every Service, kube-proxy creates iptables rules (in the `nat` table, `PREROUTING`, `OUTPUT`, `KUBE-SERVICES` chain):

```
KUBE-SERVICES chain
  -A KUBE-SERVICES -d 10.43.55.12/32 -p tcp --dport 80 -j KUBE-SVC-XXX

KUBE-SVC-XXX chain (per-Service)
  -A KUBE-SVC-XXX -m statistic --mode random --probability 0.333 -j KUBE-SEP-A
  -A KUBE-SVC-XXX -m statistic --mode random --probability 0.500 -j KUBE-SEP-B
  -A KUBE-SVC-XXX -j KUBE-SEP-C

KUBE-SEP-A chain (per-Endpoint)
  -A KUBE-SEP-A -j DNAT --to-destination 10.42.0.15:8080
```

**How it works:**
- Packet destined for `10.43.55.12:80` matches the KUBE-SERVICES rule.
- Jumps to KUBE-SVC-XXX which has probability-based DNAT rules for each backend.
- iptables picks one based on random probability weights.
- DNATs to Pod IP.

Load balancing is roughly uniform random per connection.

**Downsides:**
- iptables rules are evaluated linearly. Thousands of Services = thousands of rules. New rule installation gets slow (kube-proxy rewrites the whole ruleset atomically each time an EndpointSlice changes).
- Random per-connection means small connection counts land unevenly.

### IPVS mode

Uses IPVS (IP Virtual Server), an in-kernel L4 load balancer purpose-built for this.

- kube-proxy creates one virtual server per Service (Service IP + port).
- Adds real servers (Pod IPs) to each virtual server.
- Balance algorithm configurable: `rr` (round-robin), `lc` (least connections), `sh` (source-hash), `dh` (destination-hash).

**Benefits:**
- O(1) rule lookup regardless of Service count.
- Better performance at scale (thousands of Services).
- More algorithm choices.

**Enable:**
```yaml
# kube-proxy config
mode: ipvs
ipvs:
  scheduler: rr    # or lc, sh, dh
```

### nftables mode (newer, K8s 1.29+)

Same idea as iptables but using the nftables syntax. Better performance for very large rulesets. Being pushed as the eventual replacement for iptables mode.

## What happens at packet time — end to end

Pod A (10.42.0.20) wants to reach `backend` (Service).

**1. DNS resolves `backend.default.svc.cluster.local` → `10.43.55.12`**
(See [OPERATIONS-DEEP-DIVE.md](../OPERATIONS-DEEP-DIVE.md#part-6-service-discovery--how-it-actually-works))

**2. Pod A sends TCP SYN to 10.43.55.12:80**
Kernel netfilter hooks catch the packet in PREROUTING (before routing decision).

**3. iptables KUBE-SERVICES rule fires**
`--to-destination 10.42.0.15:8080` — DNATs the packet.

**4. Kernel now sees the destination as 10.42.0.15**
That's a Pod IP. Routes normally (either local via bridge, or via the CNI overlay/routing to another node).

**5. Backend Pod 10.42.0.15 receives the packet**
It sees `dst = 10.42.0.15`, `src = 10.42.0.20` (original Pod A). Responds.

**6. Return packet**
Response goes `10.42.0.15 → 10.42.0.20`. Reaches Pod A's node. Conntrack recognizes the connection and reverses NAT so the response appears to come from `10.43.55.12` (the Service IP the app called).

**Pod A never knew about the actual Pod IP.** It talked to the Service; kube-proxy handled the plumbing.

## Service types — what's different at the machinery level

### ClusterIP

Service IP allocated from the cluster's Service CIDR (e.g., `10.43.0.0/16`). Only routable inside the cluster because those IPs are only understood by kube-proxy on the nodes. Off-node clients don't have iptables rules for them.

### NodePort

Same as ClusterIP, plus an additional iptables rule on every node's `PREROUTING` chain that says "traffic to any node's IP on port 30080 → jump to KUBE-SVC-XXX for this Service." Now external clients hitting `<any-node-ip>:30080` get load-balanced.

**Important:** the traffic can hop between nodes. Client hits node A; kube-proxy DNATs to a Pod on node B; traffic goes A→B→Pod. SNAT is applied at node A so the return packet routes correctly. This is why `externalTrafficPolicy: Cluster` (default) hides the client's real IP.

`externalTrafficPolicy: Local` skips the SNAT — but then only nodes that actually host a matching Pod accept the traffic (others drop it). Preserves client IP, but you need an LB that health-checks the NodePort to avoid the "wrong node" case.

### LoadBalancer

Same as NodePort plus an external cloud LB configured by the cloud-controller-manager. The cloud LB routes external traffic to the nodes' NodePort. Under the hood it's still NodePort + iptables; the LoadBalancer type just automates provisioning the cloud LB.

On on-prem, `metallb` fills the same role — announces an IP via ARP or BGP for the LoadBalancer Service.

### Headless (`clusterIP: None`)

No virtual IP. No kube-proxy rules. DNS just returns the Pod IPs directly (one A record per Pod). Clients pick one and connect straight to the Pod.

Use case: StatefulSets need per-Pod addressability (`pod-0.svc.ns.svc.cluster.local`).

### ExternalName

Just a CNAME record in cluster DNS. Zero kube-proxy involvement. `curl foo.default.svc.cluster.local` inside a Pod → CoreDNS returns the external hostname → Pod does another DNS lookup for that.

## EndpointSlice — the modern model

Endpoints (single object per Service) was the original API. It didn't scale well past ~1000 endpoints because every update rewrote the whole object, and every kube-proxy on every node had to process it.

EndpointSlice shards into chunks of 100 endpoints. Each slice is its own object; a Service with 500 backends has 5 EndpointSlices. Update to one slice → only that one is watched-and-reprogrammed.

```bash
kubectl get endpointslices -l kubernetes.io/service-name=backend
```

```
NAME             ADDRESSTYPE   PORTS   ENDPOINTS
backend-abc123   IPv4          8080    10.42.0.10,10.42.0.11,10.42.0.12
```

The `AddressType: IPv4` — you can also have `IPv6` (dual-stack) or `FQDN` (rare, for special-purpose Services).

## Readiness gate

Only Pods with `condition Ready = True` show up in EndpointSlices. If readiness probe fails, endpoints controller removes the Pod's IP from the slice — kube-proxy reprograms — Service stops routing to it. Usually within a few seconds.

The other direction: a newly-Running Pod with a passing readiness probe gets added within seconds. The Service "self-heals" as its backing Pods come and go.

## Connection-level, not request-level

Kubernetes Services are **L4** (TCP/UDP). Load balancing happens at connection establishment.

For HTTP with keep-alive: one TCP connection carries many requests, all going to the same backend. If you have 5 clients with keep-alive and 3 backends, you'll see roughly uneven distribution (Poisson allocation of 5 into 3 bins).

For "true" request-level load balancing over HTTP, you need L7 — a service mesh (Istio, Linkerd, Cilium's L7) or a proper L7 LB (nginx-ingress, envoy).

## Debugging Service issues

```bash
# Is the Endpoints/EndpointSlice populated?
kubectl get endpoints <svc>
kubectl get endpointslices -l kubernetes.io/service-name=<svc>

# Compare Service selector to Pod labels
kubectl get svc <svc> -o jsonpath='{.spec.selector}'
kubectl get pods --show-labels

# Is kube-proxy healthy on each node?
kubectl get pods -n kube-system -l k8s-app=kube-proxy
kubectl logs -n kube-system <kube-proxy-pod>

# Is the ClusterIP even routable from inside a Pod?
kubectl run test --rm -it --image=busybox -- nslookup <svc>
kubectl run test --rm -it --image=busybox -- nc -zv <svc> 80

# Inspect iptables rules on a node (need node access)
sudo iptables-save | grep <svc>
```

If EndpointSlice is empty despite matching Pods existing: those Pods are not Ready. Readiness probes are the answer 90% of the time.

If EndpointSlice is populated but connections fail: kube-proxy problem, or a NetworkPolicy blocking, or the Pod is listening on the wrong port.

---

## The 30-second summary

- Service = stable virtual IP + DNS name; kube-proxy programs iptables/IPVS on every node to DNAT traffic to Pod IPs.
- EndpointSlices track which Pods are ready to receive traffic — updated by the endpoints controller when Pod readiness changes.
- Load balancing is **L4, per-connection**. Long-lived HTTP keep-alive can look uneven.
- ClusterIP works inside the cluster only; NodePort exposes on every node; LoadBalancer adds a cloud LB in front; Headless skips kube-proxy entirely for per-Pod DNS.
- No proxy Pod ever runs — it's all kernel-level netfilter rules. Services are effectively free.
