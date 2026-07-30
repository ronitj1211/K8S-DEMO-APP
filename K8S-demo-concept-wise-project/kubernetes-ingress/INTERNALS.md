# Ingress — Internals

Ingress-nginx data plane, AWS Load Balancer Controller's ALB provisioning, Gateway API's shape.

---

## Purpose

Ingress is a K8s API that describes L7 (HTTP/HTTPS) routing: host/path rules to Services. It's just a **spec** — an actual data plane is provided by an **Ingress controller** (a Pod or a cloud-side integration) that watches Ingress resources and configures itself.

## The three architectural patterns

Different controllers implement Ingress fundamentally differently:

### Pattern 1: Nginx / Traefik / HAProxy — in-cluster reverse proxy

The controller runs as a Deployment. Its Pods are nginx/traefik/haproxy instances. A LoadBalancer Service in front of them exposes the proxy externally.

```
External LB (cloud LB or manual)
      │
      ▼
Ingress-Nginx Deployment (2+ replicas of nginx pods)
      │  reverse-proxies based on Host header + path
      ▼
Backend Services (ClusterIP) → Pods
```

**How config updates work**:
1. User applies Ingress YAML.
2. Ingress controller Pod watches Ingress + Service + Endpoints via K8s API.
3. Generates new `/etc/nginx/nginx.conf` from templates.
4. `nginx -s reload` or hot-swap. New nginx workers pick up the config; old ones drain in-flight connections.

**Data path**: traffic goes through the controller Pod. Controller is in the request path — a bottleneck at scale.

### Pattern 2: AWS Load Balancer Controller — cloud-managed L7

The controller runs in cluster but **does not proxy traffic**. Instead:

1. Watches Ingress resources with `ingressClassName: alb`.
2. Calls AWS ELBv2 APIs to create/update ALBs, target groups, listener rules, security group rules.
3. Registers Pod IPs (or NodePorts) as targets in the ALB target groups.

Traffic:
```
External client
   │
   ▼
AWS Application Load Balancer (managed by AWS, provisioned by controller)
   │  Routes via listener rules (host + path)
   ▼
Target Group → Pod IPs (in "ip" mode) or NodePorts ("instance" mode)
```

**Controller is NOT in the data path.** The ALB is the actual proxy — AWS managed, autoscaling, high-throughput.

### Pattern 3: GKE Ingress / other cloud-native — same as AWS pattern

GKE Ingress on Google Cloud provisions a Google Cloud Load Balancer. Similar shape.

## Ingress-nginx — deeper look at the config generation

Ingress-nginx templates a giant `nginx.conf` from watched resources.

For an Ingress like:
```yaml
spec:
  rules:
    - host: api.example.com
      http:
        paths:
          - path: /api
            pathType: Prefix
            backend:
              service:
                name: api-svc
                port: { number: 80 }
```

The generated nginx config has (roughly):

```nginx
server {
    listen 80;
    server_name api.example.com;

    location /api {
        proxy_pass http://upstream_default_api-svc_80;
        # ... plus about 50 lines of proxy_set_header, timeouts, buffering, ...
    }
}

upstream upstream_default_api-svc_80 {
    server 10.42.0.15:80;    # Pod IP from EndpointSlices
    server 10.42.0.16:80;
    server 10.42.0.17:80;
}
```

**Endpoint sync**: ingress-nginx uses a dynamic-endpoint feature — it doesn't reload nginx on every endpoint change. Instead, an internal Lua module updates upstream server lists in-place. Reduces the reload frequency.

**Full reload**: only on Ingress *rule* changes (new host, new path). Endpoint-only changes → in-place upstream update.

## AWS Load Balancer Controller — target modes

Two ways to register targets in the ALB target group:

**`instance` mode**:
- Targets are worker nodes' NodePorts.
- ALB → node:30080 → kube-proxy iptables DNAT → Pod.
- One extra hop (kube-proxy) in the data path.
- Traffic can cross nodes (client hits node A, kube-proxy sends to Pod on node B).

**`ip` mode**:
- Targets are Pod IPs directly. Requires VPC CNI (AWS's default on EKS).
- ALB → Pod IP directly. No kube-proxy involvement.
- More granular health checks (per-Pod).
- **Required for Fargate** (no worker nodes exist to host NodePorts).

Choose `ip` mode on EKS unless you have a specific reason not to. Faster, simpler.

## The reconcile loop (AWS controller specifics)

Ingress applied → controller sees it → assembles the desired ALB state:

1. **ALB creation**: `elbv2:CreateLoadBalancer` if none exists for this Ingress (or `group.name`).
2. **Target group creation**: one per (host, path, backend Service) — with health-check settings from annotations.
3. **Listener + rules**: one listener per `listen-ports` port; rules match host/path and forward to the right target group.
4. **Target registration**: for each target group, register the current set of Pod IPs (via K8s EndpointSlices).
5. **Security groups**: adjust SG rules so the ALB can reach node/Pod IPs on the right port.

On any Ingress or Endpoints change: recompute desired state, diff with actual AWS state, apply the delta.

## Sharing one ALB across many Ingresses

Adding one annotation:
```yaml
annotations:
  alb.ingress.kubernetes.io/group.name: my-app-group
```

Multiple Ingresses with the same `group.name` produce one ALB with rules combining all of them. Massive cost savings when you have many services — one ALB ($16/mo) instead of N.

Ordering: `group.order` annotation (integer) sets rule priority.

## `ingressClassName` — how routing to the right controller works

Multi-controller clusters are common (nginx for one team, alb for another).

```yaml
apiVersion: networking.k8s.io/v1
kind: IngressClass
metadata:
  name: nginx
spec:
  controller: k8s.io/ingress-nginx
```

Each Ingress specifies `spec.ingressClassName: nginx`. Controllers ignore Ingresses that don't match their class.

The IngressClass with `metadata.annotations.ingressclass.kubernetes.io/is-default-class: "true"` handles Ingresses without an explicit class.

## Path types

`pathType` in each rule:
- **Exact** — full path match. `/foo` matches `/foo` and nothing else.
- **Prefix** — path prefix on `/`-separated segments. `/foo` matches `/foo`, `/foo/`, `/foo/bar`. Doesn't match `/foobar`.
- **ImplementationSpecific** — up to the controller. Ingress-nginx allows regex + captures here.

Regex + rewrite (ingress-nginx only):
```yaml
annotations:
  nginx.ingress.kubernetes.io/rewrite-target: /$2
spec:
  rules:
    - http:
        paths:
          - path: /api(/|$)(.*)
            pathType: ImplementationSpecific
            backend:
              service: { name: api, port: { number: 80 } }
```

Request `/api/users` → matches, captures `$2=users` → rewritten to `/users` before sending to backend.

## TLS termination

```yaml
spec:
  tls:
    - hosts: [api.example.com]
      secretName: api-tls
```

Referenced Secret must be of type `kubernetes.io/tls`, containing `tls.crt` and `tls.key`. Controller reads it, configures TLS termination on the listener.

**cert-manager integration**: annotate the Ingress with `cert-manager.io/cluster-issuer: letsencrypt-prod`. cert-manager watches for these annotations, requests a cert from Let's Encrypt (using either HTTP-01 or DNS-01 challenge), writes it to the Secret, and rotates before expiry.

For AWS LBC: use ACM instead — set `alb.ingress.kubernetes.io/certificate-arn: <arn>`. ACM certs are free and auto-rotate.

## Gateway API — the successor

Ingress has known limitations:
- Every controller has its own annotations for features beyond basic routing.
- No first-class TCP/UDP routing.
- Awkward role separation — cluster admins and app teams write to the same object.

**Gateway API** three-tier model:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata: { name: eks-alb }
spec:
  controllerName: gateway.k8s.aws/alb
---
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: prod-gateway
spec:
  gatewayClassName: eks-alb
  listeners:
    - name: https
      port: 443
      protocol: HTTPS
      tls: { certificateRefs: [{ name: prod-tls }] }
      allowedRoutes:
        namespaces:
          from: Selector
          selector: { matchLabels: { env: prod } }
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-route
  namespace: prod
spec:
  parentRefs: [{ name: prod-gateway }]
  hostnames: [api.example.com]
  rules:
    - matches: [{ path: { type: PathPrefix, value: /api } }]
      backendRefs: [{ name: api, port: 80 }]
```

**Roles:**
- **GatewayClass** — cluster admin declares which controllers are available.
- **Gateway** — infra team declares listener, TLS, cross-ns access policy.
- **HTTPRoute** (/ TCPRoute / GRPCRoute / TLSRoute) — app team declares actual routing.

Cleaner separation, standard cross-controller features (no annotation zoo), first-class L4 support. Most enterprises are still on Ingress but Gateway API is the trajectory.

---

## The 30-second summary

- Ingress is a spec; a controller (Pod or cloud-side) provides the data plane.
- Ingress-nginx puts an nginx Pod in the traffic path; watches K8s API, templates nginx config, reloads on rule changes and updates upstreams dynamically on endpoint changes.
- AWS Load Balancer Controller is NOT in the traffic path — it provisions and configures real AWS ALBs.
- `instance` vs `ip` target modes (AWS LBC): ip mode is faster and required for Fargate.
- Share one ALB across many Ingresses via `alb.ingress.kubernetes.io/group.name` — massive cost saver.
- Path types: Exact, Prefix, ImplementationSpecific. Rewrites via annotations (nginx) or listener-rule annotations (ALB).
- TLS termination via `spec.tls[]` + a Secret; cert-manager (nginx) or ACM (ALB) automates cert lifecycle.
- Gateway API is the modern replacement — three-role separation (GatewayClass / Gateway / *Route).
