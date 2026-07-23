# Ingress — Deep Dive for Interviews

The narrative on L7 routing in Kubernetes. What Ingress actually is (and isn't), the controller ecosystem, and how Gateway API changes the picture.

---

## The origin story

Services are L4 (TCP/UDP). Great for internal traffic — one Service per app, kube-proxy routes at kernel level. But for HTTP APIs exposed to the internet:

- **One LoadBalancer Service per API = one cloud LB per API.** That's ~$16/month × N services, plus admin overhead.
- **No path-based routing.** Service routes to Pods; it doesn't know that `/api/users` should go to one backend and `/api/orders` to another.
- **No host-based routing.** Can't share one Service between `api.example.com` and `admin.example.com`.
- **No TLS termination.** Each Service backend has to handle TLS itself.

The K8s answer was **Ingress**: an L7 routing resource that describes host + path rules for HTTP(S) traffic, backed by a controller (an Nginx / Traefik / ALB / HAProxy Pod or cloud LB) that actually implements the routing.

The critical thing: **Ingress is just a spec**. It doesn't do anything by itself. Applying an Ingress manifest to a cluster with no Ingress controller = a resource sitting there ignored. You need a controller Pod (or a cloud-side implementation) that watches Ingress resources and configures itself.

## The mental model

Ingress is a **declarative HTTP router**:
- Rules by host and path → send to Service X.
- TLS certificate references (usually a Secret).
- Annotations for controller-specific behavior (rewrites, timeouts, auth).

The controller is the **implementation**:
- Nginx-ingress runs Nginx in a Pod and generates its config from Ingress resources.
- Traefik does the same with Traefik.
- AWS Load Balancer Controller doesn't run a proxy — it provisions an actual ALB in AWS and configures listeners.
- GKE Ingress provisions a Google Cloud Load Balancer.

One Ingress controller can serve many Ingresses. That's the cost win — one cloud LB shared across dozens of apps, routed by host/path at L7.

## How it actually works

### Nginx-ingress style (in-cluster proxy)

1. Install controller (Helm chart deploys a Deployment + LoadBalancer Service).
2. External traffic hits the controller's cloud LB → NodePort → nginx-ingress Pod.
3. Nginx-ingress Pod watches the K8s API for Ingress resources.
4. On any Ingress change, controller rewrites `/etc/nginx/nginx.conf` and reloads Nginx.
5. Nginx handles the request — checks Host header, matches a rule, proxies to the target Service (using its ClusterIP).

The controller **is** the data plane. Traffic flows through it.

### AWS Load Balancer Controller style (cloud-native)

1. Install controller (Deployment in kube-system with IRSA IAM role).
2. Controller watches Ingress resources.
3. On Ingress with `ingressClassName: alb`, controller calls AWS APIs: create ALB, target group, listener rules, security group rules.
4. In `ip` target mode, controller keeps target groups synced with Pod IPs directly (skips kube-proxy).
5. External traffic hits the ALB → Pod IP.

The controller is **not** in the data path. It just keeps AWS in sync with K8s.

### Traefik / GKE / others

Variations on the same theme. Traefik has slick file-watch config; GKE Ingress translates to Google's L7 LB; HAProxy Ingress uses HAProxy as the proxy.

## When to use it (and when not to)

**Use Ingress:**
- Any HTTP/HTTPS workload exposed externally on shared infrastructure.
- Multi-tenant clusters where many apps share one LB.
- Anywhere TLS termination should be centralized.
- Path-based routing (`/api` → backend, `/` → frontend).

**Don't use Ingress:**
- **Non-HTTP protocols.** Ingress is HTTP-only. For raw TCP/UDP (databases, gRPC without HTTP/2 upgrade, custom protocols), use Service type LoadBalancer with NLB, or Gateway API's TCPRoute/UDPRoute.
- **Internal-only APIs** with no path/host routing needs. ClusterIP Service is simpler.
- **Very high throughput** where nginx-ingress becomes a bottleneck. Use cloud-native controllers (AWS LB Controller, GKE Ingress) that put the actual LB in the cloud, not in a Pod.

## Gateway API — the successor

Ingress has known limitations:
- Controller-specific annotations for anything beyond basic routing (each controller has different annotations).
- No first-class L4 support (TCP, UDP).
- Role separation is awkward — cluster admins and app teams both write into the same Ingress objects.

**Gateway API** (K8s SIG-Network, stable-ish) is the replacement. Three roles:
- **GatewayClass** — cluster admin declares "this class is implemented by nginx / envoy / etc."
- **Gateway** — infra team declares "this listener listens on :80 and :443 with TLS cert X, allowing routes from these namespaces."
- **HTTPRoute / TCPRoute / GRPCRoute** — app team declares actual routing rules, references a Gateway.

Cleaner separation, portable across controllers, first-class L4 support. Most production shops are still on Ingress in 2026 but Gateway API is the trajectory.

## Common misunderstandings

**"Ingress does routing."** It's a **spec** for routing. The controller does routing. No controller = nothing happens.

**"You need one Ingress per Service."** No — one Ingress can define many rules routing to many Services. In fact you often want that (one Ingress = one hostname = one TLS cert).

**"`ingressClassName: nginx` refers to a Docker image."** No — it refers to an `IngressClass` object in the cluster, which is created by the controller install. It's the routing target for Ingresses.

**"Ingress is L7 = it does everything L7."** It does host/path routing and TLS termination. That's L7 as defined in Ingress. It doesn't do JWT validation, rate limiting, or request transformation without controller-specific annotations. For those, use a service mesh (Istio) or dedicated API gateway (Kong, Apigee, Tyk).

**"TLS termination in the Ingress means backends don't need TLS."** Correct at the L7 boundary — client → LB is TLS, LB → Pod is HTTP. That's usually fine for internal traffic, but "TLS everywhere" (mTLS between services) requires a service mesh.

**"Ingress-nginx and nginx-ingress are the same."** They're two different projects with confusingly similar names. `kubernetes/ingress-nginx` (K8s community, ingress-nginx) vs `nginxinc/kubernetes-ingress` (NGINX Inc). Annotations are different. Most people use community `ingress-nginx`.

## The war stories

**"Applied Ingress, nothing happened."** Cluster had no Ingress controller installed. Ingress resource sat there ignored. `kubectl get ingressclass` returned empty — dead giveaway. Fix: install `ingress-nginx` or the AWS Load Balancer Controller (depending on target).

**"Ingress works locally in kind but fails on EKS."** Different controllers, different annotations. Local kind has ingress-nginx; EKS uses AWS Load Balancer Controller. Annotations don't transfer — `nginx.ingress.kubernetes.io/rewrite-target` means nothing to the AWS controller. Fix: parameterize the manifests per environment, or use Gateway API for portability.

**"Path rewriting was appending the path to itself."** Wrong regex in `nginx.ingress.kubernetes.io/rewrite-target`. `path: /api(/|$)(.*)` with `rewrite-target: /$2` strips `/api`. `/$1$2` doesn't. Test with `curl -v` and read the exact URL nginx-ingress logs.

**"Health check requests were 100% of our traffic."** The cloud LB's health check was hitting `/` at 1-second intervals across many nodes. Fix: set an explicit `alb.ingress.kubernetes.io/healthcheck-path` to a lightweight `/healthz`, and tune interval up.

**"After TLS cert renewal, requests started failing."** The Ingress referenced a Secret name that got recreated. Nginx cached the old cert until reload. Rolling restart of the ingress controller fixed it. For cert-manager users: it usually updates the Secret in place, but some configurations create a new one — check the Secret's name doesn't churn.

**"WebSocket connections drop after 60s."** ALB default idle timeout is 60s. Fix: `alb.ingress.kubernetes.io/load-balancer-attributes: idle_timeout.timeout_seconds=3600` (or whatever your app needs).

**"CORS suddenly broke after adding Ingress."** Frontend and backend used to be at different Services with different NodePorts (different origins) — you had `Access-Control-Allow-Origin` middleware. Behind Ingress they're at the same hostname (same origin), so CORS wasn't needed anymore. Someone tightened the CORS middleware to be strict, now the pre-flight from a *different* subdomain fails. Fix: allowlist the actual client origin correctly.

## What to actually say in an interview

If asked "what's an Ingress?":

> Ingress is an L7 HTTP router — you write rules by host and path, and traffic is routed to a Service. It's just a spec; the actual routing is done by an Ingress controller, which is a Pod (nginx, Traefik) or a cloud integration (AWS Load Balancer Controller). One controller can serve many Ingress resources, which is the big cost win — one shared cloud LB, dozens of apps behind it, HTTP-aware routing at L7. Compared to Service type LoadBalancer, Ingress consolidates: one LB, many services. Ingress is HTTP-only; for TCP or UDP you'd use Service type LoadBalancer with NLB, or Gateway API.

If asked about controllers:

> The most common are ingress-nginx (K8s community project, nginx-based) and Traefik. On managed clouds, native controllers are usually better: AWS Load Balancer Controller creates real ALBs in AWS; GKE Ingress creates Google Cloud LBs. The difference in data path: nginx-ingress puts a Pod in the traffic path (nginx running in a container, proxying); AWS LB Controller doesn't run any proxy — the ALB itself is the data plane, and the controller just keeps AWS in sync with K8s state.

If asked about TLS:

> Ingress terminates TLS. You reference a Secret of type `kubernetes.io/tls` containing `tls.crt` and `tls.key`. Combined with cert-manager for auto-renewal from Let's Encrypt, or with ACM certificates on AWS via the LB Controller's `certificate-arn` annotation, you get set-it-and-forget-it HTTPS. Backends receive HTTP inside the cluster. If you need TLS between services (mTLS), that's a service mesh's job, not Ingress.

If asked about Gateway API:

> Gateway API is Ingress's successor. Three-role separation: cluster admins declare GatewayClass and Gateway resources (listener + certs + which namespaces can route to it); app teams declare HTTPRoute / TCPRoute / GRPCRoute resources referencing the Gateway. Native L4 support, less reliance on controller-specific annotations, cleaner multi-tenant boundaries. Most orgs are still on Ingress but Gateway API is the direction things are moving — I'd bet on it for new setups.

Say the words: **L7 spec + controller implementation**, **one LB fronting many services**, **path and host routing**, **TLS termination**, **controller-specific annotations**, **HTTP only; use Service LoadBalancer for other protocols**, **Gateway API is the successor**.
