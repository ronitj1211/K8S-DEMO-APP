# Kubernetes Services — Hands-on Notes

Environment: **k3s (via Rancher Desktop / Colima)** on macOS
Node observed: `colima` — Internal IP `192.168.5.1`, k3s `v1.33.4+k3s1`

---

## 1. Goal of the exercise

Deploy a simple **frontend + backend** app on Kubernetes and understand how the
different Kubernetes **Service types** (`ClusterIP`, `NodePort`, `LoadBalancer`)
control *who* can reach *what*, and why a browser-based frontend can't talk to
a `ClusterIP` service directly.

---

## 2. Initial setup

### Images built

```bash
# Backend (Node.js app, listens on port 3000 inside the container)
cd backend
docker build -t k8s-demo-backend:1.0 .

# Frontend (static HTML served by Nginx, container listens on port 80)
cd ../frontend
docker build -t k8s-demo-frontend:1.0 .
```

### Deployments applied

```bash
kubectl apply -f backend/backend-deployment.yaml
kubectl apply -f frontend/frontend-deployment.yaml
```

```bash
kubectl get deployment
```
```
NAME       READY   UP-TO-DATE   AVAILABLE   AGE
backend    3/3     3            3           40s
frontend   1/1     1            1           23s
```

- Backend deployed with **3 replicas**.
- Frontend deployed with **1 replica**, exposed via a `frontend-nodeport` Service
  (created as part of `frontend-deployment.yaml`).

---

## 3. First issue: "Failed to fetch" from the frontend page

### Initial Service state

```bash
kubectl get svc
```
```
NAME                TYPE       CLUSTER-IP     EXTERNAL-IP   PORT(S)        AGE
frontend-nodeport   NodePort   10.43.65.211   <none>        80:30081/TCP   43s
```

```bash
kubectl get endpoints
```
```
NAME                ENDPOINTS           AGE
frontend-nodeport   10.42.0.103:80      56s
```

**Learning:** the presence of a healthy endpoint (a real pod IP) confirmed the
Service's selector was matching a pod correctly. The actual problem was never
"no backend pod" — it was **which address/port to use to reach the app from
outside the cluster.**

### Root cause #1 — used the wrong port
`NodePort` services expose the app on a random/assigned high port
(`30000–32767`), mapped from the Service's `port`. The pod IP (`10.42.0.103:80`)
is **not** what you connect to from your laptop.

```bash
kubectl get svc frontend-nodeport
```
```
NAME                TYPE       CLUSTER-IP     EXTERNAL-IP   PORT(S)        AGE
frontend-nodeport   NodePort   10.43.65.211   <none>        80:30081/TCP   4m39s
```

✅ Correct address: `http://localhost:30081` (not port 80, not the pod IP).

---

## 4. Deploying the backend

```bash
kubectl apply -f backend/backend-clusterip-service.yaml
```

```bash
kubectl get svc
```
```
NAME                TYPE        CLUSTER-IP     EXTERNAL-IP   PORT(S)        AGE
backend-clusterip   ClusterIP   10.43.55.249   <none>        80/TCP         7s
frontend-nodeport   NodePort    10.43.65.211   <none>        80:30081/TCP   6m17s
kubernetes          ClusterIP   10.43.0.1      <none>        443/TCP        235d
```

Backend and frontend now both live in the same cluster, but the frontend page's
"Call backend" button (pointed at `http://<backend-clusterip>`) still failed
with **`Failed to fetch`**.

### Root cause #2 — browser JS cannot reach a ClusterIP

- The frontend HTML/JS runs **inside the browser**, on the laptop — **outside**
  the cluster network.
- `ClusterIP` (`10.43.x.x`) is a **virtual IP** that only exists in
  `kube-proxy`'s `iptables`/`ipvs` rules on the cluster's nodes. It is not a
  real, routable address on the Mac's network at all — the OS has no route to
  it, so the connection fails before it even leaves the laptop.
- `ClusterIP` is reachable only from:
  1. Another **pod** inside the cluster (pod-to-pod networking).
  2. The **node** itself (where kube-proxy's rules live).
  3. A manual tunnel like `kubectl port-forward`.

**Key distinction learned:**

| Address type | Reachable from browser (laptop)? | Reachable from inside cluster? |
|---|---|---|
| ClusterIP | ❌ No | ✅ Yes |
| NodePort | ✅ Yes (`localhost:<nodePort>`) | ✅ Yes |
| Pod IP | ❌ No (ephemeral, internal only) | ✅ Yes |

---

## 5. Correct production-style architecture

**Rule:** only *one* entry point into the cluster should be exposed
externally. Everything internal (APIs, databases) stays on `ClusterIP` only.

```
Browser
   │  http://localhost:30081 (NodePort)
   ▼
frontend Pod (Nginx)
   │  proxy_pass → http://backend-clusterip/  (in-cluster call)
   ▼
backend-clusterip Service (ClusterIP — never exposed externally)
   │
   ▼
backend Pod
```

| Component | Service type used | Reachable from |
|---|---|---|
| frontend | NodePort (dev) / Ingress (prod) | Browser + cluster |
| backend | ClusterIP | Only other pods in-cluster |

Why not just make the backend `NodePort` or `LoadBalancer` too?
- **NodePort on backend** → opens the backend directly to anyone who can reach
  the node IP/port — no auth, no rate limiting, no TLS, bypasses the frontend
  entirely. Breaks the single-entry-point model.
- **LoadBalancer on backend** → same exposure problem, and on real cloud
  providers each `LoadBalancer` Service typically provisions a **real, billed**
  external load balancer. Not meant to be used per internal microservice.
- Confirmed hands-on by creating `backend-nodeport` (`80:30080/TCP`) — it
  **did** make the backend directly reachable at `http://localhost:30080`,
  proving the mechanism, but this is **not** the production-correct pattern
  (kept only for the exercise, meant to be deleted afterward).

---

## 6. Fix: Nginx reverse proxy inside the frontend Pod

Since the frontend is a static page served by Nginx, the browser call needs to
go through Nginx (which *is* inside the cluster) instead of hitting the
backend directly.

### `nginx.conf`

```nginx
server {
    listen 80;

    location / {
        root   /usr/share/nginx/html;
        index  index.html;
        try_files $uri $uri/ /index.html;
    }

    # Anything hitting /api/... gets forwarded to the backend's ClusterIP
    location /api/ {
        proxy_pass http://backend-clusterip/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

> `backend-clusterip` resolves automatically via Kubernetes' internal DNS —
> no hardcoded IPs needed, survives pod rescheduling / ClusterIP changes.

### `Dockerfile` (frontend)

```dockerfile
FROM nginx:1.27-alpine
COPY index.html /usr/share/nginx/html/index.html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

### HTML change

```html
<input id="url" value="/api/" />
```

(so the browser calls a **relative path**, which Nginx then proxies
server-side to the backend's ClusterIP)

### Rebuild & redeploy

```bash
cd frontend
docker build -t k8s-demo-frontend:1.0 .

kubectl set image deployment/frontend frontend=k8s-demo-frontend:1.0
kubectl rollout status deployment/frontend
```

Resulting flow:
```
Browser → http://localhost:30081/api/
             │
             ▼
   frontend Pod's Nginx (proxy_pass)
             │
             ▼
   backend-clusterip Service (in-cluster only)
             │
             ▼
        backend Pod
```

---

## 7. Why `<NodeIP>:<nodePort>` didn't work (only `localhost` did)

```bash
kubectl get nodes -o wide
```
```
NAME     STATUS   ROLES                  INTERNAL-IP   ...
colima   Ready    control-plane,master   192.168.5.1   ...
```

- k3s here runs **inside a Linux VM** (via Colima/Rancher Desktop), since
  containers need a Linux kernel and macOS isn't Linux.
- `192.168.5.1` is the node's IP **inside that VM's private network** — not
  reachable from the Mac's actual network interface, same root cause as the
  ClusterIP issue.
- Colima/Rancher Desktop automatically **port-forwards `localhost` on the Mac
  into the VM**, specifically so `NodePort` services become reachable without
  needing the VM's internal IP.

| Address | Works from Mac? | Why |
|---|---|---|
| `localhost:<nodePort>` | ✅ | VM tool auto-forwards this |
| `<NodeInternalIP>:<nodePort>` (e.g. `192.168.5.1`) | ❌ | Only exists inside the VM's private network |

**Rule of thumb for local dev on Mac/Windows (Colima, Rancher Desktop, Docker
Desktop):** always use `localhost:<nodePort>`, never the node's internal IP.

---

## 8. Commands used — quick reference

```bash
# Deployments / rollout
kubectl apply -f backend/backend-deployment.yaml
kubectl apply -f frontend/frontend-deployment.yaml
kubectl get deployment
kubectl set image deployment/frontend frontend=k8s-demo-frontend:1.0
kubectl rollout status deployment/frontend
kubectl delete deployment frontend
kubectl apply -f frontend-deployment.yaml

# Services
kubectl apply -f backend/backend-clusterip-service.yaml
kubectl apply -f backend-nodeport-service.yaml     # for testing exposure only
kubectl get svc
kubectl get svc frontend-nodeport
kubectl delete svc backend-nodeport                # cleanup after testing

# Endpoints / nodes
kubectl get endpoints
kubectl get nodes -o wide

# Testing
curl http://localhost:30081        # frontend (NodePort)
curl http://localhost:30080        # backend (NodePort) — testing only
curl http://localhost:30081/api/   # backend via Nginx proxy — the correct path
```

---

## 9. Configuring the backend Service name in the frontend

### Where the backend name already lives — and why

In `nginx.conf`:
```nginx
location /api/ {
    proxy_pass http://backend-clusterip/;
}
```

`backend-clusterip` here is a **Kubernetes Service name**, not an IP. Every
Service automatically gets a DNS entry via CoreDNS:

```
<service-name>.<namespace>.svc.cluster.local
```

So `backend-clusterip` (short form) resolves to
`backend-clusterip.default.svc.cluster.local`, which maps internally to
whatever the current ClusterIP is. Even if that IP changes later (e.g. the
Service gets recreated), the name keeps resolving correctly — which is why
Services should always be referenced **by name**, never by IP.

Verify DNS resolution from inside the cluster:
```bash
kubectl run tmp --rm -it --image=busybox -- nslookup backend-clusterip
```

### Can the backend name go in `index.html` instead of `nginx.conf`?

**No** — and the reason is the same root cause covered earlier for ClusterIP.
`index.html`'s `<script>` runs **in the browser**, on the user's machine —
not inside the cluster. Kubernetes Service DNS names (like `backend-clusterip`)
only exist in CoreDNS, **inside** the cluster network. The browser's DNS
resolver has never heard of them and never will, no matter what's typed into
the JS. Putting `http://backend-clusterip` into browser-side `fetch()` code
would fail exactly like calling the ClusterIP directly did.

What *does* correctly go in `index.html` is a **relative path only**:
```html
<input id="url" value="/api/" />
```
The browser just calls `/api/` on whatever host it's already on
(`localhost:30081`) — it has no knowledge of, and no need to know, what
actually serves that path behind the scenes.

### Division of responsibility

| Where | What it knows |
|---|---|
| `index.html` (runs in browser) | Only `/api/` — a relative path, zero backend awareness |
| `nginx.conf` (runs server-side, in the frontend Pod) | The actual backend Service name (`backend-clusterip`), resolved via cluster DNS |

This separation is itself a best practice: frontend browser code should never
need backend infrastructure details (Service names, ports, IPs) — that's an
implementation detail owned by the proxy/server layer. Move the backend to a
different Service name tomorrow, and only `nginx.conf` changes — `index.html`
stays untouched.

### Making the backend name configurable (no rebuild needed)

Instead of hardcoding `backend-clusterip` into the image, use an environment
variable with `envsubst`, a pattern supported natively by the official
`nginx:alpine` image.

**`nginx.conf.template`** (uses a variable instead of a hardcoded name):
```nginx
server {
    listen 80;

    location / {
        root   /usr/share/nginx/html;
        index  index.html;
    }

    location /api/ {
        proxy_pass http://${BACKEND_SERVICE}/;
        proxy_set_header Host $host;
    }
}
```

**Dockerfile:**
```dockerfile
FROM nginx:1.27-alpine
COPY index.html /usr/share/nginx/html/index.html
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
EXPOSE 80
```

> `nginx:alpine` images (20.x+) automatically run `envsubst` on any file in
> `/etc/nginx/templates/*.template` at container startup, writing the result
> to `/etc/nginx/conf.d/` — no extra scripting required.

**Deployment YAML** — set the env var:
```yaml
env:
  - name: BACKEND_SERVICE
    value: "backend-clusterip"
```

Now the same image works against any backend Service name just by changing
the env var in the Deployment manifest — no image rebuild needed.

### "But in real apps, we configure the backend name in the frontend" — reconciling this

This is true, but it refers to a **different layer** than the browser JS.
There are two things commonly both called "frontend":

1. **Browser-side code** — plain JS running in the user's browser
   (`index.html`'s `<script>` in this project). Has zero access to Kubernetes
   DNS or anything cluster-internal. Should never know backend Service names.

2. **Frontend *server*** — a process running as a Pod inside the cluster
   (Node/Next.js server doing SSR or acting as a Backend-for-Frontend, or in
   this project, **Nginx itself**). This layer *does* run inside the cluster,
   so it legitimately knows and uses backend Service names — via env vars,
   ConfigMaps, or config files.

   Example of what this looks like with a real Node-based frontend server
   (not part of this project, but illustrative):
   ```js
   // server.js — running INSIDE a Pod, NOT in the browser
   const BACKEND_URL = process.env.BACKEND_SERVICE || "http://backend-clusterip";

   app.get('/api/data', async (req, res) => {
     const r = await fetch(BACKEND_URL); // server-to-server call, inside cluster
     res.json(await r.json());
   });
   ```

So "configure the backend name in the frontend" means the frontend's
**server-side** config/code — not the static HTML/JS shipped to the browser.

| Real-world equivalent | This project's equivalent |
|---|---|
| Frontend server config (env vars / `server.js`) | `nginx.conf` (or its env-var template version) |
| Frontend browser code (never sees backend names) | `index.html` |

This project already follows the real-world pattern correctly —
`nginx.conf` **is** the frontend's server-side configuration layer, just in
the form of a proxy config instead of application code, since this frontend
has no Node/Express server of its own.

---

## 10. Key takeaways

1. `kubectl get endpoints` having a valid pod IP means the Service selector is
   working — it does **not** mean the Service is reachable from outside.
2. `NodePort` maps traffic via a random/assigned port (`30000–32767`) on every
   node — always use the **NodePort number**, never the container's internal
   `port`/pod IP.
3. `ClusterIP` is only reachable **inside the cluster** (pod-to-pod, or from a
   node). Browser JavaScript can never reach it directly — this is by design,
   not a bug or misconfiguration.
4. The standard fix for "browser needs to call an internal service" is a
   **reverse proxy** (Nginx in the frontend Pod, or an Ingress Controller) —
   never exposing the backend itself via `NodePort`/`LoadBalancer`.
5. `LoadBalancer` provisions a real, often **billed** cloud resource per
   Service — reserved for the cluster's single edge (usually an Ingress
   Controller), not per internal microservice.
6. On local dev tools that run Kubernetes inside a VM (Colima, Rancher
   Desktop, Docker Desktop), always connect via `localhost:<nodePort>` — the
   node's internal IP is private to the VM and unreachable from the host.
7. Production-correct pattern for this exercise:
   **frontend → NodePort (or Ingress) → Nginx proxy → backend ClusterIP.**
