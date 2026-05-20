# Interview Questions — Services

---

## Basic

### Q1. What is a Service?
A stable network endpoint (virtual IP + DNS name) for a set of Pods. Pods come and go with different IPs; the Service stays. It also load-balances across all matching, healthy Pods.

### Q2. What's the difference between ClusterIP, NodePort, LoadBalancer, ExternalName, Headless?
- **ClusterIP** (default) — reachable only inside the cluster.
- **NodePort** — opens a port (30000–32767) on every node's IP. Reachable from outside.
- **LoadBalancer** — asks the cloud provider for an external LB. Builds on NodePort + ClusterIP.
- **ExternalName** — DNS CNAME to an external host. No proxying.
- **Headless** (`clusterIP: None`) — no virtual IP; DNS returns Pod IPs directly. Used by StatefulSets and custom client-side LB.

### Q3. How does a Service know which Pods to send traffic to?
By the `selector` field — it matches **labels** on Pods. The endpoints controller watches Pods that match and maintains an `Endpoints` (or `EndpointSlice`) object listing their IPs and ports.

### Q4. What's `port`, `targetPort`, and `nodePort`?
- `port` — the Service's port (what clients hit inside the cluster).
- `targetPort` — the container's port (where traffic is sent inside the Pod).
- `nodePort` — only for NodePort/LoadBalancer; the static port exposed on every node (30000–32767).

### Q5. How do Pods reach a Service by name?
Through cluster DNS (CoreDNS). The format is `<service>.<namespace>.svc.cluster.local`, with shorter aliases in the same namespace (`<service>` or `<service>.<namespace>`).

### Q6. What is `Endpoints` (or `EndpointSlice`)?
The list of backend Pod IP+port pairs a Service routes to. You can `kubectl get endpoints <svc>` and see the Pod IPs. EndpointSlices (newer) split the list into chunks of 100 — needed for Services with thousands of backends. The Service is the *intent*; Endpoints is the *current resolution*.

### Q7. What is kube-proxy?
A node-level agent that programs the data plane (iptables / IPVS / nftables / userspace) so that traffic destined for a Service's ClusterIP is DNATed to one of the backend Pod IPs. It watches the API for Service / Endpoints changes.

---

## Intermediate

### Q8. How is load balancing actually done?
By default, kube-proxy in **iptables** mode programs random-load-balanced DNAT rules. In **IPVS** mode (better for huge clusters), it uses an in-kernel load balancer with more algorithms (round-robin, least-conn, source-hash). It's L4 (TCP/UDP) — no L7 (HTTP) awareness.

### Q9. What's `externalTrafficPolicy: Local` vs `Cluster`?
For NodePort/LoadBalancer:
- **Cluster** (default) — traffic that arrives at any node can be SNATed and forwarded to a Pod on any other node. Even distribution; client source IP is lost.
- **Local** — only nodes that actually have a backend Pod accept the traffic. Source IP is preserved. Uneven across nodes (some get 0 traffic). Used when you need real client IPs in logs.

### Q10. What's a headless Service good for?
`clusterIP: None` returns Pod IPs in DNS directly, with one A record per Pod. Two use cases:
- **StatefulSets** — each Pod gets a stable per-Pod DNS name `pod-0.svc.ns.svc.cluster.local`. Lets a client pick a specific replica (primary/secondary, shards).
- **Client-side load balancing** — clients (gRPC, custom) want to see all backend IPs and balance themselves.

### Q11. What's the difference between Service and Ingress?
- **Service** — L4 (TCP/UDP). One Service per app. Exposes the Pods.
- **Ingress** — L7 (HTTP/HTTPS). One Ingress can route many hostnames and paths to many Services. Needs an Ingress controller (ingress-nginx, Traefik, AWS ALB controller).

### Q12. What is `session affinity`?
`sessionAffinity: ClientIP` — kube-proxy sends repeat requests from the same client IP to the same Pod (until timeout). Crude — survives nothing fancier than IP-level stickiness. For real session stickiness use an Ingress with cookie-based affinity or a service mesh.

### Q13. What happens when a Pod fails its readiness probe?
The endpoints controller removes its IP from the Service's Endpoints / EndpointSlice. kube-proxy reprograms iptables/IPVS. Within a few seconds, the Service stops sending traffic there. Liveness failures *don't* directly affect Service membership — only readiness does.

### Q14. Can multiple Services target the same Pod?
Yes. Pods can match multiple selectors. Common: one ClusterIP Service for app-to-app traffic and another headless Service for metrics or per-Pod addressability.

### Q15. What's the `EndpointSlice` mirroring rule when migrating from Endpoints?
Each Service has *both* an `Endpoints` and one or more `EndpointSlice` objects (auto-mirrored). kube-proxy in modern K8s prefers EndpointSlice. The old Endpoints object is still maintained for backward compatibility — but is capped at 1000 entries (EndpointSlices have no such cap because they shard).

---

## Scenario-based

### S1. A Service exists, but `curl <svc>` from a Pod returns "connection refused". How do you debug?
1. **Endpoints**: `kubectl get endpoints <svc>`. Empty → no Pod matches the selector OR no Pod is ready. Compare `Service.spec.selector` with the Pod's labels (`kubectl get pods --show-labels`).
2. **Readiness probe**: `kubectl describe pod <p>` — failing probe means the Pod is excluded.
3. **Ports**: Service `targetPort` must match the container's listening port.
4. **DNS**: `kubectl exec -it <pod> -- nslookup <svc>`. NXDOMAIN → namespace typo or wrong cluster DNS.
5. **NetworkPolicy**: a deny-all on the destination namespace will block even valid Services.

### S2. LoadBalancer Service stays at `EXTERNAL-IP: <pending>` forever.
Possible causes:
- Cluster has no cloud LoadBalancer provider (kind / minikube / vanilla on-prem). Use `minikube tunnel`, `kind` LB extras, or `kubectl port-forward`. On k3s, klipper-lb provisions an IP from the host network.
- Quota exhausted on the cloud account.
- The cloud-controller-manager is down or misconfigured (e.g., missing IAM permissions on AWS).

`kubectl describe svc <svc>` events usually pinpoint it.

### S3. You need to give a stable DNS name to an external database hosted at `db.example.com`.
Use an `ExternalName` Service:
```yaml
apiVersion: v1
kind: Service
metadata: { name: db }
spec:
  type: ExternalName
  externalName: db.example.com
```
Now Pods can connect to `db.default.svc.cluster.local` and it CNAMEs to `db.example.com`. Great for keeping `DATABASE_HOST=db` in your config across environments — only the Service definition changes.

### S4. Traffic to one Pod is unbalanced — 80% of requests hit one of three Pods.
Likely causes:
- **Connection reuse**: kube-proxy load-balances *per connection*, not per request. HTTP keep-alive + small connection pool from the caller means few connections → uneven distribution. Force more connections, or use a service mesh / proper L7 LB.
- **`externalTrafficPolicy: Local`** with Pods unevenly placed across nodes (some nodes get 100% of arrived traffic).
- **Long-lived gRPC streams** — same problem, worse. Solution: client-side LB or headless Service.

### S5. You need cross-namespace access. Does it work?
Yes. From a Pod in `ns-a`, you can reach a Service in `ns-b` by full DNS:
```
<service>.ns-b.svc.cluster.local
```
The short form (`<service>` alone) resolves *only in the current namespace*. NetworkPolicies, if present, are the actual gate — DNS resolution is independent from network reachability.

### S6. NodePort exposes a port but the cloud security group blocks it.
NodePort doesn't open the firewall on the underlying nodes. On managed clusters (EKS / GKE), you have to open the security group / firewall rule for ports 30000–32767 (or for the specific nodePort). This is why LoadBalancer / Ingress are preferred in production — they integrate with the cloud's network plumbing.
