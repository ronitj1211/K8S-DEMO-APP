# Tokens — the mechanics

Everything here was run against a live k3s v1.33 cluster; the outputs are real.

---

## What the kubelet mounts

Every Pod with a token gets three files:

```bash
kubectl exec -n identity deploy/app-pod-reader -- ls -la /var/run/secrets/kubernetes.io/serviceaccount/
```

| File | Contents | Why |
|---|---|---|
| `token` | the signed JWT | proves who you are |
| `ca.crt` | the cluster CA | lets you *verify the API server* rather than using `--insecure` |
| `namespace` | this Pod's namespace | convenience, so code needn't guess |

Alongside them you'll see `..data` and a timestamped directory — that's the **atomic-update mechanism** of projected volumes. The kubelet writes a new timestamped dir and flips the `..data` symlink, so a reader never sees a half-written file.

Kubernetes also injects these env vars into every Pod, so no address needs configuring:

```
KUBERNETES_SERVICE_HOST=10.43.0.1
KUBERNETES_SERVICE_PORT=443
```

---

## Decoding a real token

```bash
kubectl exec -n identity deploy/app-pod-reader -- \
  cat /var/run/secrets/kubernetes.io/serviceaccount/token \
  | cut -d. -f2 | base64 -d 2>/dev/null | python3 -m json.tool
```

Actual output from this cluster:

```json
{
  "aud": ["https://kubernetes.default.svc.cluster.local", "k3s"],
  "exp": 1818749041,
  "iat": 1787213041,
  "iss": "https://kubernetes.default.svc.cluster.local",
  "sub": "system:serviceaccount:identity:sa-pod-reader",
  "kubernetes.io": {
    "namespace": "identity",
    "node":           { "name": "colima", "uid": "d60a8ea4-..." },
    "pod":            { "name": "app-pod-reader-5568b8cc8c-mxgzf", "uid": "c7039e2a-..." },
    "serviceaccount": { "name": "sa-pod-reader", "uid": "c044119a-..." },
    "warnafter": 1787216648
  }
}
```

| Claim | Meaning |
|---|---|
| `sub` | the identity string RBAC matches on — `system:serviceaccount:<ns>:<name>` |
| `aud` | who the token is valid *for* |
| `iss` | who signed it |
| `iat` / `exp` | issued-at / expiry |
| `kubernetes.io.pod` | **the binding** — delete this Pod and the token stops working |
| `kubernetes.io.node` | which node it was issued on |
| `warnafter` | the *intended* lifetime deadline (see below) |

> The signature is **not** verified here — we only read claims. The API server verifies it. Never trust claims from an unverified JWT in your own code.

---

## The expiry nuance

From the token above:

```
exp − iat       = 31,536,000 s  = 365 days
warnafter − iat =      3,607 s  = ~1 hour
```

A kubelet-projected token is **bound and rotated**, but its `exp` is typically a **year** out, not an hour — because the API server defaults to `--service-account-extend-token-expiration=true`.

**Why that exists:** it's a migration safety net. Old clients read the token once at startup and cached it forever. Rather than break them, the API server issues a long `exp` but stamps `warnafter` at the intended lifetime; past that point it increments `serviceaccount_stale_tokens_total` and adds an audit annotation, so operators can find the offending clients before tightening the setting.

**Consequences for you:**

- The claim "the default token expires in an hour" is wrong about `exp`. The *rotation* deadline is `warnafter`.
- The kubelet rewrites the file at roughly **80% of the intended lifetime**, so a correct client **re-reads the file on every request**. Caching at startup works right up until it silently doesn't.
- An **explicitly declared** projected token behaves differently — no extension:

```
# with expirationSeconds: 3600 in the Pod spec
exp − iat = 3600     and no `warnafter` claim at all
```

Verify the extension setting on your own cluster:

```bash
kubectl get pod -n kube-system -l component=kube-apiserver \
  -o jsonpath='{.items[0].spec.containers[0].command}' | tr ',' '\n' | grep -i token
```

---

## Audiences

A token is only valid for the audiences it was minted with. Same Pod, two tokens, verified live:

| Path | `aud` | Accepted by |
|---|---|---|
| `/var/run/secrets/kubernetes.io/serviceaccount/token` | `["https://kubernetes.default.svc.cluster.local", "k3s"]` | the API server |
| `/var/run/secrets/tokens/vault-token` | `["vault"]` | Vault only |

Declare a custom one in the Pod spec:

```yaml
volumes:
  - name: vault-token
    projected:
      sources:
        - serviceAccountToken:
            path: vault-token
            audience: vault              # who it's FOR
            expirationSeconds: 3600      # minimum 600
```

**Why this matters:** without audiences, a token stolen from a Pod could be replayed against *any* service that trusts the cluster's issuer. With them, a Vault token is useless against the API server and vice versa — the blast radius of a leak is one service.

---

## Minting a token on demand

```bash
# short-lived, no Secret involved (the modern way)
kubectl create token sa-pod-reader -n identity --duration=1h

# with a custom audience
kubectl create token sa-pod-reader -n identity --audience=vault --duration=30m

# bound to a Pod's lifetime
kubectl create token sa-pod-reader -n identity --bound-object-kind Pod \
  --bound-object-name app-pod-reader-5568b8cc8c-mxgzf
```

This calls the **TokenRequest API** directly. Prefer it over creating token Secrets for anything scripted.

> Requesting a duration longer than the API server's `--service-account-max-token-expiration` silently gets capped — always check the `exp` you actually received.

---

## Legacy tokens, and the 1.24 change

Before Kubernetes 1.24, creating a ServiceAccount auto-created a Secret containing a token that **never expired**, was **not bound to any Pod**, and stayed valid after the SA was deleted. Anyone with `get secrets` in the namespace could take it and become that identity indefinitely.

Confirmed on this cluster — the `SECRETS` column is `0` for every SA:

```
$ kubectl get sa -n identity
NAME                  SECRETS   AGE
default               0         1s
sa-cluster-viewer     0         1s
sa-pod-reader         0         1s
```

| Version | Change |
|---|---|
| 1.21 | BoundServiceAccountTokenVolume beta — Pods start getting projected tokens |
| 1.22 | Projected tokens become the default mount |
| **1.24** | **Auto-creation of token Secrets removed** (KEP-1205) |
| 1.29 | Legacy tokens get usage tracking; unused ones cleaned up |
| 1.30+ | `kubectl create token` is the expected path |

You can still create one by hand ([50-legacy-token-secret.yaml](manifests/50-legacy-token-secret.yaml)), and there is one legitimate reason: an external client that cannot call the TokenRequest API. Prefer, in order:

1. **Workload identity federation** (IRSA / GKE WI / Azure WI) — no token to steal
2. **`kubectl create token --duration=1h`** — short-lived, on demand
3. A manual token Secret — audited and rotated, only if neither works

---

## Building a kubeconfig from a ServiceAccount

The standard way to give CI or an external tool scoped cluster access:

```bash
NS=identity
SA=sa-pod-reader
SERVER=$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')

# short-lived token (rotate on each pipeline run — best practice)
TOKEN=$(kubectl create token $SA -n $NS --duration=1h)

# the cluster CA, so the client can verify the API server
kubectl config view --raw --minify -o jsonpath='{.clusters[0].cluster.certificate-authority-data}' > /tmp/ca.b64

cat > /tmp/sa-kubeconfig <<EOF
apiVersion: v1
kind: Config
clusters:
- name: cluster
  cluster:
    server: ${SERVER}
    certificate-authority-data: $(cat /tmp/ca.b64)
contexts:
- name: sa-context
  context:
    cluster: cluster
    user: ${SA}
    namespace: ${NS}
current-context: sa-context
users:
- name: ${SA}
  user:
    token: ${TOKEN}
EOF

KUBECONFIG=/tmp/sa-kubeconfig kubectl get pods        # works
KUBECONFIG=/tmp/sa-kubeconfig kubectl get secrets     # Forbidden
```

**Don't bake a long-lived token into a CI secret store.** Mint one per run, or better, use OIDC federation between your CI provider and the cluster so no token is stored at all.

---

## Verifying permissions

```bash
# what can this SA do? (impersonation — needs admin rights yourself)
kubectl auth can-i --list --as=system:serviceaccount:identity:sa-pod-reader -n identity

# one specific question
kubectl auth can-i get pods    --as=system:serviceaccount:identity:sa-pod-reader -n identity   # yes
kubectl auth can-i get secrets --as=system:serviceaccount:identity:sa-pod-reader -n identity   # no

# who am I right now?
kubectl auth whoami

# from INSIDE a Pod, with no admin rights — SelfSubjectRulesReview
kubectl exec -n identity deploy/app-pod-reader -- wget -qO- localhost:3000/canido
```

`kubectl auth can-i --as=...` uses the **impersonation** API, which itself requires the `impersonate` verb. That's why `impersonate` is a dangerous permission to grant: it lets the holder act as any identity, including `cluster-admin`.

---

## Finding what's over-privileged

```bash
# every binding that grants cluster-admin
kubectl get clusterrolebindings -o json | python3 -c "
import json,sys
for b in json.load(sys.stdin)['items']:
    if b['roleRef']['name'] == 'cluster-admin':
        for s in b.get('subjects') or []:
            print(f\"{b['metadata']['name']:45} -> {s['kind']}/{s.get('namespace','')}/{s['name']}\")
"

# every SA that can read secrets cluster-wide
for sa in $(kubectl get sa -A -o jsonpath='{range .items[*]}{.metadata.namespace}:{.metadata.name}{"\n"}{end}'); do
  ns=${sa%%:*}; name=${sa##*:}
  if kubectl auth can-i get secrets --as=system:serviceaccount:$ns:$name -A 2>/dev/null | grep -q yes; then
    echo "SECRET READER: $ns/$name"
  fi
done

# workloads still mounting a token they may not need
kubectl get pods -A -o json | python3 -c "
import json,sys
for p in json.load(sys.stdin)['items']:
    if p['spec'].get('automountServiceAccountToken') is not False:
        print(p['metadata']['namespace'], p['metadata']['name'], p['spec'].get('serviceAccountName','default'))
" | head -20
```
