# Interview Questions — Jobs, CronJobs, Namespaces, RBAC

---

## Basic

### Q1. What's a Job?
A controller that runs one or more Pods to **successful completion**, then stops. Used for migrations, batch processing, one-off scripts.

### Q2. Job's important fields?
- `completions` — total successful Pod runs needed.
- `parallelism` — max running at once.
- `backoffLimit` — retries on failure before the Job is marked failed.
- `activeDeadlineSeconds` — hard timeout; after this, Pods are killed.
- `ttlSecondsAfterFinished` — auto-delete the Job + its Pods after this many seconds. **Always set this** or finished Jobs pile up.
- `restartPolicy` on the Pod template: `OnFailure` or `Never` (never `Always` for Jobs).

### Q3. What's a CronJob?
A controller that creates a Job on a cron schedule. Same job template, just with a `schedule` field.

### Q4. CronJob `concurrencyPolicy`?
- `Allow` (default) — start the new run even if the previous is still going.
- `Forbid` — skip the new run if the previous is still running.
- `Replace` — kill the previous run and start a new one.

Use `Forbid` for idempotency-shy jobs; `Replace` for "only latest matters" jobs (data exports, refreshes).

### Q5. What's a Namespace?
A logical partition inside the cluster. Most resources (Pods, Deployments, Services, ConfigMaps, Secrets, Roles) are namespaced; a few are cluster-scoped (Nodes, PVs, StorageClasses, ClusterRoles, Namespaces themselves).

### Q6. Do namespaces give network isolation?
**No.** They scope names, RBAC, quotas, NetworkPolicies — but by default Pods in any namespace can reach Pods in any other namespace. Real isolation requires NetworkPolicies.

### Q7. RBAC's four objects?
- **ServiceAccount** — identity for Pods (and humans, in some setups).
- **Role** — what verbs are allowed on what resources, in **one namespace**.
- **ClusterRole** — same, but cluster-scoped, also used for non-namespaced resources.
- **RoleBinding / ClusterRoleBinding** — ties a Role to a subject (SA, User, Group).

### Q8. How does a Pod authenticate to the K8s API?
Kubelet projects a bearer token at `/var/run/secrets/kubernetes.io/serviceaccount/token`. Any request to the K8s API with `Authorization: Bearer <token>` is authenticated as that ServiceAccount. The CA cert at the same path validates the API server's TLS.

---

## Intermediate

### Q9. What's `kubectl auth can-i`?
A dry-run RBAC check:
```bash
kubectl auth can-i list pods -n team-alpha
kubectl auth can-i create deployments --as=alice -n staging
kubectl auth can-i list secrets --as=system:serviceaccount:team-alpha:pod-reader
```
Use it to verify policies *before* deploying workloads or onboarding users.

### Q10. Difference between `Role` and `ClusterRole`?
- **Role** — only valid in the namespace it's defined in. Cannot grant cluster-scoped permissions (Nodes, PVs).
- **ClusterRole** — works cluster-wide. Can also be bound by a *RoleBinding* in one namespace (then it grants only in that namespace) — a common pattern to reuse a definition across namespaces.

### Q11. Useful built-in ClusterRoles?
- `view` — read-only access (excluding Secrets).
- `edit` — view + create/update/delete most resources, but **not** Roles/RoleBindings.
- `admin` — edit + manage RBAC inside the namespace.
- `cluster-admin` — full power. Don't bind humans to this; use SSO + audit logs.

### Q12. What's the `default` ServiceAccount?
Every namespace has one named `default`. If you don't set `serviceAccountName` in a Pod, it gets the namespace's `default` SA. Best practice: disable token auto-mount or assign a dedicated SA per workload — the `default` SA's token is broadly auto-mounted and a small RBAC mistake can grant blast radius.

### Q13. How do you bind a ClusterRole within a single namespace?
Use a **RoleBinding** that references the ClusterRole:
```yaml
kind: RoleBinding
metadata: { name: alice-edit, namespace: staging }
subjects: [{ kind: User, name: alice }]
roleRef:
  kind: ClusterRole       # ClusterRole, not Role
  name: edit
  apiGroup: rbac.authorization.k8s.io
```
This grants the `edit` ClusterRole only in the `staging` namespace.

### Q14. Jobs vs CronJobs vs init containers vs Deployments?
- **Job** — run to completion, exit. Migrations, batch jobs.
- **CronJob** — Job on a schedule.
- **Init container** — runs before the main container in the *same* Pod. Setup like "wait for DB" or generate config.
- **Deployment** — long-running stateless workload.

### Q15. CronJob — how is the schedule timezone handled?
Historically the CronJob ran in the kube-controller-manager's timezone (typically UTC). Since K8s 1.27 you can set `spec.timeZone: "America/Los_Angeles"` per CronJob. Without it, **always assume UTC**.

### Q16. What's a Pod's effective RBAC if the SA has no Role bound?
The SA's token authenticates as `system:serviceaccount:<ns>:<sa>`. With no RoleBinding, it has only what `system:authenticated` group gets (very little — read `selfsubjectaccessreviews`, etc.). API calls return 403.

### Q17. How does `subjects.kind: Group` work?
Groups are an authentication-time concept. The API server's authenticator (OIDC / webhook / X.509 CN) returns a list of group names. `subjects.kind: Group` matches on that list. Useful for binding "everyone in the `developers` AD group has `edit` in `staging`".

---

## Scenario-based

### S1. A Job's Pod keeps OOMKilled. Job is "Failed" after 6 retries. How to handle?
Two angles:
- **Fix the memory** — bump `resources.limits.memory` in the Pod template; profile the workload (often a memory leak or batch size too large).
- **Bump `backoffLimit`** if the OOM is intermittent (e.g., variable input size). But this just retries the same failure — better to fix the root cause.

Cleanup of failed Jobs: `kubectl delete job/<name>` (and don't forget `ttlSecondsAfterFinished` for future jobs).

### S2. A CronJob hasn't run for 3 hours despite the schedule. Why?
- **`startingDeadlineSeconds`** missed — the controller didn't schedule it in time and gave up; check the field's value (default unlimited).
- **`concurrencyPolicy: Forbid`** with the previous Job stuck running.
- **Suspend** set to true.
- The kube-controller-manager was down for a while — missed runs are skipped (not made up).
- Wrong cron expression (e.g., `0 *2 * * *` instead of `0 2 * * *`).

`kubectl describe cronjob <name>` and the controller's events tell you which.

### S3. You want to run a one-off job manually from a CronJob template.
```bash
kubectl create job manual-run --from=cronjob/my-cronjob -n my-ns
```
This creates a Job from the cron's template **right now**, independent of the schedule. Useful for testing or filling a missed run.

### S4. A Pod runs as the `default` SA and someone discovers it can list all secrets in the namespace via the token. Defense?
1. **Audit RBAC**: did somebody bind `default` to `view`/`edit`? Remove it.
2. **Per-workload SAs**: never re-use `default`. Create `app-foo-sa` for app-foo and assign least privilege.
3. **Disable token auto-mount** on the `default` SA: `automountServiceAccountToken: false`. Pods that don't need the API never receive the token.
4. **OPA / Kyverno** policies to block Pods that use `default` in production namespaces.

### S5. A Job needs to talk to the K8s API to list Pods in a single namespace and nothing else.
Apply principle of least privilege:
```yaml
# SA
apiVersion: v1
kind: ServiceAccount
metadata: { name: lister, namespace: team-alpha }
---
# Role: only list pods in this ns
kind: Role
metadata: { name: list-pods, namespace: team-alpha }
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["list"]
---
# RoleBinding
kind: RoleBinding
metadata: { name: lister-binding, namespace: team-alpha }
subjects: [{ kind: ServiceAccount, name: lister, namespace: team-alpha }]
roleRef: { kind: Role, name: list-pods, apiGroup: rbac.authorization.k8s.io }
```
And `Job.spec.template.spec.serviceAccountName: lister`. Don't grant `pods/exec` or `secrets` — both are common over-grant footguns.

### S6. CronJob fires every minute but each run takes 2 minutes. Two are now running in parallel — and they're not idempotent.
`concurrencyPolicy: Forbid` — skips the new run while the previous is running. Alternatively `Replace` if you want only the latest in flight. Long-term: make the job idempotent (lock-on-record, idempotency tokens) so concurrent runs are safe.

### S7. A user gets `forbidden: User "alice" cannot get resource "pods" in API group ""`. Where do you look?
- `kubectl auth can-i get pods --as=alice -n <ns>` — confirms the deny.
- `kubectl get rolebindings,clusterrolebindings -A -o wide | grep alice` — find existing bindings.
- Check Roles for the verb/resource: missing `get` in `pods` is the literal cause.
- If using OIDC/SSO: maybe the user is in the wrong group from the IDP — check the JWT `groups` claim.
