# ConfigMaps & Secrets — Deep Dive for Interviews

The narrative version. Why config is separated from images, how ConfigMaps and Secrets differ (and don't), and the traps waiting for you.

---

## The origin story

The 12-Factor App essay (Heroku, ~2011) hammered on one principle: **strict separation of config from code**. Don't bake `DATABASE_URL=postgres://prod-...` into your app image. Otherwise you can't reuse the same image across dev/staging/prod — the image has environment-specific values baked in.

Pre-Kubernetes, everyone did this with **env vars** and **config files at deploy time**. Ansible / Chef / Puppet templated them out. Fine, but not portable across platforms.

Kubernetes gave this its own primitive: the **ConfigMap**. A namespaced object that holds key/value config data, mounted into Pods as either env vars or files. Same image, different ConfigMap per environment, no image rebuilds required.

**Secrets** came alongside as the sibling for sensitive data. Same shape (key/value), same injection patterns (env or files), but stored differently (base64 in etcd), auto-masked in logs, and best practice says never to `kubectl get -o yaml` them casually.

## The mental model

ConfigMap and Secret are **the same thing** semantically — key/value store, mounted three ways (env var, envFrom, volume). The differences are operational:

| | ConfigMap | Secret |
|---|---|---|
| For | Non-sensitive | Sensitive |
| Storage | Plaintext | Base64 (NOT encrypted by default) |
| Log masking | No | Yes, values with the secret's data are masked in logs |
| Access via `kubectl describe` | Shows values | Redacted |
| Access via `kubectl get -o yaml` | Shows values | Shows base64 (trivial to decode) |
| Encryption at rest | Optional (via KMS) | Same — optional (via KMS) |

The important truth: **Secrets are not encrypted by default**. They're base64-encoded in etcd. Anyone with etcd access has cleartext. Real encryption at rest requires configuring an `EncryptionConfiguration` on the API server, typically backed by KMS. Or use an external secret store (Vault, AWS Secrets Manager) and mount from there.

## How it actually works

Three injection patterns, each with different lifecycle behavior:

### Pattern 1: Specific key → env var (`valueFrom.configMapKeyRef` / `secretKeyRef`)

```yaml
env:
  - name: DB_HOST
    valueFrom:
      configMapKeyRef:
        name: app-config
        key: db.host
```

The value is looked up when the Pod starts. Once the container is running, **the env var is frozen** — updates to the ConfigMap don't propagate. To pick up new values: restart the Pod (`kubectl rollout restart deployment/foo`).

### Pattern 2: All keys → env vars (`envFrom`)

```yaml
envFrom:
  - configMapRef: { name: app-config }
  - secretRef: { name: app-secrets }
```

Every key in the ConfigMap/Secret becomes an env var named the same. Convenient, but the app inherits whatever keys are there — even ones added later that maybe you didn't mean to expose. Same freeze-at-start behavior.

### Pattern 3: Mount as files (`volume` + `volumeMounts`)

```yaml
volumes:
  - name: config
    configMap: { name: app-config }
volumeMounts:
  - { name: config, mountPath: /etc/app/config }
```

Each key becomes a file at `/etc/app/config/<key>`. Kubelet syncs updates within ~60s — **files refresh live**. The app has to notice the change (re-read the file, watch inotify, or accept a SIGHUP). Great for config that changes without restart (nginx.conf, feature flags).

Under the covers, mounted files aren't what they seem. If you `ls -la /etc/app/config`, you'll see:
```
..2026_07_23_..._<hash>/
..data -> ..2026_07_23_..._<hash>
db.host -> ..data/db.host
```

Kubelet writes the new generation to a timestamped hidden directory, then atomically swaps `..data` to point at it. Files are symlinks through `..data`, so your app always sees a consistent snapshot — no half-updated file states.

## When to use ConfigMap vs Secret

**ConfigMap** for anything you'd commit to Git without a second thought: feature flags, log levels, log format, non-sensitive URLs, region names, cache TTLs.

**Secret** for anything an attacker with cluster-read access could abuse: passwords, API keys, tokens, TLS certs. But — and this matters — **Secret is not encryption**. Treating a Secret like it's securely stored just because it says "Secret" is a common mistake. Real protection needs either KMS encryption at rest configured on the cluster, or an external secret manager.

**Neither** for the truly sensitive: root CA private keys, master encryption keys, anything whose leak means "start over from scratch." Those live in Vault / KMS / HSMs and are never in K8s Secrets at all — the K8s workload gets a short-lived derived credential, not the master.

## Common misunderstandings

**"Secrets are encrypted in K8s."** No — base64 encoded, not encrypted. Base64 is a serialization format, not cryptography. `echo <value> | base64 -d` decodes in a second.

**"Env var config updates automatically."** No. Env vars are frozen at Pod start. To pick up ConfigMap changes: restart the Pods. Mounted files update; env vars do not.

**"ConfigMap is 1 MB — that's plenty."** The 1 MiB cap is per object, not per key. Some people try to store binaries or long text files and hit it. Use a PVC or object storage for anything larger than app config.

**"I can reference a ConfigMap across namespaces."** You can't. Both ConfigMap and Secret are namespaced. Cross-namespace access requires copying (via automation like Reflector or External Secrets Operator).

**"`envFrom` is the safe default."** It's convenient but leaky — every key in the ConfigMap becomes an env var. Add a `DEBUG_TOKEN` for testing → suddenly it's in prod. Explicit `env: - name: FOO valueFrom:...` is safer for shared configs.

**"Rotating a Secret rotates the app."** No. Rotating a Secret (updating its data) doesn't restart Pods. If the app read the env var at start, it still has the old value in memory. Rotate = new Secret data + rollout restart of consumers.

**"The kubelet's file mount is atomic."** Per-file atomic (symlink swap), but not multi-file atomic. If your ConfigMap has 5 keys and you update all 5, the app might see 3 old and 2 new for a moment during the sync. If you need atomic multi-key updates, put them in one file (a JSON blob) instead of five keys.

## The war stories

**"We committed a Secret to Git."** Assume it's compromised. Rotate the actual credential (change the DB password, revoke the API key). Removing from Git history is theatre — the value was already visible in run logs, scraper bots, GitHub's search cache. Then add a pre-commit hook (gitleaks, detect-secrets) so it doesn't happen again.

**"Our app crashes on startup with `CreateContainerConfigError`."** The Pod references a Secret key that doesn't exist. `kubectl describe pod` shows: `couldn't find key API_KEY in Secret default/app-secrets`. Fix: create the secret or the key.

**"Config changes aren't propagating."** Env vars from ConfigMap are frozen at Pod start. `kubectl rollout restart deployment/foo` is the fix. A slicker pattern: annotate the Deployment with a checksum of the ConfigMap content — when it changes, the annotation changes, K8s sees a template change, triggers a rollout automatically. Helm's `checksum/config` pattern.

**"We rotated a Secret; some Pods still use the old value."** Only the Pods that restarted since the rotation see the new value. Old Pods still have the old value in memory or env. To force uniform rotation: `kubectl rollout restart` all consumers after Secret change.

**"A `.dockerconfigjson` imagePullSecret was ignored."** ServiceAccount didn't reference it. `imagePullSecrets` on a Pod is one place; on the SA is another. If the SA is `default` and you added the pull secret to a different SA, Pods using `default` don't inherit it.

**"Secret volume mounts have those weird `..data` files."** Documented and normal — atomic-update symlink dance. Don't have your app iterate the directory expecting only your keys; read specific files by name.

## What to actually say in an interview

If asked "what's a ConfigMap?":

> A namespaced key/value store for non-sensitive configuration. You inject it into Pods three ways: single key as an env var, all keys as env vars via `envFrom`, or mounted as files in a volume. The volume mode is the interesting one — file updates propagate live within about a minute; env vars are frozen at Pod start. Same image can be deployed to dev/staging/prod by binding to different ConfigMaps.

If asked "how does a Secret differ from a ConfigMap?":

> Semantically identical — same key/value shape, same three injection patterns. Operationally, Secrets are base64-encoded in etcd, values are auto-masked in `kubectl describe` and log output, and you're supposed to think twice before reading them. The critical thing to know is that Secrets are **not encrypted by default** — they're just base64. For real encryption at rest, you configure KMS encryption on the API server, or use external secret stores like Vault or AWS Secrets Manager and mount from there.

If asked about config updates:

> Depends on injection pattern. Mounted files refresh automatically — kubelet syncs within about a minute using a symlink-swap so files stay consistent. Env vars are frozen at Pod start, so config updates require a Pod restart to take effect. There's a common pattern of annotating the Deployment with a checksum of the ConfigMap content — Helm's `checksum/config` — so a config change triggers a rolling deploy automatically.

If asked about secure secret handling:

> Don't rely on K8s Secrets alone in prod. Options: enable KMS encryption at rest on the API server; use External Secrets Operator to sync from Vault or AWS Secrets Manager; use Sealed Secrets to safely commit encrypted YAML to Git. Never `kubectl get secret -o yaml` and paste output anywhere — the base64 is trivially decoded. Rotate credentials on any suspected leak; assume the base64 was harvested.

Say the words: **decouples config from image**, **three injection patterns**, **base64 not encryption**, **env frozen vs file live**, **namespaced**, **external secret stores in prod**.
