# The four built-in ClusterRoles

Kubernetes ships these. Bind them instead of writing your own for common cases:

| ClusterRole | Grants | Use for |
|---|---|---|
| `view` | read-only on most namespaced resources — **but NOT secrets** | read-only dashboards, auditors |
| `edit` | `view` + create/update/delete workloads; **cannot** touch RBAC or quotas | developers in their own namespace |
| `admin` | `edit` + manage Roles/RoleBindings **within the namespace** | team leads owning a namespace |
| `cluster-admin` | everything, everywhere, no restrictions | break-glass only |

Inspect any of them:

```bash
kubectl describe clusterrole view
kubectl get clusterrole view -o yaml
```

**Why `view` excludes secrets:** reading a Secret is equivalent to holding the
credential inside it. If `view` included secrets, "read-only" access would let
someone extract database passwords and other ServiceAccount tokens — which is
a privilege-escalation path, not a read.

**Bind them per-namespace with a RoleBinding**, not cluster-wide:

```bash
# team-a gets edit rights ONLY in namespace team-a
kubectl create rolebinding team-a-edit \
  --clusterrole=edit --serviceaccount=team-a:deployer -n team-a
```

## Aggregated ClusterRoles

`view`, `edit` and `admin` are **aggregated** — their `rules` are assembled by
the controller manager from any ClusterRole carrying the right label. That's
how a CRD can add itself to `view` without anyone editing `view`:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: my-crd-viewer
  labels:
    rbac.authorization.k8s.io/aggregate-to-view: "true"   # <- the magic label
rules:
  - apiGroups: ["mycompany.io"]
    resources: ["widgets"]
    verbs: ["get", "list", "watch"]
```

Never edit `view`/`edit`/`admin` directly — the aggregation controller
overwrites your changes.
