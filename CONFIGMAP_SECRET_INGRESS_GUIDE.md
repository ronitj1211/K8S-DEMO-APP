# ConfigMaps, Secrets & Ingress Guide

A comprehensive guide to managing configuration, sensitive data, and external access in Kubernetes.

---

## Table of Contents

1. [ConfigMaps](#1-configmaps)
2. [Secrets](#2-secrets)
3. [Ingress](#3-ingress)
4. [Hands-On Practice](#4-hands-on-practice)
5. [Best Practices](#5-best-practices)

---

## 1. ConfigMaps

### What is a ConfigMap?

A ConfigMap stores **non-sensitive configuration data** as key-value pairs. It decouples configuration from container images, making applications portable.

### Why Use ConfigMaps?

| Without ConfigMap | With ConfigMap |
|-------------------|----------------|
| Config hardcoded in image | Config separate from image |
| Rebuild image for config change | Update ConfigMap, restart pod |
| Same config everywhere | Different config per environment |

### Creating ConfigMaps

#### Method 1: YAML File

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: my-config
data:
  DATABASE_HOST: "mysql-service"
  DATABASE_PORT: "3306"
  LOG_LEVEL: "info"
```

#### Method 2: kubectl Command

```bash
# From literal values
kubectl create configmap my-config \
  --from-literal=DATABASE_HOST=mysql-service \
  --from-literal=DATABASE_PORT=3306

# From a file
kubectl create configmap my-config --from-file=config.properties

# From a directory
kubectl create configmap my-config --from-file=./config-dir/
```

### Using ConfigMaps in Pods

#### Option 1: All Keys as Environment Variables

```yaml
spec:
  containers:
    - name: app
      envFrom:
        - configMapRef:
            name: my-config    # All keys become env vars
```

#### Option 2: Specific Keys

```yaml
spec:
  containers:
    - name: app
      env:
        - name: DB_HOST              # Env var name
          valueFrom:
            configMapKeyRef:
              name: my-config        # ConfigMap name
              key: DATABASE_HOST     # Key in ConfigMap
```

#### Option 3: Mount as Volume (Files)

```yaml
spec:
  containers:
    - name: app
      volumeMounts:
        - name: config-volume
          mountPath: /etc/config     # Files appear here
  volumes:
    - name: config-volume
      configMap:
        name: my-config
```

### Useful Commands

```bash
# List ConfigMaps
kubectl get configmaps

# View ConfigMap contents
kubectl describe configmap my-config

# Edit ConfigMap
kubectl edit configmap my-config

# Delete ConfigMap
kubectl delete configmap my-config
```

---

## 2. Secrets

### What is a Secret?

A Secret stores **sensitive data** like passwords, API keys, and tokens. Data is base64-encoded (not encrypted by default).

### ConfigMap vs Secret

| Feature | ConfigMap | Secret |
|---------|-----------|--------|
| Purpose | Non-sensitive config | Sensitive data |
| Encoding | Plain text | Base64 encoded |
| Example | LOG_LEVEL, API_URL | PASSWORD, API_KEY |

### Creating Secrets

#### Method 1: YAML File (Base64 Encoded)

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: my-secret
type: Opaque
data:
  # Values must be base64 encoded
  DB_PASSWORD: cGFzc3dvcmQxMjM=    # echo -n "password123" | base64
  API_KEY: bXlhcGlrZXk=            # echo -n "myapikey" | base64
```

#### Method 2: YAML with stringData (Auto-Encoded)

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: my-secret
type: Opaque
stringData:
  DB_PASSWORD: "password123"       # Plain text, auto-encoded
  API_KEY: "myapikey"
```

#### Method 3: kubectl Command

```bash
# From literal values
kubectl create secret generic my-secret \
  --from-literal=DB_PASSWORD=password123 \
  --from-literal=API_KEY=myapikey

# From file
kubectl create secret generic my-secret --from-file=./credentials.txt
```

### Base64 Encoding/Decoding

```bash
# Encode
echo -n "my-secret-value" | base64
# Output: bXktc2VjcmV0LXZhbHVl

# Decode
echo "bXktc2VjcmV0LXZhbHVl" | base64 -d
# Output: my-secret-value

# Important: Use -n to avoid newline character!
```

### Using Secrets in Pods

#### As Environment Variables

```yaml
spec:
  containers:
    - name: app
      env:
        - name: DATABASE_PASSWORD
          valueFrom:
            secretKeyRef:
              name: my-secret
              key: DB_PASSWORD
```

#### Mount as Volume

```yaml
spec:
  containers:
    - name: app
      volumeMounts:
        - name: secret-volume
          mountPath: /etc/secrets
          readOnly: true
  volumes:
    - name: secret-volume
      secret:
        secretName: my-secret
```

### Secret Types

| Type | Use Case |
|------|----------|
| `Opaque` | Generic secrets (default) |
| `kubernetes.io/tls` | TLS certificates |
| `kubernetes.io/dockerconfigjson` | Docker registry credentials |
| `kubernetes.io/basic-auth` | Basic authentication |
| `kubernetes.io/ssh-auth` | SSH credentials |

### Security Warning ⚠️

```
Base64 is ENCODING, not ENCRYPTION!

Anyone with cluster access can decode secrets:
  kubectl get secret my-secret -o jsonpath='{.data.DB_PASSWORD}' | base64 -d

For production, use:
  - Sealed Secrets
  - HashiCorp Vault
  - AWS Secrets Manager
  - Azure Key Vault
  - GCP Secret Manager
```

---

## 3. Ingress

### What is Ingress?

Ingress manages **external HTTP/HTTPS access** to services. It provides:
- Path-based routing
- Host-based routing
- SSL/TLS termination
- Load balancing

### NodePort vs Ingress

```
NodePort Approach (Multiple Ports):

  localhost:30000 ──→ frontend-service
  localhost:30080 ──→ backend-service
  localhost:30090 ──→ another-service

Ingress Approach (Single Entry Point):

  localhost/        ──→ frontend-service
  localhost/api     ──→ backend-service
  localhost/other   ──→ another-service
```

### Ingress Architecture

```
                     INTERNET
                         │
                         ▼
              ┌──────────────────┐
              │ Ingress Controller│  (nginx, traefik, etc.)
              │    Port 80/443    │
              └────────┬─────────┘
                       │
              ┌────────┴────────┐
              │   Ingress Rules  │
              └────────┬────────┘
                       │
     ┌─────────────────┼─────────────────┐
     │                 │                 │
path: /api        path: /auth       path: /
     │                 │                 │
     ▼                 ▼                 ▼
┌─────────┐      ┌─────────┐      ┌─────────┐
│ Backend │      │  Auth   │      │Frontend │
│ Service │      │ Service │      │ Service │
└─────────┘      └─────────┘      └─────────┘
```

### Setting Up Ingress Controller

#### For Colima/k3s

```bash
# Install NGINX Ingress Controller
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/cloud/deploy.yaml

# Wait for it to be ready
kubectl wait --namespace ingress-nginx \
  --for=condition=ready pod \
  --selector=app.kubernetes.io/component=controller \
  --timeout=120s
```

#### For Minikube

```bash
minikube addons enable ingress
```

### Creating Ingress Rules

#### Path-Based Routing

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: app-ingress
spec:
  ingressClassName: nginx
  rules:
    - host: myapp.local
      http:
        paths:
          - path: /api
            pathType: Prefix
            backend:
              service:
                name: backend-service
                port:
                  number: 3001
          - path: /
            pathType: Prefix
            backend:
              service:
                name: frontend-service
                port:
                  number: 3000
```

#### Host-Based Routing

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: multi-host-ingress
spec:
  ingressClassName: nginx
  rules:
    - host: api.myapp.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: backend-service
                port:
                  number: 3001
    - host: www.myapp.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: frontend-service
                port:
                  number: 3000
```

### Adding TLS/HTTPS

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: tls-ingress
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - myapp.com
      secretName: tls-secret    # Contains TLS certificate
  rules:
    - host: myapp.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: frontend-service
                port:
                  number: 3000
```

### Useful Commands

```bash
# List Ingress
kubectl get ingress

# Describe Ingress
kubectl describe ingress app-ingress

# Check Ingress Controller logs
kubectl logs -n ingress-nginx -l app.kubernetes.io/component=controller
```

---

## 4. Hands-On Practice

### Deploy Everything

```bash
# Navigate to project
cd /path/to/k8s-demo-app

# 1. Deploy ConfigMaps
kubectl apply -f backend/backend-configmap.yaml
kubectl apply -f frontend/frontend-configmap.yaml

# 2. Deploy Secrets
kubectl apply -f backend/backend-secret.yaml
kubectl apply -f frontend/frontend-secret.yaml

# 3. Deploy Applications
kubectl apply -f backend/backend-deployment.yaml
kubectl apply -f backend/backend-nodeport-service.yaml
kubectl apply -f frontend/frontend-deployment.yaml
kubectl apply -f frontend/frontend-nodeport-service.yaml

# 4. (Optional) Deploy Ingress
kubectl apply -f ingress.yaml

# Verify
kubectl get all
kubectl get configmaps
kubectl get secrets
kubectl get ingress
```

### Verify Environment Variables

```bash
# Check env vars in a pod
kubectl exec -it <pod-name> -- env | grep -E "NODE_ENV|PORT|API"

# Or get a shell
kubectl exec -it <pod-name> -- sh
# Then: echo $NODE_ENV
```

### Update ConfigMap and Restart

```bash
# Edit ConfigMap
kubectl edit configmap backend-config

# Restart deployment to pick up changes
kubectl rollout restart deployment backend-deployment
```

---

## 5. Best Practices

### ConfigMaps

✅ **DO:**
- Use for non-sensitive configuration
- Keep configs small and focused
- Use meaningful names
- Version your ConfigMaps (app-config-v1)

❌ **DON'T:**
- Store sensitive data
- Create massive ConfigMaps
- Hardcode environment-specific values in images

### Secrets

✅ **DO:**
- Use for passwords, tokens, keys
- Enable encryption at rest
- Use RBAC to limit access
- Rotate secrets regularly
- Use external secret managers in production

❌ **DON'T:**
- Commit secrets to git
- Log secret values
- Share secrets across namespaces unnecessarily

### Ingress

✅ **DO:**
- Use TLS for production
- Set up health checks
- Use meaningful path prefixes
- Configure rate limiting

❌ **DON'T:**
- Expose internal services unnecessarily
- Skip TLS in production
- Use wildcard hosts carelessly

---

## Quick Reference Card

```
┌─────────────────────────────────────────────────────────────┐
│                    QUICK COMMANDS                           │
├─────────────────────────────────────────────────────────────┤
│ ConfigMap                                                   │
│   Create:    kubectl create configmap NAME --from-literal   │
│   View:      kubectl get configmap NAME -o yaml             │
│   Delete:    kubectl delete configmap NAME                  │
├─────────────────────────────────────────────────────────────┤
│ Secret                                                      │
│   Create:    kubectl create secret generic NAME --from-lit  │
│   View:      kubectl get secret NAME -o yaml                │
│   Decode:    echo "BASE64" | base64 -d                      │
├─────────────────────────────────────────────────────────────┤
│ Ingress                                                     │
│   Enable:    minikube addons enable ingress                 │
│   View:      kubectl get ingress                            │
│   Debug:     kubectl describe ingress NAME                  │
└─────────────────────────────────────────────────────────────┘
```

---

## Next Steps

After mastering ConfigMaps, Secrets, and Ingress, consider learning:

1. **Persistent Volumes** - Store data that survives pod restarts
2. **Namespaces** - Organize resources by environment/team
3. **RBAC** - Control who can access what
4. **Helm** - Package and deploy complex applications
5. **Monitoring** - Prometheus, Grafana for observability

