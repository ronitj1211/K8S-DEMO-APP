# Jobs, CronJobs, Namespaces & RBAC — Deep Dive for Interviews

The narrative version covering four related-but-distinct concepts.

---

## Namespaces — the origin story

The K8s API was designed multi-tenant from day one. But if two teams shared a cluster and both wanted to call their service `backend`, chaos. Namespaces are the answer: **a namespace scopes a name**. `backend` in `team-alpha` is a completely different object from `backend` in `team-beta`.

Namespaces do more than name-scoping:
- **RBAC boundary** — you can grant a user `edit` in `staging` and only there.
- **ResourceQuota scope** — cap a team's total CPU/memory/objects.
- **NetworkPolicy scope** — policies default to namespace-scoped Pod selectors.
- **A unit of deletion** — `kubectl delete namespace team-alpha` deletes everything inside.

They **don't** provide network isolation on their own. Two Pods in different namespaces can freely talk unless a NetworkPolicy says otherwise.

The mental model: a namespace is a **folder for Kubernetes resources**, with names scoped to the folder, plus a bunch of policies that can attach to it.

## Jobs & CronJobs — the origin story

Deployments run forever. But real systems have work that ends: DB migrations, nightly backups, batch exports, ML training jobs. Running these as Deployments is wrong — a Deployment restarts the Pod when it exits, even successfully.

**Job** is the "run-to-completion" primitive. It creates one or more Pods and considers itself done when the required number succeed. Failed Pods retry (up to `backoffLimit`) before the whole Job is marked failed. Once complete, the Pod stays around (for logs) unless `ttlSecondsAfterFinished` cleans it up.

**CronJob** is Job on a schedule. Same object model, plus a cron expression. At each firing, the CronJob controller creates a Job (which creates Pods). History is capped by `successfulJobsHistoryLimit` / `failedJobsHistoryLimit` — old completed Jobs auto-delete.

The important dial is `concurrencyPolicy`:
- `Allow` — start new runs even if the previous is still going. Default. Dangerous for non-idempotent jobs.
- `Forbid` — skip new run if previous is running. Safe default for real work.
- `Replace` — kill previous, start new. "Only latest matters."

## RBAC — the origin story

The K8s API is powerful — you can create Pods (which run arbitrary code), read Secrets, delete namespaces. Every operation goes through the API server. So the K8s security model boils down to: **which principals can do which verbs on which resources?**

Pre-1.6, K8s used a much weaker authorization system. Since 1.6, **Role-Based Access Control** is the standard. Four objects:

- **ServiceAccount** — identity for Pods. Every Pod runs as some SA (default if unspecified). The SA's token is auto-mounted into the container at `/var/run/secrets/kubernetes.io/serviceaccount/token`.
- **Role** — a list of allowed verbs on resources, scoped to **one namespace**.
- **ClusterRole** — same, but cluster-scoped (also used for non-namespaced resources like Nodes, StorageClasses).
- **RoleBinding / ClusterRoleBinding** — ties a Role to a subject (SA, User, or Group).

The subject can be a `ServiceAccount` (in-cluster identity), `User` (external human, authenticated via OIDC or client cert), or `Group` (set of users, from the authenticator).

## How RBAC actually works

Every K8s API request is authenticated (who are you?) then authorized (can you do this?). Authorization is done by chained authorizers; RBAC is the main one.

For a request like `GET /api/v1/namespaces/team-alpha/pods`, RBAC asks: does the caller have `get` on `pods` in namespace `team-alpha`? It walks:
1. **ClusterRoleBindings** that bind ClusterRoles to this subject — if a matching rule exists, allow.
2. **RoleBindings in `team-alpha`** that bind Roles or ClusterRoles to this subject — if a matching rule exists, allow.

If nothing matches, deny.

**In-cluster workloads**: a Pod's identity is the ServiceAccount it runs under. Set `spec.serviceAccountName: pod-reader`; kubelet mounts that SA's token; any API call with `Authorization: Bearer <token>` authenticates as `system:serviceaccount:<ns>:<sa>`.

**Least privilege in practice**: don't use `default` for workloads. Create a per-workload SA with only the permissions it needs. Don't grant `list secrets` unless the app actually reads secrets from the API (most don't — they use env-injected values).

## When to use these

- **Namespaces** — per team, per app, per environment. Common patterns: `team-*` for tenant isolation, `<app>-prod` / `<app>-staging` for environment separation, `<system>-system` for platform components (`monitoring`, `logging`, `ingress-nginx`).

- **Job** — DB migrations at deploy time, one-off imports, generate-and-upload exports, chaos tests. Always set `ttlSecondsAfterFinished` or you'll accumulate corpses.

- **CronJob** — nightly backups, periodic cleanups, sync jobs, health probes to external services. Beware timezone (UTC by default; K8s 1.27+ supports `spec.timeZone`), missed run behavior (`startingDeadlineSeconds`), and idempotency.

- **ServiceAccount + Role + RoleBinding** — every workload that calls the K8s API. Even ones that just do `get pods` in the same namespace. Always least privilege, always dedicated SA.

## Common misunderstandings

**"Namespaces isolate network traffic."** No — they only scope names, RBAC, quotas, and policies. Traffic flows freely across namespaces unless NetworkPolicies block it.

**"CronJob runs at exact cron time."** Best-effort. Under high API server load, cron firings can be delayed 10+ minutes. If you need precise firing, use an external scheduler like Airflow, or design jobs to be idempotent so drift doesn't matter.

**"CronJob's schedule accepts my local timezone."** Before K8s 1.27, cron ran in the controller-manager's timezone, which is UTC on managed clusters. Since 1.27, `spec.timeZone: "America/Los_Angeles"` works, but don't rely on it in older clusters.

**"Deleting a Job deletes its Pods."** By default yes (cascade). But if you set `spec.podFailurePolicy` or restart the API server mid-delete, Pod artifacts can linger.

**"The `default` ServiceAccount is safe."** Its token is auto-mounted into every Pod that doesn't specify a different SA. If someone accidentally binds `default` in a namespace to a permissive role (`view`, `edit`), every workload in that namespace inherits that access. Best practice: `automountServiceAccountToken: false` on the default SA in prod namespaces, or Kyverno policies that reject Pods using default.

**"Job retries mean retry the Pod indefinitely."** No — `backoffLimit` caps retries (default 6). After that, the Job is marked `Failed` and stops. `activeDeadlineSeconds` is a wall-clock timeout independent of retries.

**"ClusterRoles are for cluster-scoped resources; Roles for namespaced."** ClusterRoles work for both, actually. A ClusterRole granting `get pods` can be bound cluster-wide (all namespaces) OR by a RoleBinding to a single namespace. Roles only work per-namespace. This confuses everyone.

## The war stories

**"A CronJob missed 6 hours of runs."** Two possibilities: `startingDeadlineSeconds` was low and the controller-manager was overloaded (fired too late, gave up). Or the previous run got stuck and `concurrencyPolicy: Forbid` skipped everything until it cleared. Debug: `kubectl describe cronjob` events show the reason.

**"Jobs accumulated for weeks, cluster ran out of etcd space."** No `ttlSecondsAfterFinished` set. Every completed Job stayed forever. Fix: retrofit `ttlSecondsAfterFinished: 3600` on every CronJob template.

**"Our migration Job ran twice."** `concurrencyPolicy: Allow` (default) plus a slow migration. The next scheduled firing overlapped. Since migrations aren't idempotent, half-applied one, half-applied the other. Fix: `Forbid` on the CronJob, and make migrations idempotent regardless.

**"A workload got `403 forbidden` from the API."** RBAC. Use `kubectl auth can-i list pods --as=system:serviceaccount:default:my-sa` to check. Usually the SA has no binding, or the binding references the wrong SA name (case-sensitive), or the Role's `resources:` doesn't include the resource the workload is trying to touch.

**"A Pod could read all Secrets in the cluster because of a broad ClusterRoleBinding."** Common footgun: `cluster-admin` bound to `system:authenticated`. That means any authenticated user (including default SAs across all namespaces). Audit ClusterRoleBindings with `kubectl get clusterrolebindings -o wide` and specifically look at `subjects.kind: Group, name: system:authenticated`. Never bind broad roles to broad groups.

**"Namespace deletion is stuck in `Terminating`."** A finalizer on some resource inside the namespace can't complete. Common causes: CRD custom resources whose finalizer requires an operator that's already gone, or a stuck PVC. Fix (destructive): patch the namespace to remove `spec.finalizers`. Better fix: identify and clean up the stuck resource first.

## What to actually say in an interview

If asked about namespaces:

> Namespaces are Kubernetes' way of scoping resource names and applying policies. Most resources — Pods, Deployments, Services, ConfigMaps, Secrets, PVCs, Roles — are namespaced; a few like Nodes, PVs, StorageClasses, ClusterRoles, and Namespaces themselves are cluster-scoped. Namespaces give you a natural boundary for RBAC (grant edit only in staging), for ResourceQuotas (cap team resources), and for NetworkPolicies (isolate traffic). Important: namespaces do NOT isolate network traffic on their own — Pods across namespaces can talk unless NetworkPolicies block it.

If asked about Jobs vs Deployments:

> Deployments run forever — if the Pod exits successfully, they restart it, because Deployments assume something's wrong. Jobs run to completion — the Job succeeds when N Pods exit with success. Use Jobs for migrations, batch processing, one-off imports. Always set `ttlSecondsAfterFinished` so finished Jobs don't accumulate. CronJobs create Jobs on a schedule; watch out for concurrency policy (default Allow can cause overlapping runs) and time zone (UTC before 1.27).

If asked about RBAC:

> RBAC has four objects. ServiceAccount is the identity a Pod uses. Role and ClusterRole list allowed verbs on resources — Roles are namespaced, ClusterRoles are cluster-scoped or can be reused across namespaces. RoleBinding and ClusterRoleBinding tie a Role to a subject. The pattern I'd use is: per workload, a dedicated ServiceAccount, and a Role with only the specific verbs on the specific resources that workload needs. Verify with `kubectl auth can-i`. Never grant permissions to the default SA — that's a common footgun where a config change grants blast-radius access to every workload in the namespace.

If asked about least privilege:

> The specific commands: `kubectl auth can-i list pods -n prod --as=system:serviceaccount:prod:my-app`. If it says yes and you didn't expect it, walk the bindings. Named subjects (not the default SA), scope to specific resources not `*`, verbs limited to what the workload actually calls. And I'd audit ClusterRoleBindings periodically — that's where broad access usually lives.

Say the words: **namespaces scope names not network**, **run-to-completion**, **backoffLimit + activeDeadlineSeconds + ttlSecondsAfterFinished**, **concurrencyPolicy**, **ServiceAccount as identity**, **least privilege**, **auth can-i**.
