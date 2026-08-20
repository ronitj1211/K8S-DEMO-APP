# ServiceAccounts — Pod identity, RBAC and cloud federation

> **Related folder:** [jobs-rbac/](../jobs-rbac/) introduces ServiceAccount + Role + RoleBinding as part of a batch-jobs chapter. **This** folder is the identity deep dive: token mechanics, projected volumes and audiences, `automountServiceAccountToken`, IRSA/Workload Identity, and the RBAC escalation paths.
>
> Everything below was **verified on a live k3s v1.33 cluster** — the outputs are real, not illustrative.

---

# PART 1 — What it is

## The problem

A Pod sometimes needs to talk to the Kubernetes API — an operator reconciling CRDs, Prometheus discovering targets, a CI job patching a Deployment. The API server must answer two questions about every such call:

1. **Who are you?** → *authentication*
2. **Are you allowed to do this?** → *authorization*

Human users are authenticated by certificates or OIDC and **are not Kubernetes objects at all** — there is no `kind: User`. But a Pod needs an identity that *is* a cluster object, so it can be created, referenced and bound to permissions declaratively.

That object is the **ServiceAccount**.

```
   Pod ──runs as──▶ ServiceAccount ──named by──▶ RoleBinding ──▶ Role ──▶ permissions
        (identity)                    (grant)              (what's allowed)
```

**A ServiceAccount by itself grants nothing.** Creating one is not a security decision; *binding* it is. An unbound SA can authenticate successfully and then be refused on every single call — which is exactly what this project demonstrates.

---

# PART 2 — The terms

**ServiceAccount (SA)** — a namespaced object representing a non-human identity. Every Pod runs as one; if you don't name one, it's the namespace's `default` SA.

**`default` ServiceAccount** — auto-created in every namespace. It has **no permissions**, but by default its **token is still mounted into every Pod**. That mounted credential with no permissions is the thing most clusters get wrong.

**Subject** — the "who" in a binding. Three kinds: `ServiceAccount`, `User`, `Group`. Only ServiceAccounts are real objects.

**Username format** — an SA authenticates as `system:serviceaccount:<namespace>:<name>`. You'll see this exact string in every RBAC denial message.

**Role** — a list of allowed `(apiGroup, resource, verb)` rules, scoped to **one namespace**.

**ClusterRole** — the same, but cluster-scoped. Required for cluster-scoped resources (nodes, PVs, namespaces) and for granting the same access across all namespaces.

**RoleBinding** — attaches a Role *or a ClusterRole* to subjects, **within one namespace**.

**ClusterRoleBinding** — attaches a ClusterRole to subjects **across the whole cluster**.

> **The combination people miss:** a **RoleBinding referencing a ClusterRole** grants that ClusterRole's rules *only inside the binding's namespace*. That's how the built-in `view`/`edit`/`admin` roles get reused per team without being redefined.

**Default-deny and additive** — Kubernetes RBAC has **no deny rule**. Anything not explicitly allowed is refused, and multiple bindings simply union together. You cannot subtract a permission; you remove the binding that granted it.

**Verb** — an action: `get`, `list`, `watch`, `create`, `update`, `patch`, `delete`, `deletecollection`, plus the special `impersonate`, `escalate`, `bind`.

**Subresource** — a sub-path treated as its own resource in RBAC: `pods/log`, `pods/exec`, `pods/portforward`, `deployments/scale`. Granting `pods` does **not** grant `pods/log`.

**Token** — a signed JWT proving the caller is a given SA. The kubelet projects it into the Pod at `/var/run/secrets/kubernetes.io/serviceaccount/token`.

**Bound token** — a token carrying claims tying it to a specific Pod, node and SA UID. If the Pod is deleted, the token stops being valid. This is the modern default.

**Legacy token** — the pre-1.24 style: stored in a Secret, **never expires**, not bound to any Pod, and remains valid after the Pod is gone. Auto-creation was removed in 1.24.

**Audience (`aud`)** — who a token is *for*. A token minted for `vault` is rejected by the API server and vice versa. This is what stops a stolen token being replayed against a different service.

**`automountServiceAccountToken`** — a boolean on the **ServiceAccount** (a default for its Pods) or the **Pod** (an override). Set it to `false` for anything that doesn't call the API.

**TokenRequest API** — the mechanism that mints short-lived, audience-scoped, bound tokens on demand. It backs both projected volumes and `kubectl create token`.

**IRSA / Workload Identity** — federating a Kubernetes SA token to a *cloud* IAM identity, so a Pod gets AWS/GCP/Azure permissions with no cloud keys stored anywhere.

---

# PART 3 — How it works

## Diagram 1 — a request from Pod to API server

```
 ┌──────────────────────────── Pod ────────────────────────────┐
 │  serviceAccountName: sa-pod-reader                          │
 │                                                             │
 │  /var/run/secrets/kubernetes.io/serviceaccount/             │
 │      token       <- signed JWT, rotated by the kubelet      │
 │      ca.crt      <- CA to verify the API server             │
 │      namespace   <- this Pod's namespace, as a convenience  │
 │                                                             │
 │  code: Authorization: Bearer <token>                        │
 └───────────────────────────┬─────────────────────────────────┘
                             │ HTTPS to kubernetes.default.svc:443
                             ▼
 ┌───────────────────── kube-apiserver ────────────────────────┐
 │                                                             │
 │  1. AUTHENTICATION                                          │
 │     verify JWT signature, check exp, check aud              │
 │     ✗ fails -> 401 Unauthorized                             │
 │     ✓ -> identity = system:serviceaccount:identity:sa-pod-reader
 │                             │                               │
 │  2. AUTHORIZATION (RBAC)    ▼                               │
 │     any Role/ClusterRole bound to this subject allowing      │
 │     verb=list resource=pods in namespace=identity?           │
 │     ✗ none -> 403 Forbidden                                 │
 │     ✓ -> continue                                           │
 │                             │                               │
 │  3. ADMISSION               ▼                               │
 │     mutating + validating webhooks, quotas                  │
 │                             │                               │
 │  4. SERVE                   ▼   200 OK                      │
 └─────────────────────────────────────────────────────────────┘
```

**401 vs 403 is the diagnostic.** 401 means *no valid identity* — a missing or expired token. 403 means *identity fine, permission missing* — an RBAC problem. Live proof from this project:

| Deployment | Identity | `/api/pods` | `/api/secrets` | `/api/nodes` |
|---|---|---|---|---|
| `app-nothing` | `sa-nothing`, unbound | **403** | 403 | 403 |
| `app-pod-reader` | `sa-pod-reader` + Role | **200** (4 pods) | 403 | 403 |
| `app-cluster-viewer` | `sa-cluster-viewer` + ClusterRole | **200** | 403 | **200** (1 node) |
| `app-no-token` | token not mounted | **401** | 401 | 401 |

Note `app-nothing` gets **403, not 401** — its token is perfectly valid, it just has no permissions. And `app-pod-reader` is refused on `nodes` no matter what, because a namespaced **Role can never grant a cluster-scoped resource**.

## Diagram 2 — how the token gets into the Pod

```
 1. You set:  spec.serviceAccountName: sa-pod-reader
                          │
 2. Admission controller adds a projected volume to the Pod spec
    (unless automountServiceAccountToken is false)
                          │
 3. kubelet calls the TokenRequest API:
       POST /api/v1/namespaces/identity/serviceaccounts/sa-pod-reader/token
       { audiences: [<api server>], expirationSeconds: 3607,
         boundObjectRef: { kind: Pod, name: ..., uid: ... } }
                          │
 4. API server mints a signed JWT containing:
       sub: system:serviceaccount:identity:sa-pod-reader
       aud: [https://kubernetes.default.svc.cluster.local]
       exp / iat
       kubernetes.io: { namespace, pod{name,uid}, node{name,uid},
                        serviceaccount{name,uid}, warnafter }
                          │
 5. kubelet writes it into the Pod's projected volume, and REWRITES the
    file periodically — it rotates at ~80% of the intended lifetime
                          │
 6. Your code reads the file on every call (never caches it)
```

## The token-expiry detail almost every write-up gets wrong

Decoding a real kubelet-projected token from this cluster:

```
exp − iat        = 31,536,000 s   =  365 days
warnafter − iat  =       3,607 s   =  ~1 hour
```

The token is **bound and projected**, but its `exp` is a **year** away — not an hour. That's because the API server runs with `--service-account-extend-token-expiration=true` **by default**. It's a migration safety net for old clients that read the token once and cache it forever.

The **real** rotation deadline is the `warnafter` claim. Past that timestamp the API server records a metric (`serviceaccount_stale_tokens_total`) and an audit annotation flagging the client as using a stale token — while still accepting it.

So:
- **Don't** claim "the default token expires in an hour" — the `exp` doesn't.
- **Do** treat `warnafter` as the deadline and re-read the file on every use.
- An **explicitly declared** projected token with `expirationSeconds: 3600` gets exactly 3600s and **no** extension — verified: `exp − iat = 3600` with no `warnafter`.

## Diagram 3 — audiences keep tokens from being replayed

Same Pod, same ServiceAccount, two tokens that are **not interchangeable**:

```
 /var/run/secrets/kubernetes.io/serviceaccount/token
     aud: ["https://kubernetes.default.svc.cluster.local", "k3s"]
     └─▶ accepted by the API server
     └─▶ REJECTED by Vault

 /var/run/secrets/tokens/vault-token          (declared in the Pod spec)
     aud: ["vault"]
     └─▶ accepted by Vault (which verifies aud == "vault")
     └─▶ REJECTED by the API server
```

Both values above were read out of a running Pod — see [manifests/40-projected-token.yaml](manifests/40-projected-token.yaml).

## Diagram 4 — IRSA: a Kubernetes token becoming an AWS identity

```
 ┌─────────┐  1. SA annotated with eks.amazonaws.com/role-arn
 │   Pod   │
 │         │  2. EKS Pod Identity Webhook injects env vars +
 │  AWS    │     a projected token with audience sts.amazonaws.com
 │  SDK    │
 └────┬────┘  3. SDK reads AWS_WEB_IDENTITY_TOKEN_FILE
      │
      │ 4. sts:AssumeRoleWithWebIdentity(token, role-arn)
      ▼
 ┌──────────────┐  5. STS validates the JWT signature against the
 │  AWS STS     │     cluster's PUBLIC OIDC endpoint (registered as
 │              │     an IAM Identity Provider)
 │              │  6. checks the role's trust policy:
 │              │       sub == system:serviceaccount:identity:s3-reader
 │              │       aud == sts.amazonaws.com
 └──────┬───────┘
        │ 7. temporary AWS credentials (~1h, auto-refreshed)
        ▼
    S3 / DynamoDB / SQS …
```

**No AWS access key exists anywhere** — not in a Secret, not in an env var, not on the node. The trust is: *AWS trusts this cluster's OIDC issuer, and the role's trust policy names exactly one namespace/serviceaccount pair.* Details and the GKE/Azure equivalents in [IRSA.md](IRSA.md).

---

# PART 4 — How to configure it, and in which file

| What you're configuring | Object | File | Field |
|---|---|---|---|
| Create an identity | ServiceAccount | [10-serviceaccounts.yaml](manifests/10-serviceaccounts.yaml) | `metadata.name` |
| Make a Pod use it | Deployment/Pod | [30-workload.yaml](manifests/30-workload.yaml) | `spec.template.spec.serviceAccountName` |
| Stop mounting a token (SA-wide) | ServiceAccount | [10-serviceaccounts.yaml](manifests/10-serviceaccounts.yaml) | `automountServiceAccountToken: false` |
| Stop mounting a token (one Pod) | Deployment/Pod | [30-workload.yaml](manifests/30-workload.yaml) | `spec.template.spec.automountServiceAccountToken: false` |
| Namespaced permissions | Role + RoleBinding | [20-role-rolebinding.yaml](manifests/20-role-rolebinding.yaml) | `rules`, `subjects`, `roleRef` |
| Cluster-wide permissions | ClusterRole + ClusterRoleBinding | [21-clusterrole-binding.yaml](manifests/21-clusterrole-binding.yaml) | `rules`, `subjects`, `roleRef` |
| Reuse a built-in role per namespace | RoleBinding → ClusterRole | [20-role-rolebinding.yaml](manifests/20-role-rolebinding.yaml) | `roleRef.kind: ClusterRole` |
| Custom audience / expiry | Pod | [40-projected-token.yaml](manifests/40-projected-token.yaml) | `spec.volumes[].projected.sources[].serviceAccountToken` |
| Registry credentials for all its Pods | ServiceAccount | [10-serviceaccounts.yaml](manifests/10-serviceaccounts.yaml) | `imagePullSecrets` |
| Long-lived token (last resort) | Secret | [50-legacy-token-secret.yaml](manifests/50-legacy-token-secret.yaml) | `type: kubernetes.io/service-account-token` |
| AWS IAM role for a Pod | ServiceAccount | [60-irsa-eks.yaml](manifests/60-irsa-eks.yaml) | `metadata.annotations["eks.amazonaws.com/role-arn"]` |

**Two placement rules that trip people up:**

1. `serviceAccountName` goes on the **Pod spec** — `spec.template.spec`, *not* under `containers`, and not on the Deployment itself.
2. A `RoleBinding`'s `subjects[].namespace` is **required** for ServiceAccount subjects, even when the binding is in that same namespace.

---

## What's in this folder

| Path | Purpose |
|---|---|
| [app/server.js](app/server.js) | Pod that decodes its own token (`/whoami`), calls the API (`/api/*`), and asks what it may do (`/canido`) |
| [manifests/10-serviceaccounts.yaml](manifests/10-serviceaccounts.yaml) | Five SAs: unbound, namespaced, cluster-wide, no-token, with pull secrets |
| [manifests/20-role-rolebinding.yaml](manifests/20-role-rolebinding.yaml) | Role + RoleBinding, and RoleBinding→ClusterRole |
| [manifests/21-clusterrole-binding.yaml](manifests/21-clusterrole-binding.yaml) | ClusterRole + ClusterRoleBinding |
| [manifests/22-default-clusterroles.md](manifests/22-default-clusterroles.md) | `view`/`edit`/`admin`/`cluster-admin` and role aggregation |
| [manifests/30-workload.yaml](manifests/30-workload.yaml) | Four Deployments of one image, differing only in identity |
| [manifests/40-projected-token.yaml](manifests/40-projected-token.yaml) | Explicit audience + expiry |
| [manifests/50-legacy-token-secret.yaml](manifests/50-legacy-token-secret.yaml) | The pre-1.24 pattern and when it's still justified |
| [manifests/60-irsa-eks.yaml](manifests/60-irsa-eks.yaml) | IRSA annotation and what the webhook injects |
| [manifests/70-danger-escalation.yaml](manifests/70-danger-escalation.yaml) | Five escalation paths, with the reasoning for each |

| Doc | Contents |
|---|---|
| [TOKENS.md](TOKENS.md) | Token mechanics: decode a real JWT, rotation, `kubectl create token`, building a kubeconfig |
| [IRSA.md](IRSA.md) | AWS IRSA + EKS Pod Identity, GKE Workload Identity, Azure Workload Identity |
| [RUN-STEPS.md](RUN-STEPS.md) | Hands-on walkthrough with real observed output |
| [INTERVIEW.md](INTERVIEW.md) | 42 Q&A with scenarios |

---

## The security checklist

1. **Set `automountServiceAccountToken: false`** on every workload that doesn't call the API — which is most of them. A mounted token is a credential an attacker reads first after RCE.
2. **Never use the `default` SA** for anything. Give each workload its own, so permissions and audit trails are per-workload.
3. **One SA per workload**, least privilege, namespaced `Role` unless the resource is genuinely cluster-scoped.
4. **No wildcards** in `apiGroups`, `resources` or `verbs` — a wildcard silently grants access to every CRD installed later.
5. **Treat `get secrets` as admin-equivalent.** Secrets hold other identities' tokens, so reading them is a path to becoming them.
6. **Treat `create pods` as namespace-admin.** You can set any `serviceAccountName` and read that token.
7. **Prefer federation over tokens** — IRSA/Workload Identity means no long-lived credential exists to steal.
8. **Audit regularly:** `kubectl auth can-i --list --as=system:serviceaccount:ns:name`.
