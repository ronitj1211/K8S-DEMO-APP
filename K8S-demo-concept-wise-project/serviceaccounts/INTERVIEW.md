# Interview Q&A — ServiceAccounts, RBAC & workload identity

42 questions with scenarios. Answers verified against a live k3s v1.33 cluster where the behaviour was testable.

---

## Basics

**Q1. What is a ServiceAccount?**
A namespaced Kubernetes object representing a **non-human identity**. Every Pod runs as one, and it's the identity the API server authenticates when that Pod makes a call.

*Scenario:* A Prometheus Pod needs to list Pods across the cluster to discover scrape targets. It runs as a `prometheus` ServiceAccount bound to a ClusterRole granting `list`/`watch` on pods, nodes and endpoints. Without that identity it couldn't discover anything.

**Q2. ServiceAccount vs User?**
A **ServiceAccount is a real API object** you can create, list and bind. A **User is not an object at all** — there is no `kind: User`. Users come from outside: client certificates, OIDC, or an authenticating proxy. That's why you can `kubectl create serviceaccount` but never `kubectl create user`.

**Q3. What happens if you don't set `serviceAccountName`?**
The Pod runs as the namespace's `default` ServiceAccount, which has **no permissions** — but whose **token is still mounted**. So you get a useless credential sitting in the container for an attacker to find.

**Q4. How does a Pod actually authenticate?**
The kubelet projects a signed JWT to `/var/run/secrets/kubernetes.io/serviceaccount/token`. Code sends it as `Authorization: Bearer <token>`. The API server verifies the signature and `aud`, then treats the caller as `system:serviceaccount:<namespace>:<name>`.

*Scenario:* Nothing about this is SDK-specific — `wget --header="Authorization: Bearer $(cat .../token)" https://kubernetes.default.svc/api/v1/pods` works from a shell. Which is exactly why mounting a token is a real risk.

**Q5. What's the username format for an SA?**
`system:serviceaccount:<namespace>:<name>`. It appears verbatim in every RBAC denial, and it's the string you pin in an IRSA trust policy.

**Q6. What are the three files mounted with a token?**
`token` (the JWT), `ca.crt` (to verify the API server rather than skipping TLS verification), and `namespace` (this Pod's namespace, as a convenience).

---

## RBAC

**Q7. Role vs ClusterRole?**
Both are lists of `(apiGroup, resource, verb)` rules. A **Role** is namespaced; a **ClusterRole** is cluster-scoped. You need a ClusterRole for cluster-scoped resources (nodes, PVs, namespaces, CRDs) or to grant the same access in every namespace.

**Q8. RoleBinding vs ClusterRoleBinding?**
A **RoleBinding** grants within one namespace. A **ClusterRoleBinding** grants across the whole cluster.

**Q9. Can a RoleBinding reference a ClusterRole?**
Yes — and it's the most useful combination. The ClusterRole's rules apply **only inside the binding's namespace**. That's how the built-in `view`/`edit`/`admin` roles are reused per team without redefining them.

*Scenario:* `kubectl create rolebinding team-a-edit --clusterrole=edit --serviceaccount=team-a:deployer -n team-a` gives that SA edit rights in `team-a` and nowhere else. One ClusterRole, twenty namespaces, no duplication.

**Q10. Can a ClusterRoleBinding reference a Role?**
No. It would be meaningless — a namespaced Role can't be applied cluster-wide. The API rejects it.

**Q11. Is there a deny rule in Kubernetes RBAC?**
**No.** RBAC is purely **additive** and **default-deny**: anything not explicitly allowed is refused, and multiple bindings union together. You cannot subtract a permission — you remove the binding that granted it.

*Scenario:* "Give them edit but not delete on Secrets" is impossible with a single deny. You must build a custom Role enumerating exactly the verbs you want, instead of `edit` minus something.

**Q12. Difference between 401 and 403?**
**401 Unauthorized** = no valid identity (missing, expired or wrong-audience token) — *authentication* failed. **403 Forbidden** = identity is fine but no rule allows the action — *authorization* failed.

*Scenario (verified live):* a Pod with `automountServiceAccountToken: false` gets **401** on every call. A Pod with a valid token but no RoleBinding gets **403**. Same image, same cluster — the status code tells you whether to fix the token or the RBAC.

**Q13. Why does my SA get 403 on nodes even though I added nodes to its Role?**
Because `nodes` are **cluster-scoped** and a Role is namespaced. A Role can never grant a cluster-scoped resource, whatever its rules say. You need a ClusterRole + ClusterRoleBinding.

**Q14. Why does `get pods` work but `kubectl logs` fail?**
`pods/log` is a **subresource** and a separate RBAC entry. Add it explicitly:
```yaml
resources: ["pods", "pods/log"]
```
Same for `pods/exec`, `pods/portforward`, `deployments/scale`.

**Q15. What are the built-in ClusterRoles?**
`view` (read-only, **excludes secrets**), `edit` (view + manage workloads, cannot touch RBAC), `admin` (edit + manage RBAC *within a namespace*), `cluster-admin` (everything).

**Q16. Why does `view` exclude Secrets?**
Because reading a Secret means holding the credential inside it — including other ServiceAccounts' tokens. If `view` included secrets, "read-only" would be a privilege-escalation path.

*Scenario (verified live):* an SA bound to `view` still gets 403 on `/api/v1/namespaces/x/secrets`. People assume `view` is harmless and are surprised it's *deliberately* narrower than "read everything".

**Q17. What is an aggregated ClusterRole?**
`view`/`edit`/`admin` have their rules **assembled by a controller** from any ClusterRole carrying a label like `rbac.authorization.k8s.io/aggregate-to-view: "true"`. That's how an operator adds its CRD to `view` without anyone editing `view`. Never edit those roles directly — the controller overwrites you.

**Q18. What do the `escalate` and `bind` verbs do?**
They disable RBAC's **privilege-escalation prevention**. Normally you can't grant permissions you don't hold. `escalate` lets you create a Role exceeding your own rights; `bind` lets you bind a Role you don't hold. Together they're indirect cluster-admin.

**Q19. What does `impersonate` allow?**
Acting as another user, group or ServiceAccount — this is what `kubectl --as` uses. Granting it is equivalent to granting every identity it can impersonate, so `impersonate` on `*` is cluster-admin.

**Q20. How do you check what an identity can do?**
```bash
kubectl auth can-i --list --as=system:serviceaccount:ns:name -n ns
kubectl auth can-i get secrets --as=system:serviceaccount:ns:name -n ns
kubectl auth whoami
```
From *inside* a Pod with no admin rights, use **SelfSubjectRulesReview** — that's what `--list` calls under the hood.

---

## Tokens

**Q21. Bound token vs legacy token?**
A **bound** token carries `kubernetes.io` claims naming the Pod, node and SA UID, has an expiry, and is auto-rotated by the kubelet — delete the Pod and it stops working. A **legacy** token lived in a Secret, **never expired**, was bound to nothing, and stayed valid after the SA was deleted.

**Q22. What changed in Kubernetes 1.24?**
Auto-creation of token Secrets was **removed** (KEP-1205). Creating an SA no longer creates a never-expiring credential.

*Scenario (verified live on 1.33):* `kubectl get sa -n identity` shows `SECRETS 0` for every account. On 1.23 each would show `1`. That single column is the whole change.

**Q23. How long does a projected token last?**
**Careful — this is where most answers are wrong.** The `exp` on a kubelet-projected token is often **a year** away, because the API server defaults to `--service-account-extend-token-expiration=true`. The *intended* lifetime is the **`warnafter`** claim (~1 hour); past it the API server increments `serviceaccount_stale_tokens_total` and adds an audit annotation while still accepting the token.

*Scenario (measured live):* `exp − iat = 31,536,000s` (365 days) but `warnafter − iat = 3,607s` (~1 hour). A token declared explicitly with `expirationSeconds: 3600` got exactly 3600s and **no** `warnafter` — the extension applies only to kubelet-managed tokens. The extension is a migration aid for clients that cache tokens forever.

**Q24. So how should code handle the token?**
**Re-read the file on every request.** The kubelet rewrites it at ~80% of the intended lifetime. Caching at startup works fine — until it silently doesn't, hours later, in production.

**Q25. What is the `aud` claim for?**
It names who the token is *for*. A token minted for `vault` is rejected by the API server and vice versa, so a stolen token can't be replayed against a different service.

*Scenario (verified live):* one Pod, one SA, two tokens — the default at `aud: ["https://kubernetes.default.svc.cluster.local", "k3s"]` and a declared one at `aud: ["vault"]`. Not interchangeable. That's what bounds the blast radius of a leak.

**Q26. What is the TokenRequest API?**
The API that mints short-lived, audience-scoped, optionally Pod-bound tokens on demand. It backs projected volumes and `kubectl create token`.

**Q27. How do you get a token for a script or CI?**
```bash
kubectl create token my-sa -n my-ns --duration=1h
```
Mint one per run. Don't store a long-lived token in a CI secret store; better still, federate CI to the cluster via OIDC so no token is stored at all.

**Q28. When is a legacy token Secret still justified?**
Only when an external client genuinely cannot call the TokenRequest API. Prefer, in order: workload identity federation → `kubectl create token` → a manual token Secret that is audited and rotated.

**Q29. What's `automountServiceAccountToken` and where do you set it?**
A boolean on the **ServiceAccount** (default for its Pods) or the **Pod** (overrides the SA). Set `false` for anything that doesn't call the API — which is most workloads.

*Scenario (verified live):* with it false, the mount directory is **completely empty** and every API call returns 401. There is no credential in the container to steal.

**Q30. What are the `..data` and timestamped entries in the token directory?**
The projected-volume **atomic update** mechanism. The kubelet writes a new timestamped directory and flips the `..data` symlink, so a reader never observes a partially written token.

---

## Cloud identity

**Q31. What is IRSA?**
IAM Roles for Service Accounts — a Pod exchanges its Kubernetes SA token for **temporary AWS credentials** via `sts:AssumeRoleWithWebIdentity`, with **no AWS keys stored anywhere**.

**Q32. Walk through the IRSA flow.**
EKS publishes a public OIDC discovery endpoint → you register it as an IAM OIDC provider → an IAM role's trust policy pins one `namespace/serviceaccount` → you annotate the SA with the role ARN → the **Pod Identity Webhook** injects `AWS_ROLE_ARN`, `AWS_WEB_IDENTITY_TOKEN_FILE` and a projected token with audience `sts.amazonaws.com` → the AWS SDK calls STS → STS verifies the JWT against the cluster's **public** keys and checks the trust policy → temporary credentials come back and the SDK refreshes them.

**Q33. Why is IRSA better than a node instance profile?**
A node role is inherited by **every Pod on that node**, so it becomes the union of everything any Pod needs — no per-workload separation and no meaningful least privilege. IRSA scopes permissions to one ServiceAccount.

**Q34. What's the most common IRSA misconfiguration?**
A wildcard in the trust policy's `:sub` condition. `StringLike` with `system:serviceaccount:*:*` lets **any** SA in the cluster assume the role. Always `StringEquals` on the exact `system:serviceaccount:<ns>:<sa>`, and always constrain `:aud`.

**Q35. IRSA vs EKS Pod Identity?**
IRSA configures trust on the **IAM role** and needs a per-cluster OIDC provider; it works on any OIDC-capable cluster. **Pod Identity** (2023+) configures trust via an EKS **PodIdentityAssociation**, needs no OIDC provider, needs no SA annotation, and makes roles far easier to reuse across clusters — but is EKS-only.

**Q36. How do you debug "the SDK says AccessDenied"?**
1. `kubectl describe pod` — are the `AWS_*` env vars present? If not, the webhook didn't mutate the Pod (annotation typo, or the Pod predates the annotation).
2. Decode the token at `/var/run/secrets/eks.amazonaws.com/serviceaccount/token` — is `aud` `sts.amazonaws.com`?
3. `aws sts get-caller-identity` from inside the Pod.
4. Compare the trust policy's `:sub` against the actual `system:serviceaccount:<ns>:<sa>`.
5. Check egress to STS — a private subnet with no NAT and no STS VPC endpoint fails with a DNS error, which looks like an auth problem but isn't.

**Q37. GKE and Azure equivalents?**
**GKE Workload Identity** — annotate with `iam.gke.io/gcp-service-account`, bind `roles/iam.workloadIdentityUser` to `PROJECT.svc.id.goog[ns/ksa]`. **Azure Workload Identity** — annotate with `azure.workload.identity/client-id` *and* label the Pod `azure.workload.identity/use: "true"`, backed by a federated identity credential. Same shape: public OIDC issuer, a policy pinning one namespace/SA, a token exchanged for short-lived cloud credentials.

---

## Security & scenarios

**Q38. Why is `get secrets` effectively admin?**
Secrets contain database passwords, API keys — and other ServiceAccounts' tokens. Reading them lets you **become** those identities. It's an escalation primitive, not a read.

**Q39. Why is `create pods` close to namespace-admin?**
Because you can set `serviceAccountName` to **any** SA in the namespace and read its token from inside your Pod. Add `pods/exec` and you can read the token of any *running* Pod. So "can create pods" implicitly grants every identity in that namespace.

**Q40. An attacker gets RCE in your container. What do they do first, and how do you limit it?**
They read `/var/run/secrets/kubernetes.io/serviceaccount/token` and start probing the API. Mitigations, in order of impact: `automountServiceAccountToken: false` (nothing to steal); a dedicated SA with least privilege; no `get secrets`; NetworkPolicy blocking egress to the API server; audit logging on the SA's activity; short token lifetimes so a copied token dies quickly.

**Q41. How would you audit ServiceAccount permissions across a cluster?**

> Start with the worst case and work down.
> ```bash
> # who has cluster-admin?
> kubectl get clusterrolebindings -o json | jq -r '
>   .items[] | select(.roleRef.name=="cluster-admin") |
>   .metadata.name as $n | (.subjects // [])[] |
>   "\($n) -> \(.kind)/\(.namespace // "")/\(.name)"'
>
> # wildcards anywhere
> kubectl get clusterroles -o json | jq -r '
>   .items[] | select(.rules[]? | (.verbs[]?=="*") and (.resources[]?=="*")) | .metadata.name'
>
> # who can read secrets
> kubectl auth can-i get secrets --as=system:serviceaccount:ns:sa -A
>
> # which Pods still mount a token
> kubectl get pods -A -o json | jq -r '.items[] |
>   select(.spec.automountServiceAccountToken != false) |
>   "\(.metadata.namespace)/\(.metadata.name)"'
> ```
> Then I'd feed that into policy: a Kyverno/OPA rule requiring `automountServiceAccountToken: false` unless a workload is explicitly annotated as needing API access, and a CI check failing any PR that introduces a wildcard rule or a `cluster-admin` binding. Point-in-time audits rot; admission control doesn't.

**Q42. Design API access for a new operator that manages a CRD in all namespaces.**

> - **Dedicated ServiceAccount** in the operator's own namespace — never `default`, never shared.
> - **ClusterRole**, because it genuinely needs all namespaces, with rules enumerated exactly: full verbs on its **own CRD** and its `/status` subresource; only the verbs it truly needs on the resources it creates (say `get,list,watch,create,update,patch` on Deployments); `get,list,watch` on ConfigMaps; **`create` only** on Events. No `secrets` unless the feature demands it, and if so scoped by name where possible.
> - **ClusterRoleBinding** naming just that SA.
> - **Leader election** needs `create,get,update` on `coordination.k8s.io/leases` — scoped to its own namespace with a plain Role, not cluster-wide.
> - **No wildcards**, so a future CRD install doesn't silently widen its access.
> - **`automountServiceAccountToken: true`** here — this is one of the few workloads that genuinely needs a token.
> - Verify before shipping: `kubectl auth can-i --list --as=system:serviceaccount:op-ns:op-sa`, and confirm it *cannot* read secrets or create ClusterRoleBindings.
> - If it also touches AWS, add **IRSA** rather than mounting keys.
