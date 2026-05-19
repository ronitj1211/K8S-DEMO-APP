# Kubernetes — Concept-wise Mini-Projects

A hands-on, end-to-end Kubernetes course. Each folder is a small self-contained project that demonstrates **one** core K8s concept, with a backend, a frontend, manifests, and a detailed README explaining the concept, its types, and how to run the demo.

The app is intentionally the same simple Node.js backend + HTML frontend everywhere — so you can focus on the Kubernetes primitives, not the app code.

---

## Suggested learning order

### Part A — Core building blocks

| # | Concept | Folder | What you'll learn |
|---|---------|--------|-------------------|
| 1 | **Pods** | [kubernetes-pods](./kubernetes-pods/) | The atomic unit of Kubernetes. Single + multi-container Pods, port-forward, logs. |
| 2 | **Deployments** | [kubernetes-deployment](./kubernetes-deployment/) | Replicas, rolling updates, rollback, self-healing. Why never to use bare Pods. |
| 3 | **Services** | [kubernetes-services](./kubernetes-services/) | Stable endpoints. ClusterIP vs NodePort vs LoadBalancer. In-cluster DNS. |
| 4 | **Ingress** | [kubernetes-ingress](./kubernetes-ingress/) | HTTP routing by host + path. Ingress controllers. TLS termination. |
| 5 | **ConfigMaps & Secrets** | [configmap-secrets](./configmap-secrets/) | Externalized config. Env vars, `envFrom`, mounted files. Secret types. |
| 6 | **DaemonSets** | [daemonsets](./daemonsets/) | One Pod per node. Log/metrics agents. `hostPath`, `hostPort`, tolerations. |
| 7 | **Helm** | [helm](./helm/) | Templating, releases, values per environment, rollback. |

### Part B — Stateful, batch, scaling, security

| # | Concept | Folder | What you'll learn |
|---|---------|--------|-------------------|
| 8 | **StatefulSets + Storage** | [statefulsets-storage](./statefulsets-storage/) | StatefulSets, PVC, PV, StorageClass, headless Services, per-Pod storage. |
| 9 | **Jobs + RBAC** | [jobs-rbac](./jobs-rbac/) | Jobs, CronJobs, Namespaces, ServiceAccounts, Roles, RoleBindings, `auth can-i`. |
| 10 | **Autoscaling + Resources** | [autoscaling-resources](./autoscaling-resources/) | HPA v2, CPU/memory requests + limits, QoS classes, metrics-server. |

### Part C — Observability & network security

| # | Concept | Folder | What you'll learn |
|---|---------|--------|-------------------|
| 11 | **Logging (EFK)** | [elk-logging](./elk-logging/) | Elasticsearch + Fluent Bit (DaemonSet) + Kibana. Centralized log collection from every Pod. |
| 12 | **Monitoring + NetworkPolicies** | [monitoring-networkpolicies](./monitoring-networkpolicies/) | Prometheus + Grafana scraping `/metrics`; default-deny + allow-list NetworkPolicies. |

The order is cumulative — each concept builds on the previous ones. You can jump to a specific folder if you already know the earlier material.

---

## Prerequisites for the whole course

You need these installed once:

- **Docker** — to build container images.
- **A local Kubernetes cluster.** Pick one:
  - [minikube](https://minikube.sigs.k8s.io/docs/start/) (recommended for beginners)
  - [kind](https://kind.sigs.k8s.io/docs/user/quick-start/) (lighter, great for multi-node)
  - Docker Desktop's built-in Kubernetes
- **kubectl** — the K8s CLI.
- **Helm v3** — only for the [helm](./helm/) folder.
- **metrics-server** — needed for [autoscaling-resources](./autoscaling-resources/). On minikube: `minikube addons enable metrics-server`.
- **A CNI that enforces NetworkPolicies** (Calico / Cilium / Weave) — needed for the NetworkPolicy part of [monitoring-networkpolicies](./monitoring-networkpolicies/). On minikube: `minikube start --cni=calico`.
- **More cluster memory** (~6 GB) for the [elk-logging](./elk-logging/) chapter — Elasticsearch and Kibana are heavy. `minikube start --memory=6144 --cpus=4`.

Verify your setup:

```bash
docker version
kubectl version --client
kubectl cluster-info
helm version          # only if you'll do the helm chapter
```

If `kubectl cluster-info` fails, start your cluster:

```bash
minikube start            # or: kind create cluster
```

---

## A note on container images

Each folder builds its own images locally (`k8s-demo-backend:1.0`, `k8s-demo-frontend:1.0`, etc.) The cluster needs to **see** those images. Three options:

### minikube

Point your shell at minikube's Docker daemon before building:

```bash
eval $(minikube docker-env)
docker build -t k8s-demo-backend:1.0 ./backend
```

### kind

Build with the normal Docker, then load into kind:

```bash
docker build -t k8s-demo-backend:1.0 ./backend
kind load docker-image k8s-demo-backend:1.0
```

### Docker Desktop

Docker Desktop's Kubernetes shares the host Docker daemon, so a normal `docker build` is enough.

---

## Common `kubectl` commands you'll use throughout

```bash
kubectl apply -f path/to/file.yaml         # create / update from a manifest
kubectl delete -f path/to/file.yaml        # remove what that manifest created
kubectl get <resource>                     # list (pods, deploy, svc, ingress, ...)
kubectl get <resource> -o wide             # include IP, node
kubectl get <resource> -o yaml             # full YAML
kubectl describe <resource> <name>         # detailed state + events
kubectl logs <pod>                         # logs (-c <container> for multi-container)
kubectl logs -f <pod>                      # follow
kubectl exec -it <pod> -- sh               # shell into a Pod
kubectl port-forward <pod|svc|deploy> 8080:80   # local laptop port → Pod/Service
kubectl rollout status deployment/<name>
kubectl rollout undo   deployment/<name>
kubectl get pods -w                        # watch live
```

---

## Mental map: how the pieces fit

```
                          Internet
                              │
                              ▼
                         ┌─────────┐
                         │ Ingress │   <- HTTP routing rules
                         └────┬────┘
                              │ (Ingress Controller proxies)
                              ▼
                ┌──────────────────────────┐
                │       Service            │   <- stable IP / DNS, load-balances
                │  (ClusterIP/NodePort/LB) │
                └─────────┬────────────────┘
                          │ (label selector)
            ┌─────────────┼─────────────┐
            ▼             ▼             ▼
         ┌─────┐       ┌─────┐       ┌─────┐
         │ Pod │       │ Pod │       │ Pod │   <- created by Deployment / DaemonSet / ...
         └─────┘       └─────┘       └─────┘
            ▲             ▲             ▲
            └─────── owned by ──────────┘
                          │
                   ┌─────────────┐
                   │ Deployment  │   <- manages replicas + rollouts
                   └─────────────┘

   Config flowing into Pods:
   ConfigMap  ──env vars / mounted files──►  Pod
   Secret     ──env vars / mounted files──►  Pod
```

For per-node workloads (log shippers, agents) replace **Deployment** with **DaemonSet**.

To package and parameterize the whole thing for different environments, wrap the manifests in a **Helm chart**.

---

## Folder convention

Every concept folder follows the same shape:

```
<concept>/
├── backend/              # Node.js Express service
│   ├── server.js
│   ├── package.json
│   ├── Dockerfile
│   └── <concept manifests>.yaml
├── frontend/             # nginx + plain HTML
│   ├── index.html
│   ├── Dockerfile
│   └── <concept manifests>.yaml
└── README.md             # concept + types + how to run + key takeaways
```

The helm folder also adds a `chart/` directory with templates and values files.

---

## Tip: cleaning up between chapters

Every README has a "Cleanup" section. If you skip it and things get messy:

```bash
kubectl get all                              # see what's running
kubectl delete all --all                     # nukes everything in the current namespace (careful!)
```

Or work in dedicated namespaces:

```bash
kubectl create namespace pods-demo
kubectl apply -n pods-demo -f backend/backend-pod.yaml
# ...
kubectl delete namespace pods-demo           # one command, all gone
```

---

## Where to go after this course

You've covered the core, plus storage, scaling, security, and observability. Natural next topics:

- **Gateway API** — the modern successor to Ingress, more expressive routing.
- **Operators / CRDs** — extending Kubernetes with your own resource types (and using existing ones like the Postgres / Elasticsearch / Kafka operators in production).
- **Service mesh** (Istio, Linkerd, Cilium) — mTLS, advanced traffic management, L7 policies.
- **Vertical Pod Autoscaler (VPA)** and **Cluster Autoscaler / Karpenter** — auto-size Pods and the cluster itself.
- **KEDA** — event-driven autoscaling on queue depth, Kafka lag, custom metrics.
- **GitOps with Argo CD or Flux** — declarative cluster state from git.
- **Policy as code**: OPA Gatekeeper / Kyverno for cluster-wide policy enforcement.
- **Distributed tracing** with Tempo / Jaeger / OpenTelemetry — to round out logs + metrics.
- **Backup**: Velero for cluster + PV backups.

Happy shipping. 🚢
