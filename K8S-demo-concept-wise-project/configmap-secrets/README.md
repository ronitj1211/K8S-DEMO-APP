# ConfigMaps & Secrets

## Why these exist

You never want config baked into your container image. If the image and the config are coupled:

- You rebuild the image to change a log level.
- You can't ship the same image to dev/staging/prod.
- Secrets end up in image registries forever.

Kubernetes splits this in two:

- **ConfigMap** — non-sensitive config (env vars, config files, feature flags).
- **Secret** — sensitive config (API keys, passwords, certs, tokens).

Both are key/value stores. The differences are mostly about **how they're handled**: Secrets are base64-encoded on the wire, stored separately, can be encrypted at rest, and tools/UIs treat them as sensitive (masked, not logged).

> ⚠️ A Secret is **base64**, not encrypted. Anyone with `kubectl get secret -o yaml` access can read it. Real protection comes from RBAC + encryption-at-rest + (often) an external secret store.

---

## Types

### ConfigMap

Just one kind. Stored as key/value pairs. Values can be short strings or whole files.

### Secret types

Kubernetes supports several Secret `type`s. The type controls what keys are expected and how tools use them.

| Type | Expected keys | Use for |
|------|---------------|---------|
| `Opaque` *(default)* | Any | Generic secrets — API keys, passwords. |
| `kubernetes.io/tls` | `tls.crt`, `tls.key` | TLS certificate + key (Ingress, etc). |
| `kubernetes.io/dockerconfigjson` | `.dockerconfigjson` | Private container-registry auth. |
| `kubernetes.io/service-account-token` | auto-managed | API access tokens for ServiceAccounts. |
| `kubernetes.io/basic-auth` | `username`, `password` | HTTP basic auth. |
| `kubernetes.io/ssh-auth` | `ssh-privatekey` | SSH keys. |

---

## Three ways to consume ConfigMap / Secret in a Pod

### A. Individual env vars

```yaml
env:
  - name: LOG_LEVEL
    valueFrom:
      configMapKeyRef:
        name: backend-config
        key: LOG_LEVEL
  - name: API_KEY
    valueFrom:
      secretKeyRef:
        name: backend-secret
        key: API_KEY
```

Best when you only need a few keys, or want to rename them.

### B. All keys as env vars (`envFrom`)

```yaml
envFrom:
  - configMapRef:
      name: backend-config
  - secretRef:
      name: backend-secret
```

Best for a "12-factor app" that reads everything from env.

### C. Mounted as files (volume)

```yaml
volumes:
  - name: config-volume
    configMap:
      name: backend-config
      items:
        - key: app.conf
          path: app.conf
volumeMounts:
  - name: config-volume
    mountPath: /etc/config
    readOnly: true
```

Best for apps that read a config file (nginx.conf, app.yaml, TLS certs). Bonus: when you **update** the ConfigMap, the mounted file updates in place (eventually) — env vars do not.

---

## What's in this folder

```
configmap-secrets/
├── backend/
│   ├── server.js                  # reads APP_NAME, LOG_LEVEL, GREETING, API_KEY, and /etc/config/app.conf
│   ├── package.json, Dockerfile
│   ├── backend-configmap.yaml     # ConfigMap with env values + an app.conf file
│   ├── backend-secret.yaml        # Secret with API_KEY + DB_PASSWORD
│   └── backend-deployment.yaml    # consumes config via env vars AND a mounted file
└── frontend/
    ├── index.html, Dockerfile
    └── frontend-deployment.yaml
```

---

## Prerequisites

Docker, `kubectl`, local cluster.

---

## How to run

### 1. Build images

```bash
eval $(minikube docker-env)   # minikube only

cd backend  && docker build -t k8s-demo-backend:1.0 .
cd ../frontend && docker build -t k8s-demo-frontend:1.0 .
```

(For kind: `kind load docker-image ...`)

### 2. Create ConfigMap and Secret first

```bash
kubectl apply -f backend/backend-configmap.yaml
kubectl apply -f backend/backend-secret.yaml
```

Inspect:

```bash
kubectl get configmap backend-config -o yaml
kubectl get secret    backend-secret -o yaml      # values are base64 — see below
kubectl get secret    backend-secret -o jsonpath='{.data.API_KEY}' | base64 -d
```

### 3. Deploy app

```bash
kubectl apply -f backend/backend-deployment.yaml
kubectl apply -f frontend/frontend-deployment.yaml
```

### 4. Verify config got into the Pod

```bash
POD=$(kubectl get pod -l app=backend -o jsonpath='{.items[0].metadata.name}')

# Env vars
kubectl exec "$POD" -- env | grep -E 'APP_NAME|LOG_LEVEL|GREETING|API_KEY'

# Mounted file
kubectl exec "$POD" -- cat /etc/config/app.conf
```

### 5. Hit the backend

```bash
curl http://$(minikube ip):30082
```

You should see the greeting, log level, and the mounted file content in the JSON response.

### 6. Update config without rebuilding the image

Edit `backend-configmap.yaml` — change `LOG_LEVEL` to `warn`, change the contents of `app.conf`. Then:

```bash
kubectl apply -f backend/backend-configmap.yaml
```

- **Mounted file**: the file at `/etc/config/app.conf` updates automatically after the kubelet syncs (≈1 minute).
- **Env vars**: do **not** update — you must restart the Pods:

```bash
kubectl rollout restart deployment/backend
```

### 7. Create a Secret from the CLI (alternative)

You don't have to write a Secret YAML. From files or literals:

```bash
kubectl create secret generic backend-secret \
  --from-literal=API_KEY=super-secret-key \
  --from-literal=DB_PASSWORD='p@ssw0rd!'

kubectl create secret generic tls-files \
  --from-file=tls.crt=./cert.pem \
  --from-file=tls.key=./key.pem
```

For TLS Secrets specifically:

```bash
kubectl create secret tls demo-tls --cert=./cert.pem --key=./key.pem
```

---

## Useful commands

```bash
kubectl get configmap
kubectl describe configmap backend-config
kubectl get secret
kubectl get secret backend-secret -o yaml
kubectl get secret backend-secret -o jsonpath='{.data.API_KEY}' | base64 -d
kubectl rollout restart deployment/backend
```

---

## Cleanup

```bash
kubectl delete -f backend/backend-deployment.yaml
kubectl delete -f backend/backend-secret.yaml
kubectl delete -f backend/backend-configmap.yaml
kubectl delete -f frontend/frontend-deployment.yaml
```

---

## Key takeaways

1. **ConfigMap** = non-sensitive, **Secret** = sensitive. Same shape, different handling.
2. Three consumption patterns: per-key env (`valueFrom`), bulk env (`envFrom`), and mounted files (volume).
3. **Mounted ConfigMaps update live** in the Pod; **env vars don't** — you must restart the Deployment.
4. Secrets are **base64, not encrypted**. Lock down access with RBAC; enable encryption-at-rest; consider external secret managers (Vault, AWS Secrets Manager, SOPS, Sealed Secrets).
5. Never bake config into images. Same image → many environments via different ConfigMaps/Secrets.

**Previous:** [kubernetes-ingress](../kubernetes-ingress/) · **Next:** [daemonsets](../daemonsets/)
