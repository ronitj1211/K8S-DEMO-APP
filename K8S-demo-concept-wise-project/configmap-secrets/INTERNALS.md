# ConfigMaps & Secrets — Internals

Where values come from at Pod start, how mounted volumes get atomically updated, why "Secret" ≠ "encryption."

---

## Purpose

Both objects hold key/value data (`data` for text, `binaryData` for base64-binary). Both can be injected into Pods as env vars or files. The difference is operational, not structural:
- **ConfigMap** = non-sensitive config, plaintext in etcd.
- **Secret** = sensitive config, base64-encoded in etcd, auto-masked in logs.

Neither is encrypted in etcd by default. Adding encryption at rest is a separate step (see below).

## Three injection patterns — what actually happens

### Pattern 1: Env var from a specific key

```yaml
env:
  - name: DB_HOST
    valueFrom:
      configMapKeyRef:
        name: app-config
        key: db.host
```

At Pod start:
1. Kubelet fetches the ConfigMap from the API server.
2. Reads the `db.host` field from `data`.
3. Sets an env var `DB_HOST=<value>` in the container's environment.
4. Starts the container process.

The env var is **frozen at this moment**. If the ConfigMap is edited later, this Pod's env is unchanged. The kernel doesn't have a mechanism to modify a running process's environment from outside.

To pick up the new value: restart the Pod (`kubectl rollout restart deployment/foo`).

### Pattern 2: All keys as env vars

```yaml
envFrom:
  - configMapRef: { name: app-config }
```

Same as Pattern 1 but every key in the ConfigMap becomes an env var named the same as the key. Kubelet reads at Pod start, sets env vars, frozen.

**Caveat**: keys with non-env-safe characters (dots, dashes) get skipped or converted. `db.host` might not become an env var. Use env-safe key names.

### Pattern 3: Mounted as a volume

```yaml
volumes:
  - name: config
    configMap: { name: app-config }
containers:
  - name: app
    volumeMounts:
      - { name: config, mountPath: /etc/config }
```

Kubelet mounts a special filesystem at `/etc/config` inside the container. Each key in the ConfigMap becomes a file at `/etc/config/<key>`. The file content is the value.

**And here's where it gets interesting** — the mount is not a plain directory. It uses a symlink pattern that allows atomic updates.

## The atomic-swap symlink dance

Look inside a mounted ConfigMap volume:

```bash
kubectl exec <pod> -- ls -la /etc/config/
```

```
drwxr-xr-x  3 root root  120 Jul 30 14:15 .
drwxr-xr-x 60 root root 4096 Jul 30 14:15 ..
drwxr-xr-x  2 root root   80 Jul 30 14:15 ..2026_07_30_14_15_22.987654321
lrwxrwxrwx  1 root root   31 Jul 30 14:15 ..data -> ..2026_07_30_14_15_22.987654321
lrwxrwxrwx  1 root root   14 Jul 30 14:15 db.host -> ..data/db.host
lrwxrwxrwx  1 root root   15 Jul 30 14:15 db.pass -> ..data/db.pass
```

The structure:
- `..<timestamp>/` — real directory holding the actual file content. One per generation.
- `..data` — symlink pointing at the current generation directory.
- Each visible key (`db.host`, `db.pass`) — symlink to `..data/<key>`.

**When kubelet syncs an update** (typically within 60s of a ConfigMap change):
1. Creates a new timestamped directory with the new content.
2. Atomically swaps the `..data` symlink to point at the new directory.
3. Removes the old timestamped directory.

Effect: from the app's perspective, all files change simultaneously. There's no window where some files are updated and others aren't — that would be catastrophic for consistency.

**Detection in your app**: watch the `..data` symlink target (inotify on the mount directory). When it changes, config has been updated. That's the pattern nginx-style config-reloaders use.

## `subPath` — the gotcha

If you mount a single key using `subPath`:

```yaml
volumeMounts:
  - name: config
    mountPath: /etc/app/config.yaml
    subPath: config.yaml
```

The container sees a single file `/etc/app/config.yaml` — no `..data` symlink dance visible. **But this breaks live updates**. `subPath` uses a bind mount that pins to the inode at mount time. When kubelet's atomic swap happens, the new file has a different inode; the bind mount doesn't follow.

**Choose one:**
- Mount without `subPath` if you want live reloads.
- Use `subPath` if the app writes back to that path (some legacy apps write next to their config) and you're OK with restart-to-reload.

## Secrets — the same, but with a tmpfs

Secret volumes are mounted as `tmpfs` (RAM-backed filesystem) by default — the values never touch node disk. When kubelet unmounts, the memory is freed and the values are gone from that node.

```bash
mount | grep <pod-uid>
tmpfs on /var/lib/kubelet/pods/<uid>/volumes/kubernetes.io~secret/<name> ...
```

This is why nodes can't recover Secret volumes after a reboot — they never persisted.

For env-var Secrets: kubelet reads the Secret, sets env, starts container. The value lives in the process's environment — visible in `/proc/<pid>/environ`. If a malicious process gains root on the node, it can read env vars of any process.

## The critical truth: Secrets are NOT encrypted

The default is base64 in etcd. `echo <blob> | base64 -d` decodes in a second.

Real encryption at rest requires an `EncryptionConfiguration` on the API server:

```yaml
apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
  - resources: [secrets]
    providers:
      - kms:
          name: aws-kms
          endpoint: unix:///var/run/kmsplugin/socket.sock
          cachesize: 1000
      - identity: {}    # fallback for reading old (unencrypted) values
```

This makes the API server encrypt Secret values before writing to etcd (via KMS provider — AWS KMS, GCP KMS, HashiCorp Vault). Now even etcd disk theft doesn't leak secrets.

Existing Secrets are re-encrypted lazily. Force it:

```bash
kubectl get secrets -A -o json | kubectl replace -f -
```

## External Secrets Operator — the modern pattern

Rather than storing sensitive data in K8s Secrets at all, sync from an external secret manager:

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: prod-db-secret
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: aws-secrets-manager
    kind: SecretStore
  target:
    name: prod-db-secret         # the K8s Secret created here
  data:
    - secretKey: password
      remoteRef:
        key: prod/db/password    # path in AWS Secrets Manager
```

ESO watches `ExternalSecret` resources, calls AWS Secrets Manager, and creates/updates the K8s Secret with the current value. Rotation at the source propagates within the refresh interval.

Advantages:
- Rotation is centralized (rotate in Secrets Manager, cluster picks it up).
- K8s Secrets are downstream — audit trails focus on the source of truth.
- Works across clusters — same source, N clusters syncing.

## How kubelet updates ConfigMap/Secret files

Kubelet syncs each Pod's mounted CM/Secret volumes on a timer (default 60s) and on API events. The sync:

1. Fetches the current ConfigMap/Secret from the API.
2. Compares to what's on disk.
3. If different, writes new files in a new timestamped directory.
4. Atomic-swaps `..data`.

For **env var** references — no sync. Env is frozen at start.

To force a Pod to see new env values from an updated CM/Secret:

```bash
kubectl rollout restart deployment/foo
```

Or annotate the Pod template with a hash of the CM/Secret content — a change triggers a rolling update automatically:

```yaml
spec:
  template:
    metadata:
      annotations:
        checksum/config: <sha256 of the ConfigMap>
```

## `immutable: true`

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
immutable: true    # cannot be edited after creation
data:
  key: value
```

Once created, `data` and `binaryData` fields cannot be changed. You can only delete + recreate.

Two wins:
1. Prevents accidental config drift.
2. **Big performance win** — kubelet doesn't need to watch the CM for changes, so cluster-scale API load drops significantly.

Use for ConfigMaps that are truly stable per-release (e.g., release version, build metadata).

## Size limits

Both CM and Secret max out at **1 MiB per object**. This is an etcd limit, not just K8s.

To hold larger config: use a PVC (shared file storage) or fetch from S3/git at Pod start (init container).

## `stringData` vs `data` in Secret authoring

```yaml
kind: Secret
stringData:
  api_key: super-secret-value      # plain text; K8s base64-encodes for you
data:
  db_password: c3VwZXItcGFzcw==    # you must base64-encode yourself
```

`stringData` is easier to author. K8s merges both, converting stringData to base64 and storing under `data`. If both define the same key, `stringData` wins.

---

## The 30-second summary

- Env-var references (Pattern 1, 2) are **frozen at Pod start**. Restart Pods to pick up changes.
- Volume-mounted references (Pattern 3) update **atomically within ~60s** via kubelet's timestamped-directory symlink swap.
- `subPath` breaks the atomic update — it pins to an inode at mount time.
- Secrets are **base64, not encrypted**, unless you configure API server EncryptionConfiguration with KMS.
- Secret volumes mount as tmpfs — values live in RAM, not on node disk.
- Use External Secrets Operator to sync from an external source of truth (Vault, AWS Secrets Manager).
- `immutable: true` on stable ConfigMaps saves kubelet CPU at scale.
