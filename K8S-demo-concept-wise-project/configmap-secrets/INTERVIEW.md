# Interview Questions — ConfigMaps & Secrets

---

## Basic

### Q1. What's a ConfigMap?
A namespaced object that holds non-sensitive key/value configuration. It decouples config from container images so you can deploy the same image to dev/staging/prod with different config.

### Q2. What's a Secret?
Like a ConfigMap but for sensitive data (API keys, passwords, TLS certs). Stored in etcd, base64-encoded (**not encrypted by default**). Mounted into Pods the same way as ConfigMaps.

### Q3. How do you inject a ConfigMap into a Pod?
Three patterns:
1. **Single key → env var** — `valueFrom.configMapKeyRef`.
2. **All keys → env vars** — `envFrom.configMapRef`.
3. **Mount as files** — declare a `volume` of type `configMap` and `volumeMounts` in the container.

Same three patterns work for Secrets (`secretKeyRef`, `secretRef`, volume type `secret`).

### Q4. Are Secrets encrypted?
**Not by default.** Values are base64-encoded in etcd — anyone with etcd access can decode them. For real encryption at rest, configure **EncryptionConfiguration** on the API server (KMS-backed), or use an external secret store (Vault, AWS Secrets Manager, Sealed Secrets, External Secrets Operator).

### Q5. What's `stringData` vs `data` in a Secret?
- **`data`** — values must be base64-encoded by you.
- **`stringData`** — write plain text; Kubernetes base64-encodes it on the way in. Easier to author, but watch out: if both are set for the same key, `stringData` wins.

### Q6. How big can a ConfigMap/Secret be?
Max **1 MiB** total. This is an etcd limit, not just K8s. For larger config (whole binaries, certs bundles), use a PVC or pull at runtime from S3/git.

### Q7. Common Secret types?
- `Opaque` — generic (default).
- `kubernetes.io/tls` — `tls.crt` + `tls.key` for Ingress / webhooks.
- `kubernetes.io/dockerconfigjson` — pulled from `imagePullSecrets` for private registries.
- `kubernetes.io/service-account-token` — SA token (auto-mounted into Pods).
- `bootstrap.kubernetes.io/token` — node join tokens.

---

## Intermediate

### Q8. Does updating a ConfigMap update running Pods?
- **Mounted as files** — yes, kubelet syncs the file within ~60s. The app needs to re-read the file (some daemons watch for changes).
- **Env vars** — no. Env is frozen at Pod start. You must `kubectl rollout restart deployment/foo` to pick up changes.

### Q9. What's `immutable: true`?
Set on a ConfigMap or Secret to prevent updates after creation. Two wins: prevents accidental misconfig pushes, and skips the kubelet's periodic resync — measurably better perf in clusters with many Pods consuming the same map.

### Q10. How does `subPath` work in volume mounts and what's its gotcha?
`subPath` mounts a single key from a ConfigMap/Secret as a single file at the target path, instead of mounting the whole volume as a directory. **Gotcha:** files mounted via `subPath` do NOT auto-update when the ConfigMap changes (the dir-watch pivots on the directory entry). If you need live updates, mount the whole volume.

### Q11. How do you create a Secret imperatively?
```bash
kubectl create secret generic db --from-literal=user=admin --from-literal=password='p@55'
kubectl create secret tls demo-tls --cert=server.crt --key=server.key
kubectl create secret docker-registry regcred --docker-server=... --docker-username=... --docker-password=...
```

### Q12. Why can a ConfigMap be mounted as a "projected" volume?
`projected` volumes combine multiple sources (ConfigMap, Secret, serviceAccountToken, downwardAPI) into a single mount path. Useful when an app expects all its config in `/etc/myapp/` regardless of which K8s primitive provided which file.

### Q13. What's the difference between `envFrom.configMapRef` and listing keys explicitly?
- `envFrom.configMapRef.name: foo` — all keys in `foo` become env vars with their names. Easy.
- `env: [{name: API_KEY, valueFrom: {configMapKeyRef: {name: foo, key: api}}}]` — explicit; you control the env var name and only pull keys you need.

`envFrom` is fine for small, app-owned ConfigMaps. The explicit form is safer for shared ConfigMaps where you don't want to leak unrelated keys into the container env.

### Q14. Can a Pod consume a ConfigMap from a different namespace?
No. ConfigMaps and Secrets are namespaced and you cannot reference one from another namespace. Workarounds: copy it (via tooling), or use an operator like Reflector or External Secrets Operator that syncs across namespaces.

### Q15. What's the binary equivalent of `data` for non-UTF8 content?
`binaryData` on ConfigMap. The value must be base64-encoded. Useful for embedding small binary files (a Java keystore, a small icon).

### Q16. How does `imagePullSecrets` work?
A Secret of type `dockerconfigjson` referenced from `Pod.spec.imagePullSecrets`. Kubelet uses it to authenticate to private registries when pulling the image. For an entire ServiceAccount: add the Secret to `serviceAccount.imagePullSecrets` and every Pod using that SA inherits it.

---

## Scenario-based

### S1. Your app starts but reads stale config. You just updated the ConfigMap.
If env vars: env is frozen at Pod start — restart Pods (`kubectl rollout restart deployment/foo`). If mounted as files: kubelet syncs in ~60s — but the app must either re-read the file or be SIGHUP'd. A common pattern is to checksum the ConfigMap content and include the checksum as a `Deployment.spec.template.metadata.annotations` value — the rolling update kicks in automatically on change.

### S2. You committed a Secret to Git accidentally. What now?
The Secret is now public — base64 is decode, not encryption. Steps:
1. **Rotate the credential immediately** at the source (DB password, API key, etc.).
2. Replace the Secret in the cluster (`kubectl create secret ... --dry-run=client -o yaml | kubectl apply -f -`).
3. Remove from Git history (`git filter-repo` or BFG) and force-push — though assume the secret was already harvested by scrapers.
4. Add a pre-commit hook (e.g., `gitleaks`, `detect-secrets`) so it doesn't happen again.

### S3. A team wants prod DB passwords to *never* live in YAML files.
Use a secrets-management integration:
- **External Secrets Operator** — pulls from AWS Secrets Manager / Vault / GCP Secret Manager and creates K8s Secrets.
- **Vault Agent Injector** — sidecar that fetches secrets and writes them to a shared volume.
- **CSI Secrets Store** — mounts secrets from an external provider as a volume.
- **Sealed Secrets** — encrypt the Secret YAML with the cluster's public key; controller decrypts inside the cluster. Encrypted form is safe to commit.

The K8s Secret still exists internally — but the Git checkout doesn't contain raw values.

### S4. Your Pod sits in `CreateContainerConfigError`. What's likely wrong?
The Pod references a ConfigMap or Secret that doesn't exist or has a missing key. `kubectl describe pod` shows the exact reason — e.g., `couldn't find key API_KEY in Secret default/backend-secret`. Fix: create/patch the Secret/ConfigMap with the missing key.

### S5. You mounted a Secret at `/etc/secrets`, but `ls /etc/secrets` shows hidden files `..data` and `..2026_05_20_06_56...`.
That's expected. Kubelet implements atomic updates via a symlink swap: real files live in a hidden timestamped directory, `..data` is a symlink to the current generation, and the visible filenames symlink through `..data`. The app should `read("/etc/secrets/<key>")` and never list the directory.

### S6. Two apps in different namespaces need the same TLS cert.
You **cannot** share a Secret across namespaces directly. Options:
- **External Secrets Operator** / **Reflector** to mirror it.
- **cert-manager** with a ClusterIssuer — each namespace gets its own Certificate resource that materializes a per-namespace Secret. Often the right answer because you're rotating certs anyway.
- **Manual duplication** (worst — drift).

### S7. Your CI generates a Secret YAML with `data:` base64 values, but `apply` fails.
Likely causes: trailing newline in the base64 string (`echo -n` vs `echo`), or value not actually base64. Use `printf '%s' "$VAL" | base64 -w0` (Linux) / `base64` (macOS) to encode without newlines. Or just use `stringData:` and let K8s encode for you.
