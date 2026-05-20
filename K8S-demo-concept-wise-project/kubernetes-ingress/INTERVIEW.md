# Interview Questions — Ingress

---

## Basic

### Q1. What is an Ingress?
An L7 (HTTP/HTTPS) routing resource that exposes multiple Services behind a single externally-reachable endpoint, with rules based on **host** and **path**. Unlike a Service (L4), Ingress understands HTTP — virtual hosting, path rewrites, TLS termination, etc.

### Q2. What's an Ingress controller? Is it the same as Ingress?
No. The **Ingress resource** is just a declarative spec — by itself, applying it does nothing. The **Ingress controller** is the actual proxy (nginx, Traefik, HAProxy, AWS ALB) that watches Ingress resources and configures itself accordingly. You install one (or more) ingress controllers; you then create Ingress resources.

### Q3. Common Ingress controllers?
- **ingress-nginx** — community NGINX project. Most common.
- **Traefik** — flexible, modern; ships with k3s by default.
- **HAProxy Ingress** — high-performance, mature.
- **AWS Load Balancer Controller** — provisions ALB / NLB.
- **GKE Ingress** — provisions GCLB on Google Cloud.
- **Istio / Linkerd Gateway** — service-mesh ingress.

### Q4. Ingress vs LoadBalancer Service?
- **LoadBalancer Service** — L4, one external IP per Service. Cloud LBs cost money.
- **Ingress** — L7, one Ingress controller (often itself behind one LoadBalancer Service) routes to many Services. Much cheaper at scale and supports HTTP-aware features.

### Q5. What's `ingressClassName`?
Pins an Ingress resource to a specific controller. If you have multiple controllers (e.g., one public, one internal), `ingressClassName` decides which one handles this Ingress. Set on `Ingress.spec.ingressClassName`. The `IngressClass` resource defines the available classes.

### Q6. Path types?
- **`Exact`** — full path must match exactly.
- **`Prefix`** — path is a prefix of the request URL (`/foo` matches `/foo`, `/foo/`, `/foo/bar`).
- **`ImplementationSpecific`** — controller-specific (e.g., nginx-ingress regex with capture groups for rewrites).

### Q7. How does TLS work with Ingress?
A Secret of type `kubernetes.io/tls` holds `tls.crt` + `tls.key`. Reference it in `Ingress.spec.tls`:
```yaml
spec:
  tls:
    - hosts: [demo.example.com]
      secretName: demo-tls
```
The controller terminates TLS — backend Pods receive plain HTTP. Combined with **cert-manager**, certs can auto-renew from Let's Encrypt.

---

## Intermediate

### Q8. How does host-based routing work?
The Ingress rules match on the HTTP `Host:` header:
```yaml
rules:
  - host: api.example.com   -> backend api Service
  - host: app.example.com   -> backend app Service
```
One Ingress controller can serve many hostnames on the same IP/port — virtual hosting at the K8s layer.

### Q9. What's the `nginx.ingress.kubernetes.io/rewrite-target` annotation?
Tells ingress-nginx to rewrite the URL before forwarding. Common with path-prefix:
```yaml
metadata:
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /$2
spec:
  rules:
    - http:
        paths:
          - path: /api(/|$)(.*)
            pathType: ImplementationSpecific
            backend: { service: { name: backend, port: { number: 80 } } }
```
`/api/users` arrives at the backend as `/users`. Without this, the backend would need to be aware of the `/api` prefix.

### Q10. CORS-related question: how does Ingress remove the need for CORS?
With NodePort per service, frontend (`:30087`) and backend (`:30086`) are different origins → browser blocks. With Ingress, both sit behind one hostname (`demo.example.com/` for frontend, `demo.example.com/api` for backend) → same origin → no CORS needed. This is the headline win.

### Q11. What's a Gateway API and how does it differ from Ingress?
**Gateway API** is the newer K8s networking API designed to replace Ingress. Differences:
- **Role separation**: cluster ops define `Gateway`, app teams define `HTTPRoute` / `TCPRoute`. Ingress conflates both.
- **First-class L4 and L7**: native TCP/UDP/HTTP routing.
- **Better TLS / multi-cluster**.
- **Vendor-portable**: less reliance on controller-specific annotations.

Most production K8s shops are still on Ingress today, but Gateway API is the future.

### Q12. ingress-nginx baremetal vs cloud install?
- **Cloud** — Service type LoadBalancer; works on EKS/GKE/AKS where cloud LBs exist.
- **Baremetal** — Service type NodePort (with `externalTrafficPolicy: Local` for source IP preservation); use on bare metal, kind, k3s.

The actual nginx config and Ingress controller binary are identical.

### Q13. How do you preserve client source IP through Ingress?
- **ingress-nginx** with `externalTrafficPolicy: Local` on its Service.
- ALB / NLB on AWS: enable proxy protocol or X-Forwarded-For; ALB sets it by default.
- Apps should read `X-Forwarded-For` (or `X-Real-IP`) — `RemoteAddr` is the LB / nginx IP.

### Q14. What's `defaultBackend`?
The Service that handles requests not matching any Ingress rule (404 fallback). Useful for serving a custom 404 page or a maintenance message.

### Q15. Multiple Ingresses for the same host — what happens?
ingress-nginx merges them — paths from each are combined. If two rules collide on the same exact path, behavior is controller-defined (usually first-written wins, or `creationTimestamp` order). Best practice: one Ingress per host, or carefully partition paths.

### Q16. What's `nginx.ingress.kubernetes.io/canary` annotation?
Splits traffic between two Ingresses targeting the same host. The "canary" Ingress gets a percentage (`canary-weight`) or header-/cookie-based selection. Useful for progressive rollouts without a service mesh.

---

## Scenario-based

### S1. You applied an Ingress but `demo.example.com` doesn't resolve / returns connection refused.
Layers to check:
1. **DNS** — does `demo.example.com` resolve to the Ingress controller's external IP? `dig demo.example.com`.
2. **Ingress controller installed?** `kubectl get pods -n ingress-nginx`. If not, no controller is configuring nginx.
3. **`ingressClassName`** — does the Ingress have one, and does it match an existing `IngressClass`?
4. **Rules** — `kubectl describe ingress` shows resolved backends; "default backend" means no rule matched the host.
5. **Service / Pods backing the rule** — endpoints empty? Probe Pods first.

### S2. TLS certificate is expired and traffic now fails. How to set up auto-renewal?
Install **cert-manager**, define an Issuer (Let's Encrypt staging then prod), and annotate the Ingress:
```yaml
metadata:
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  tls:
    - hosts: [demo.example.com]
      secretName: demo-tls
```
cert-manager creates a `Certificate` resource, runs an HTTP-01 or DNS-01 challenge, writes the cert to `demo-tls`. Renews automatically ~30 days before expiry.

### S3. Frontend at `demo.example.com/` calls `/api/users` — but it returns 404 from the backend.
The `rewrite-target` annotation isn't stripping the `/api` prefix. Backend's router likely expects `/users`. Three fixes:
- **Strip in Ingress** — use the regex + rewrite-target pattern shown above.
- **Update backend** to mount its router under `/api`.
- **Use a path-prefix** the backend already serves on (`/api`) and skip rewrite.

### S4. Ingress with `host: demo.example.com` works, but `host: ""` (no host) catches all requests including unrelated ones.
A rule with no `host` is "wildcard" — matches any host. Almost never what you want; it leaks traffic between virtual hosts. Always set `host:` explicitly. If you genuinely need a catch-all, use a separate Ingress and review the controller's precedence rules.

### S5. ingress-nginx returns 502 Bad Gateway for one path.
Backend Pod is unhealthy or the Service has no endpoints. Walk through:
- `kubectl get endpoints <svc>` — empty means selector mismatch or readiness failures.
- `kubectl logs -n ingress-nginx <controller-pod>` — usually shows the backend it's hitting and the error.
- Wrong `port` on the Ingress backend (e.g., port 3000 vs 80 confusion).
- Slow Pod startup — increase `nginx.ingress.kubernetes.io/proxy-connect-timeout`.

### S6. Two teams' Ingresses conflict on the same hostname.
You can:
- **Multi-tenant Ingress controllers** — one per team, with separate `IngressClass`. Each team only writes Ingresses with their class.
- **Admission policy** (Kyverno / OPA) — block Ingresses outside the namespace's allowed host list.
- **Gateway API** — `Gateway` owned by the platform team grants `HTTPRoute` to specific namespaces explicitly. Cleaner separation.

### S7. You need to redirect `http://` → `https://`. How?
ingress-nginx does this automatically for TLS-enabled Ingresses (since 0.22) unless you opt out. To force explicitly:
```yaml
annotations:
  nginx.ingress.kubernetes.io/ssl-redirect: "true"
  nginx.ingress.kubernetes.io/force-ssl-redirect: "true"   # even without TLS in this Ingress
```
For non-nginx controllers, the equivalent is annotation- or CRD-specific.

### S8. Performance: ingress-nginx is saturating CPU.
- Scale up: HPA the controller Deployment (it's a Deployment, you can scale it horizontally).
- Tune nginx workers via the controller's ConfigMap (`worker-processes`, `worker-connections`).
- For huge throughput, switch controllers: HAProxy or AWS ALB / NLB scale better than nginx-ingress.
- Profile: is it TLS (offload to ALB), or buffering large bodies (`proxy-buffering`)? Logs and the nginx `/nginx_status` page tell you.
