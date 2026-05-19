# Jobs, CronJobs, Namespaces & RBAC

Four related concepts in one folder:

- **Namespaces** — virtual clusters inside one cluster.
- **Jobs / CronJobs** — run-to-completion and scheduled workloads.
- **ServiceAccounts / Roles / RoleBindings** — *who* in the cluster can do *what*.

They tend to be used together: you create a Namespace for a team or app, run their batch Jobs in that Namespace, and use RBAC to limit what those Jobs (and the people maintaining them) can touch.

---

# 1. Namespaces

## What is a Namespace?

A **Namespace** is a logical partition inside a cluster. Most objects (Pods, Deployments, Services, ConfigMaps, Secrets, PVCs, Jobs, Roles…) live **inside** a Namespace; a few (Nodes, PVs, StorageClasses, ClusterRoles, Namespaces themselves) are **cluster-scoped**.

Namespaces give you:

- **Isolation by name** — `service-a` in `team-alpha` and `service-a` in `team-beta` are different objects.
- **Scope for RBAC** — grant a team admin rights only in their namespace.
- **Scope for resource quotas and network policies.**
- **A handy unit to delete** — `kubectl delete ns team-alpha` wipes everything inside.

Namespaces do **not** give you network isolation by themselves — Pods in different namespaces can still talk. For network isolation, use **NetworkPolicies**.

## Common namespaces

| Namespace | Purpose |
|-----------|---------|
| `default` | Where things go if you don't specify. Avoid using it for real apps. |
| `kube-system` | Core K8s components (kube-proxy, coredns, controller-manager). |
| `kube-public` | World-readable cluster info. |
| `kube-node-lease` | Node heartbeat objects. |

You typically create your own: `prod`, `staging`, `team-payments`, `cert-manager`, `monitoring`, `logging`, etc.

---

# 2. Jobs & CronJobs

## Job

A **Job** runs one or more Pods to **completion**. When the required number of successful completions is reached, the Job is done. If a Pod fails, the Job retries up to `backoffLimit` times.

Use Jobs for:

- Database migrations / schema changes.
- One-off data imports.
- Batch processing.
- Generate-and-upload-an-export tasks.

Key fields:

```yaml
spec:
  completions: 3          # total successful Pod runs required
  parallelism: 2          # how many can run at once
  backoffLimit: 4         # retries on failure before declaring the Job failed
  activeDeadlineSeconds: 600   # kill if not done within 10 minutes
  ttlSecondsAfterFinished: 600 # auto-delete the Job + its Pods 10 min after it finishes
  template:
    spec:
      restartPolicy: OnFailure   # OR "Never" — never "Always" for Jobs
```

## CronJob

A **CronJob** creates a Job on a schedule (standard cron format).

Use CronJobs for:

- Nightly reports.
- Periodic cleanup (delete old rows / files).
- Scheduled syncs from a 3rd-party API.

Key fields:

```yaml
spec:
  schedule: "0 2 * * *"            # every day at 02:00
  concurrencyPolicy: Forbid        # Allow / Forbid / Replace
  startingDeadlineSeconds: 60      # if missed for more than this, skip
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 1
  jobTemplate:
    spec: { ... }                  # exactly like a Job
```

`concurrencyPolicy`:

- `Allow` — start the new run even if the previous is still going.
- `Forbid` — skip the new run if the previous is still going.
- `Replace` — cancel the previous run and start a new one.

---

# 3. ServiceAccounts, Roles, RoleBindings (RBAC)

## What problem does RBAC solve?

The Kubernetes API can do anything — create Pods, read Secrets, delete entire namespaces. You need to limit who can do what:

- **Humans** ("Alice can deploy in `staging`, not `prod`.")
- **Workloads** ("This Job needs to list Pods. Nothing else.")

That's RBAC.

## The four pieces

| Object | What it is |
|--------|------------|
| **ServiceAccount** | An *identity* for Pods. Every Pod runs as some SA (`default` if you don't set one). |
| **Role** | A list of allowed verbs on resources, scoped to **one namespace**. |
| **ClusterRole** | Same, but **cluster-scoped** (also used for non-namespaced resources). |
| **RoleBinding** | Ties a Role to a subject (SA, User, or Group) in a namespace. |
| **ClusterRoleBinding** | Ties a ClusterRole to a subject cluster-wide. |

Think of it as:

```
Subject (who)  ────binding────►  Role (what they can do)
```

## Reading a Role

```yaml
rules:
  - apiGroups: [""]              # "" = core API group: pods, services, configmaps, ...
    resources: ["pods"]          # ... on pods
    verbs: ["get", "list", "watch"]   # ... only read verbs
```

Verbs you'll see: `get`, `list`, `watch`, `create`, `update`, `patch`, `delete`, `deletecollection`. There's also `*` for "all".

## How a Pod uses its ServiceAccount

When you set `serviceAccountName: pod-reader` on a Pod, the kubelet mounts a token at `/var/run/secrets/kubernetes.io/serviceaccount/token` inside the container. Any call to the K8s API with `Authorization: Bearer <token>` is authenticated as that SA.

That's exactly what the `rbac-test` Job in this folder does — see [`backend/22-rbac-test-job.yaml`](./backend/22-rbac-test-job.yaml).

## Useful built-in ClusterRoles

| Name | Power |
|------|-------|
| `view` | Read-only access to most resources (but not Secrets). |
| `edit` | View + create/update/delete most resources. |
| `admin` | edit + manage Roles/RoleBindings (within a namespace). |
| `cluster-admin` | All powers everywhere. |

You usually grant these via a RoleBinding to a user or group, e.g.:

```bash
kubectl create rolebinding alice-edit \
  --clusterrole=edit --user=alice --namespace=team-alpha
```

---

## What's in this folder

```
jobs-rbac/
├── backend/
│   ├── server.js, package.json, Dockerfile
│   ├── 01-namespaces.yaml         # team-alpha + team-beta
│   ├── 02-deployment.yaml         # a backend in team-alpha (just so we can curl it)
│   ├── 10-job.yaml                # a Job with completions=3, parallelism=2
│   ├── 11-cronjob.yaml            # a CronJob that runs every minute
│   ├── 20-serviceaccount.yaml     # ServiceAccount: pod-reader
│   ├── 21-role.yaml               # Role + RoleBinding: read pods in team-alpha
│   └── 22-rbac-test-job.yaml      # Job that hits the K8s API as pod-reader and proves the boundary
├── frontend/
│   ├── index.html, Dockerfile
│   └── frontend.yaml
└── README.md
```

---

## Prerequisites

Docker, `kubectl`, local cluster.

---

## How to run

### 1. Build images

```bash
eval $(minikube docker-env)   # minikube only

cd backend  && docker build -t jobs-rbac-backend:1.0 .
cd ../frontend && docker build -t jobs-rbac-ui:1.0 .
```

(kind: `kind load docker-image ...`)

### 2. Create namespaces and the backend

```bash
kubectl apply -f backend/01-namespaces.yaml
kubectl apply -f backend/02-deployment.yaml
kubectl apply -f frontend/frontend.yaml

kubectl get namespaces
kubectl get pods -n team-alpha
```

> Note: `kubectl get pods` by itself looks at the current namespace (usually `default`). Use `-n <ns>` to look elsewhere, or `-A` for all namespaces.

### 3. Run the Job

```bash
kubectl apply -f backend/10-job.yaml
kubectl get jobs -n team-alpha
kubectl get pods -n team-alpha -l job-name=hello-job -w
kubectl logs -n team-alpha -l job-name=hello-job --tail=100
```

You should see 3 Pods complete, up to 2 at a time. After ~10 min the Job is auto-cleaned (`ttlSecondsAfterFinished`).

### 4. Run the CronJob

```bash
kubectl apply -f backend/11-cronjob.yaml
kubectl get cronjob -n team-alpha
```

Wait a minute, then:

```bash
kubectl get jobs -n team-alpha
kubectl logs -n team-alpha -l job-name --tail=5
```

Trigger immediately (don't wait for cron):

```bash
kubectl create job heartbeat-manual \
  --from=cronjob/heartbeat -n team-alpha
```

### 5. Set up the ServiceAccount + Role + RoleBinding

```bash
kubectl apply -f backend/20-serviceaccount.yaml
kubectl apply -f backend/21-role.yaml

kubectl get sa,role,rolebinding -n team-alpha
```

### 6. Prove the RBAC: run the test Job

```bash
kubectl apply -f backend/22-rbac-test-job.yaml
kubectl wait --for=condition=complete job/rbac-test -n team-alpha --timeout=60s
kubectl logs -n team-alpha -l job-name=rbac-test
```

You should see:

- Pods listing in `team-alpha` → **succeeds** (a JSON pod list).
- Listing **Secrets** in `team-alpha` → **403 Forbidden**.
- Listing pods in `team-beta` → **403 Forbidden**.

That's the principle of **least privilege** working: the SA can read exactly what its Role permits and nothing else.

### 7. The "can-i" shortcut

`kubectl auth can-i` lets you ask "could subject X do verb Y on resource Z?" without running a real call.

```bash
# Can the pod-reader SA list pods in team-alpha? -> yes
kubectl auth can-i list pods -n team-alpha \
  --as=system:serviceaccount:team-alpha:pod-reader

# Can it list secrets in team-alpha? -> no
kubectl auth can-i list secrets -n team-alpha \
  --as=system:serviceaccount:team-alpha:pod-reader

# Can it list pods in team-beta? -> no
kubectl auth can-i list pods -n team-beta \
  --as=system:serviceaccount:team-alpha:pod-reader
```

Very useful for debugging permissions before you ship.

---

## Useful commands

```bash
# Namespaces
kubectl get ns
kubectl create ns my-ns
kubectl config set-context --current --namespace=my-ns    # default ns for current context
kubectl get pods -A                                       # ALL namespaces

# Jobs / CronJobs
kubectl get jobs,cronjobs -n team-alpha
kubectl describe job hello-job -n team-alpha
kubectl logs -n team-alpha -l job-name=hello-job
kubectl create job manual --from=cronjob/heartbeat -n team-alpha
kubectl delete job hello-job -n team-alpha

# RBAC
kubectl get sa,role,rolebinding,clusterrole,clusterrolebinding -n team-alpha
kubectl describe rolebinding pod-reader-binding -n team-alpha
kubectl auth can-i <verb> <resource> [--as=<user|sa>] [-n <ns>]
kubectl create role          ...   # imperative create
kubectl create rolebinding   ...
```

---

## Cleanup

```bash
kubectl delete -f backend/22-rbac-test-job.yaml
kubectl delete -f backend/11-cronjob.yaml
kubectl delete -f backend/10-job.yaml
kubectl delete -f frontend/frontend.yaml
kubectl delete -f backend/02-deployment.yaml
kubectl delete -f backend/21-role.yaml
kubectl delete -f backend/20-serviceaccount.yaml

# Nuke everything in one shot:
kubectl delete namespace team-alpha team-beta
```

---

## Key takeaways

1. **Namespaces** partition the cluster logically. Most resources are namespaced; a few (Nodes, PVs, StorageClass, ClusterRoles, Namespaces) are cluster-scoped.
2. **Jobs** run to completion; **CronJobs** create Jobs on a schedule. Always set `ttlSecondsAfterFinished` so old Jobs don't pile up.
3. Every Pod runs as a **ServiceAccount**. If you don't specify one, it's `default` — usually with no API access.
4. **Role + RoleBinding** scopes permissions to a namespace; **ClusterRole + ClusterRoleBinding** scopes them cluster-wide.
5. Use `kubectl auth can-i` to verify RBAC before deploying.
6. Grant the **smallest set of permissions** a workload needs. "Least privilege" matters when (not if) a workload is compromised.

**Back to** [course index](../README.md)
