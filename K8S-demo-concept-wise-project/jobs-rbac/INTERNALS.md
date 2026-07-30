# Jobs, CronJobs, Namespaces & RBAC — Internals

Under-the-hood mechanics: controller reconcile loops, ServiceAccount token mechanics, RBAC evaluation flow.

---

## Namespaces — how they're implemented

A Namespace is just an API object that other objects reference. The API server enforces that a `Pod` in `ns=foo` can only reference ConfigMaps in `ns=foo` (etc.), that RBAC scoped to `ns=foo` only affects that namespace's resources.

**Under the hood**: every namespaced object has `metadata.namespace: foo`. API server URLs include the namespace: `/api/v1/namespaces/foo/pods`. That's the mechanism — same object type, different URL prefixes.

Namespaces do NOT provide:
- **Network isolation** — Pods across namespaces can freely talk unless NetworkPolicies block them.
- **Storage isolation** — PVs are cluster-scoped; a PVC in ns-A can accidentally bind to a PV meant for ns-B (rare, but possible).
- **DNS isolation** — DNS names are `<svc>.<namespace>.svc.cluster.local`, so cross-ns resolution is trivial.

The **default ServiceAccount** every namespace has can be a footgun — if broadly-scoped RoleBindings target `default`, every workload in that namespace inherits.

## Job — the controller loop

A **Job** is a controller that watches Job objects. Each Job spec has:

- `completions` — total successful Pod runs needed (default 1).
- `parallelism` — max Pods running at once (default 1).
- `backoffLimit` — retries on failure before Job → Failed (default 6).
- `activeDeadlineSeconds` — wall-clock timeout.
- `ttlSecondsAfterFinished` — auto-delete after this many seconds post-completion.

**Reconcile loop:**

1. Count Pods matching the Job's selector (an auto-generated label like `job-name=hello-job`).
2. Count how many succeeded, how many failed, how many are running.
3. Compare to spec:
   - If succeeded == completions → Job is Complete.
   - If failed > backoffLimit → Job is Failed.
   - If running < parallelism and succeeded < completions → create more Pods.
4. If completed and TTL elapsed → delete the Job (which cascade-deletes its Pods).

**Backoff between retries**: exponential — 10s, 20s, 40s, ... up to 6 minutes. The controller doesn't fire retries immediately.

## Job completion modes

Two modes:

- **Non-indexed** (default) — Pods are anonymous. Job succeeds when `completions` Pods have exited 0. Order doesn't matter.
- **Indexed** — set `spec.completionMode: Indexed`. Each Pod gets a unique index (0 to completions-1) in the env var `JOB_COMPLETION_INDEX` and as a label. Useful for parallel workers that need to know their shard number.

```yaml
spec:
  completions: 10
  parallelism: 5
  completionMode: Indexed
  template:
    spec:
      containers:
        - name: worker
          command: ["sh", "-c", "process-shard.sh $JOB_COMPLETION_INDEX"]
```

## Pod failure policy (K8s 1.26+)

Fine-grained retry policy:

```yaml
spec:
  podFailurePolicy:
    rules:
      - action: FailJob                  # bail immediately, no retries
        onExitCodes: { operator: In, values: [1, 42] }   # specific fatal codes
      - action: Ignore                   # don't count as failure
        onExitCodes: { operator: In, values: [137] }     # OOM = infrastructure issue, not code
```

Without this, K8s retries anything until `backoffLimit`. Useful for jobs where certain failures are transient and others fatal.

## CronJob — Job on a schedule

A **CronJob** controller watches CronJob objects. Each has:

- `schedule` — cron expression.
- `concurrencyPolicy` — `Allow` / `Forbid` / `Replace`.
- `startingDeadlineSeconds` — how late is OK to fire.
- `jobTemplate` — the Job to create at each firing.

**Reconcile loop:**

1. Check current time against cron schedule.
2. If it's time to fire:
   - Apply `concurrencyPolicy`:
     - `Allow`: create a new Job even if previous is running.
     - `Forbid`: skip if previous is still running.
     - `Replace`: kill previous, start new.
   - Create a Job from `jobTemplate`.
3. Clean up old completed Jobs beyond `successfulJobsHistoryLimit` / `failedJobsHistoryLimit`.

**Timezone**: since K8s 1.27, `spec.timeZone: "America/Los_Angeles"` works. Before that, cron ran in the controller-manager's timezone (usually UTC).

**Missed runs**: if the controller-manager was down for a firing time, that firing is missed unless it can catch up within `startingDeadlineSeconds`. Cron doesn't have exactly-once semantics — design for idempotency.

## ServiceAccount token — the mechanics

Every Pod runs as a ServiceAccount. The kubelet mounts an auto-generated token at:

```
/var/run/secrets/kubernetes.io/serviceaccount/
├── token       # JWT signed by the API server's private key
├── ca.crt      # cluster CA cert (to verify API server TLS)
└── namespace   # the Pod's namespace, for convenience
```

**Old model (pre-1.24)**: the token was a static Secret of type `kubernetes.io/service-account-token`, referenced from the SA via `.secrets[]`. The token never expired.

**New model (1.24+)**: **projected service-account tokens**. The token is a short-lived JWT (default 1 hour) generated by the API server on demand and refreshed by the kubelet. Files at the same path, but the values rotate.

```yaml
# What the kubelet actually mounts, under the covers
volumes:
  - name: kube-api-access-xxxxx
    projected:
      sources:
        - serviceAccountToken:
            path: token
            expirationSeconds: 3600
            audience: <cluster URL>
        - configMap:
            name: kube-root-ca.crt
            items: [{ key: ca.crt, path: ca.crt }]
        - downwardAPI:
            items: [{ path: namespace, fieldRef: { fieldPath: metadata.namespace } }]
```

**Effect**: even if a Pod token leaks, it's useless after an hour.

## How the API server authenticates a Pod

Pod sends request with `Authorization: Bearer <token>`.

1. **Authentication chain**: API server's authenticators run in order. For SA tokens, the `serviceaccount` authenticator:
   - Verifies the JWT signature using the API server's public key.
   - Extracts claims: `sub` = the SA's identity string (`system:serviceaccount:<namespace>:<name>`), plus groups.
2. If auth succeeds, the request is authenticated as `system:serviceaccount:<ns>:<sa>` in groups `system:authenticated`, `system:serviceaccounts`, `system:serviceaccounts:<ns>`.
3. **Authorization chain**: RBAC evaluator (and others, e.g., ABAC or webhook if configured) decides if this identity can do this verb on this resource.

## RBAC evaluation

For a request "PUT /api/v1/namespaces/prod/deployments/api":
- **Verb**: `update` on `deployments` (extensions or apps group).
- **Subject**: the identity from step 1.
- **Namespace**: `prod`.

RBAC walks:
1. **ClusterRoleBindings** — is there one that grants this verb+resource to this subject cluster-wide?
2. **RoleBindings in `prod`** — is there one that (a) references a Role or ClusterRole containing this verb+resource, and (b) has this subject in its `subjects` list?

If any matches → allow. Otherwise → deny.

Order-of-evaluation: RBAC is **additive-only**. There's no way to write a "deny" rule in vanilla RBAC. Denial happens by not matching any allow rule.

## `kubectl auth can-i` — the pre-check

Runs the exact same RBAC evaluation the API server would, without actually performing the action.

```bash
kubectl auth can-i list pods -n prod --as=system:serviceaccount:prod:my-app
```

Under the hood: sends a `SelfSubjectAccessReview` (or `SubjectAccessReview` if you use `--as`) to the API server. The response comes back `Allowed: true/false`, with `Reason` explaining the matching rule.

**Great for CI**: gate deploys on the fact that the SA has the permissions the workload needs.

## Aggregated ClusterRoles

Real clusters have many operators (Argo, cert-manager, Prometheus) that need permissions. Rather than modifying the built-in `admin` / `edit` / `view` ClusterRoles, operators contribute their own with a label like `rbac.authorization.k8s.io/aggregate-to-admin: "true"`.

The API server automatically aggregates any ClusterRole with that label into the `admin` ClusterRole's rules. Modular RBAC composition.

## Impersonation

Superusers can impersonate other identities:

```bash
kubectl get pods -n prod --as=alice --as-group=platform-team
```

Requires the caller to have `impersonate` verb on `users`, `groups`, `serviceaccounts` — usually cluster-admin.

## The `default` ServiceAccount — a footgun

Every namespace auto-creates a `default` SA. Any Pod without a `serviceAccountName` uses it.

If someone binds broad roles to `default` in a namespace (`kubectl create rolebinding default-admin --serviceaccount=default:default --clusterrole=cluster-admin`), every workload in that namespace inherits cluster-admin. Common attack vector post-compromise.

**Best practices:**
- Never modify permissions on `default` SAs.
- Use `automountServiceAccountToken: false` on the SA or Pod to prevent the token from being mounted (Pods that don't call the API don't need it).
- Kyverno/OPA policy: reject Pods with `serviceAccountName: default` in prod namespaces.

---

## The 30-second summary

- Job controller: watches Job spec, creates Pods until `completions` succeed or `backoffLimit` exhausted; TTL cleans up finished Jobs.
- CronJob: creates a Job at each firing; `concurrencyPolicy: Forbid` for non-idempotent workloads.
- Every Pod runs as a ServiceAccount; kubelet mounts a short-lived (1h) JWT at `/var/run/secrets/kubernetes.io/serviceaccount/token` since K8s 1.24.
- RBAC is additive — Roles + Bindings match verbs on resources for subjects. No "deny" rules.
- `kubectl auth can-i` runs the same evaluation as the API server — use it to pre-check permissions.
- Namespaces scope names + RBAC, NOT network. Cross-namespace traffic requires NetworkPolicies to gate.
