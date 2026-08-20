# Run Steps — ServiceAccounts lab

Nine experiments. **All output below is real** — captured from a live k3s v1.33 cluster while writing this.

---

## 1. Build and deploy

```bash
cd K8S-demo-concept-wise-project/serviceaccounts/app
docker build -t identity-lab:1.0 .

cd ..
kubectl apply -f manifests/00-namespace.yaml
kubectl apply -f manifests/10-serviceaccounts.yaml
kubectl apply -f manifests/20-role-rolebinding.yaml
kubectl apply -f manifests/21-clusterrole-binding.yaml
kubectl apply -f manifests/30-workload.yaml

kubectl get pods -n identity -o custom-columns=\
NAME:.metadata.name,STATUS:.status.phase,SA:.spec.serviceAccountName
```

```
NAME                                  STATUS    SA
app-cluster-viewer-6985df68fc-v2k9k   Running   sa-cluster-viewer
app-no-token-6bc94c46f9-c2jmf         Running   sa-nothing
app-nothing-df4dc85fc-9ml5f           Running   sa-nothing
app-pod-reader-5568b8cc8c-mxgzf       Running   sa-pod-reader
```

Four Deployments, **one image**, differing only in identity.

---

## 2. Confirm no token Secrets are auto-created

```bash
kubectl get sa -n identity
```

```
NAME                  SECRETS   AGE
default               0         1s
sa-cluster-viewer     0         1s
sa-no-token           0         1s
sa-nothing            0         1s
sa-pod-reader         0         1s
```

**`SECRETS 0` everywhere.** On Kubernetes ≤1.23 each of these would have had `1` — an auto-created, never-expiring token Secret. That auto-creation was removed in 1.24. This one column is the whole pre/post-1.24 story.

---

## 3. Inspect the identity from inside a Pod

```bash
kubectl exec -n identity deploy/app-pod-reader -- wget -qO- localhost:3000/whoami | python3 -m json.tool
```

Real output (trimmed):

```json
{
  "token_mounted": true,
  "namespace": "identity",
  "ca_mounted": true,
  "files_present": ["..2026_08_20_08_04_01.3471764780", "..data", "ca.crt", "namespace", "token"],
  "token_bytes": 1193,
  "claims": {
    "sub": "system:serviceaccount:identity:sa-pod-reader",
    "aud": ["https://kubernetes.default.svc.cluster.local", "k3s"],
    "expires_in_hours": 8759.99,
    "bound_object": {
      "namespace": "identity",
      "node": { "name": "colima", "uid": "d60a8ea4-..." },
      "pod":  { "name": "app-pod-reader-5568b8cc8c-mxgzf", "uid": "c7039e2a-..." },
      "serviceaccount": { "name": "sa-pod-reader", "uid": "c044119a-..." },
      "warnafter": 1787216648
    }
  },
  "token_type": "bound + projected, expiry EXTENDED by the API server",
  "intended_lifetime": {
    "warnafter_seconds_after_issue": 3607,
    "actual_exp_seconds_after_issue": 31536000
  }
}
```

Three things to notice:

1. **`sub` is the RBAC identity** — `system:serviceaccount:identity:sa-pod-reader`. This exact string appears in every denial message.
2. **`bound_object` proves it's a bound token** — it names this Pod and node. Delete the Pod and the token is dead.
3. **`expires_in_hours: 8759.99`** — that's **a year**, not an hour. But `warnafter` is 3607s (~1h) after issue. The API server defaults to `--service-account-extend-token-expiration=true`, so `exp` is a migration safety net while `warnafter` is the real rotation deadline. Most write-ups get this wrong; see [TOKENS.md](TOKENS.md).

The `..data` entry in `files_present` is the projected-volume atomic-update symlink — the kubelet writes a new timestamped directory and flips the link, so readers never see a partial file.

---

## 4. The main experiment — same image, four identities

```bash
for dep in app-nothing app-pod-reader app-cluster-viewer app-no-token; do
  echo "## $dep"
  for ep in pods secrets nodes; do
    printf "  /api/%-8s -> " "$ep"
    kubectl exec -n identity deploy/$dep -- wget -qO- "localhost:3000/api/$ep" 2>/dev/null \
      | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['verdict'])"
  done
done
```

Real results:

| Deployment | Identity | `/api/pods` | `/api/secrets` | `/api/nodes` |
|---|---|---|---|---|
| `app-nothing` | `sa-nothing` (no bindings) | **403** | 403 | 403 |
| `app-pod-reader` | `sa-pod-reader` + Role | **200** (4 pods) | 403 | 403 |
| `app-cluster-viewer` | `sa-cluster-viewer` + ClusterRole | **200** | 403 | **200** (1 node) |
| `app-no-token` | no token mounted | **401** | 401 | 401 |

**Four lessons in one table:**

1. **401 ≠ 403.** `app-no-token` gets **401 Unauthorized** — there's no identity at all. `app-nothing` gets **403 Forbidden** — its token is perfectly valid, it just has zero permissions. Authentication and authorization are separate steps, and the status code tells you which one failed.

2. **A Role can never grant a cluster-scoped resource.** `sa-pod-reader` is refused on `/api/nodes` no matter what rules the Role contains — nodes are cluster-scoped, so only a ClusterRole + ClusterRoleBinding can grant them.

3. **`view` excludes secrets.** `sa-pod-reader` is also bound to the built-in `view` ClusterRole via a RoleBinding, and *still* gets 403 on secrets. That's deliberate: reading a Secret means holding the credential inside it, so it would be an escalation path, not a read.

4. **The denial message names the exact identity and verb:**
   ```
   secrets is forbidden: User "system:serviceaccount:identity:sa-pod-reader"
   cannot list resource "secrets" in API group "" in the namespace "identity"
   ```
   Always read this string — it tells you the subject, verb, resource, apiGroup and namespace to add.

---

## 5. What does this identity think it can do?

```bash
kubectl exec -n identity deploy/app-pod-reader -- wget -qO- localhost:3000/canido | python3 -m json.tool
```

This calls **SelfSubjectRulesReview** — the same API behind `kubectl auth can-i --list`. The key property: a Pod can ask *about itself* with no special privileges. Compare with the admin-side view, which needs impersonation rights:

```bash
kubectl auth can-i --list --as=system:serviceaccount:identity:sa-pod-reader -n identity
kubectl auth can-i get pods    --as=system:serviceaccount:identity:sa-pod-reader -n identity   # yes
kubectl auth can-i get secrets --as=system:serviceaccount:identity:sa-pod-reader -n identity   # no
```

---

## 6. Two tokens, two audiences, one Pod

```bash
kubectl apply -f manifests/40-projected-token.yaml

decode() { cut -d. -f2 | python3 -c "import sys,base64,json; d=json.loads(base64.urlsafe_b64decode(sys.stdin.read().strip()+'==')); print('aud:',d['aud'],' lifetime:',d['exp']-d['iat'],'s')"; }

kubectl exec -n identity pod-custom-token -- cat /var/run/secrets/kubernetes.io/serviceaccount/token | decode
kubectl exec -n identity pod-custom-token -- cat /var/run/secrets/tokens/vault-token | decode
```

Real output:

```
aud: ['https://kubernetes.default.svc.cluster.local', 'k3s']   lifetime: 31536000 s
aud: ['vault']                                                 lifetime: 3600 s
```

Same Pod, same ServiceAccount, **two non-interchangeable tokens**. The `vault` token is rejected by the API server; the API-server token is rejected by Vault. And note the explicitly declared token got **exactly** its requested 3600s with **no extension** — the year-long `exp` only applies to kubelet-managed tokens.

That audience check is what limits the blast radius of a leaked token to a single service.

---

## 7. Prove the token is the credential

```bash
# with the token -> works
kubectl exec -n identity deploy/app-pod-reader -- sh -c '
  TOKEN=$(cat /var/run/secrets/kubernetes.io/serviceaccount/token)
  wget -qO- --no-check-certificate --header="Authorization: Bearer $TOKEN" \
    https://kubernetes.default.svc/api/v1/namespaces/identity/pods 2>&1 | head -c 120'

# without it -> 401
kubectl exec -n identity deploy/app-pod-reader -- sh -c '
  wget -qO- --no-check-certificate \
    https://kubernetes.default.svc/api/v1/namespaces/identity/pods 2>&1 | head -c 200'
```

There's nothing magic about the SDK — it's one HTTP header. Which is exactly why a mounted token is a credential an attacker reads first.

---

## 8. Turn the token off

```bash
kubectl exec -n identity deploy/app-no-token -- wget -qO- localhost:3000/whoami | python3 -m json.tool
```

```json
{
  "token_mounted": false,
  "note": "No token at /var/run/secrets/kubernetes.io/serviceaccount. Either automountServiceAccountToken is false ...",
  "files_present": []
}
```

The directory is **empty**. Nothing to steal.

Two places to set it — the Pod-level value wins:

```yaml
# ServiceAccount-level: default for every Pod using this SA
automountServiceAccountToken: false

# Pod-level: overrides the SA
spec:
  automountServiceAccountToken: false
```

Find workloads that don't need theirs:

```bash
kubectl get pods -A -o json | python3 -c "
import json,sys
for p in json.load(sys.stdin)['items']:
    if p['spec'].get('automountServiceAccountToken') is not False:
        print(p['metadata']['namespace'], p['metadata']['name'])
" | head
```

---

## 9. See the escalation paths

> Throwaway clusters only. Read the comments in [manifests/70-danger-escalation.yaml](manifests/70-danger-escalation.yaml) rather than applying it in anything real.

```bash
kubectl apply -f manifests/70-danger-escalation.yaml     # only if you can throw the cluster away
kubectl exec -n identity deploy/app-nothing -- wget -qO- localhost:3000/api/secrets
```

`sa-nothing` now reads every Secret in the cluster — including **other ServiceAccounts' tokens**, which means it can *become* those identities. That's the point: `get secrets` is not "read-only", it's an escalation primitive.

The same applies to `create pods`: you can set `serviceAccountName` to any SA in the namespace and read its token. Pod-create is far closer to namespace-admin than it looks.

```bash
kubectl delete -f manifests/70-danger-escalation.yaml
```

---

## 10. Cleanup

```bash
kubectl delete -f manifests/ --ignore-not-found
kubectl delete ns identity --ignore-not-found
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `401 Unauthorized` | No token, expired token, or wrong audience | Check `automountServiceAccountToken`; decode the token's `aud` |
| `403 Forbidden` | Authenticated but no matching rule | Read the message — it names subject/verb/resource; add a binding |
| 403 on a cluster-scoped resource despite a Role | Roles are namespaced | Use ClusterRole + ClusterRoleBinding |
| 403 on `pods/log` while `pods` works | Subresources are separate | Add `pods/log` to `resources` |
| `SECRETS 0` on every SA | Correct on 1.24+ | Use `kubectl create token` |
| Token works then fails hours later | Client cached the token; kubelet rotated the file | Re-read the file on every request |
| RoleBinding has no effect | `subjects[].namespace` missing for an SA | It's required, even in the same namespace |
| IRSA: no `AWS_*` env vars | Webhook didn't mutate — annotation typo or Pod predates it | Fix the annotation, recreate the Pod |
| IRSA: `AccessDenied` on AssumeRole | Trust policy `sub` doesn't match | Pin `system:serviceaccount:<ns>:<sa>` exactly |
