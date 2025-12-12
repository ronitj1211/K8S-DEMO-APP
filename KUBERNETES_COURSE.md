# Kubernetes Deployment Course

A step-by-step guide to deploy the **k8s-demo-app** (Frontend + Backend) on Kubernetes.

---

## 📋 Prerequisites

- Docker installed and running
- Kubernetes cluster (minikube, kind, or Docker Desktop)
- `kubectl` CLI configured

---

## 🐳 Building & Loading Images (Local - No Registry Needed!)

You do **NOT** need to push images to a registry for local development.

### Option 1: Minikube (Recommended)

```bash
# Point your shell to minikube's Docker daemon
eval $(minikube docker-env)

# Now build images (they'll be inside minikube)
docker build -t k8s-demo-frontend:v1 ./frontend
docker build -t k8s-demo-backend:v1 ./backend

# Verify images are in minikube
minikube image ls
```

### Option 2: Minikube Image Load

```bash
# Build locally first
docker build -t k8s-demo-frontend:v1 ./frontend
docker build -t k8s-demo-backend:v1 ./backend

# Load into minikube
minikube image load k8s-demo-frontend:v1
minikube image load k8s-demo-backend:v1
```

### Option 3: Kind

```bash
# Build locally
docker build -t k8s-demo-frontend:v1 ./frontend
docker build -t k8s-demo-backend:v1 ./backend

# Load into kind cluster
kind load docker-image k8s-demo-frontend:v1
kind load docker-image k8s-demo-backend:v1
```

### Option 4: Docker Desktop Kubernetes

```bash
# Just build - images are automatically available!
docker build -t k8s-demo-frontend:v1 ./frontend
docker build -t k8s-demo-backend:v1 ./backend
```

### ⚠️ Important: Set imagePullPolicy

When using local images, set `imagePullPolicy: Never` or `imagePullPolicy: IfNotPresent` in your YAML:

```yaml
spec:
  containers:
    - name: backend
      image: k8s-demo-backend:v1
      imagePullPolicy: Never  # Don't try to pull from registry
```

---

## 🎯 Course Outline

| Module | Topic | Status |
|--------|-------|--------|
| 1 | Pods | ⬜ |
| 2 | ReplicaSets | ⬜ |
| 3 | Deployments | ⬜ |
| 4 | Services | ⬜ |
| 5 | ConfigMaps & Secrets | ⬜ |
| 6 | Namespaces | ⬜ |
| 7 | Ingress | ⬜ |
| 8 | Persistent Volumes | ⬜ |
| 9 | Health Checks | ⬜ |
| 10 | Resource Limits | ⬜ |

---

## Module 1: Pods

### What is a Pod?
- Smallest deployable unit in Kubernetes
- Contains one or more containers
- Shares network namespace (localhost) and storage
- Ephemeral - if it dies, it's gone

### 1.1 Backend Pod

Create `k8s/backend-pod.yaml`:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: backend-pod
  labels:
    app: backend
spec:
  containers:
    - name: backend
      image: k8s-demo-backend:v1
      imagePullPolicy: Never    # Use local image
      ports:
        - containerPort: 3001
```

**Commands:**
```bash
# Create the pod
kubectl apply -f k8s/backend-pod.yaml

# Check pod status
kubectl get pods

# View pod details
kubectl describe pod backend-pod

# View logs
kubectl logs backend-pod

# Execute into pod
kubectl exec -it backend-pod -- sh

# Delete pod
kubectl delete pod backend-pod
```

### 1.2 Frontend Pod

Create `k8s/frontend-pod.yaml`:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: frontend-pod
  labels:
    app: frontend
spec:
  containers:
    - name: frontend
      image: k8s-demo-frontend:v1
      imagePullPolicy: Never    # Use local image
      ports:
        - containerPort: 3000
```

### 1.3 Multi-Container Pod (Sidecar Pattern)

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: backend-with-sidecar
spec:
  containers:
    - name: backend
      image: k8s-demo-backend:v1
      imagePullPolicy: Never
      ports:
        - containerPort: 3001
    - name: log-agent
      image: busybox
      command: ['sh', '-c', 'tail -f /dev/null']
```

### ⚠️ Pod Limitations
- No auto-restart on failure
- No scaling
- No rolling updates
- No load balancing

**Next: ReplicaSets solve the scaling problem →**

---

## Module 2: ReplicaSets

### What is a ReplicaSet?
- Ensures a specified number of pod replicas are running
- Auto-replaces failed pods
- Selector-based pod management

### 2.1 Backend ReplicaSet

Create `k8s/backend-replicaset.yaml`:

```yaml
apiVersion: apps/v1
kind: ReplicaSet
metadata:
  name: backend-rs
spec:
  replicas: 3
  selector:
    matchLabels:
      app: backend
  template:
    metadata:
      labels:
        app: backend
    spec:
      containers:
        - name: backend
          image: k8s-demo-backend:v1
          imagePullPolicy: Never
          ports:
            - containerPort: 3001
```

**Commands:**
```bash
# Create ReplicaSet
kubectl apply -f k8s/backend-replicaset.yaml

# Check ReplicaSet
kubectl get rs

# Scale manually
kubectl scale rs backend-rs --replicas=5

# Delete a pod (watch it recreate)
kubectl delete pod <pod-name>
```

### ⚠️ ReplicaSet Limitations
- No rolling updates (all-or-nothing)
- No rollback capability
- No version history

**Next: Deployments add rolling updates →**

---

## Module 3: Deployments

### What is a Deployment?
- Manages ReplicaSets
- Rolling updates & rollbacks
- Version history
- **Recommended way to manage pods**

### 3.1 Backend Deployment

Create `k8s/backend-deployment.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: backend
spec:
  replicas: 3
  selector:
    matchLabels:
      app: backend
  template:
    metadata:
      labels:
        app: backend
    spec:
      containers:
        - name: backend
          image: k8s-demo-backend:v1
          imagePullPolicy: Never
          ports:
            - containerPort: 3001
```

### 3.2 Frontend Deployment

Create `k8s/frontend-deployment.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: frontend
spec:
  replicas: 2
  selector:
    matchLabels:
      app: frontend
  template:
    metadata:
      labels:
        app: frontend
    spec:
      containers:
        - name: frontend
          image: k8s-demo-frontend:v1
          imagePullPolicy: Never
          ports:
            - containerPort: 3000
```

**Commands:**
```bash
# Apply deployment
kubectl apply -f k8s/backend-deployment.yaml

# Check deployment status
kubectl get deployments
kubectl rollout status deployment/backend

# Update image (triggers rolling update)
kubectl set image deployment/backend backend=k8s-demo-backend:v2

# View rollout history
kubectl rollout history deployment/backend

# Rollback to previous version
kubectl rollout undo deployment/backend

# Rollback to specific revision
kubectl rollout undo deployment/backend --to-revision=2
```

**Next: Services expose pods to network →**

---

## Module 4: Services

### What is a Service?
- Stable network endpoint for pods
- Load balancing across pods
- Service discovery via DNS

### Service Types
| Type | Description |
|------|-------------|
| ClusterIP | Internal only (default) |
| NodePort | Exposes on node's IP:port |
| LoadBalancer | Cloud provider load balancer |

### 4.1 Backend Service (ClusterIP)

Create `k8s/backend-service.yaml`:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: backend-service
spec:
  type: ClusterIP
  selector:
    app: backend
  ports:
    - port: 3001
      targetPort: 3001
```

### 4.2 Frontend Service (NodePort)

Create `k8s/frontend-service.yaml`:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: frontend-service
spec:
  type: NodePort
  selector:
    app: frontend
  ports:
    - port: 3000
      targetPort: 3000
      nodePort: 30080  # Access via <node-ip>:30080
```

**Commands:**
```bash
# Create services
kubectl apply -f k8s/backend-service.yaml
kubectl apply -f k8s/frontend-service.yaml

# List services
kubectl get svc

# Get service details
kubectl describe svc backend-service

# Test internal DNS (from another pod)
curl http://backend-service:3001
```

**Next: ConfigMaps for configuration →**

---

## Module 5: ConfigMaps & Secrets

### 5.1 ConfigMap

Create `k8s/configmap.yaml`:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
data:
  NODE_ENV: "production"
  API_URL: "http://backend-service:3001"
  LOG_LEVEL: "info"
```

**Using ConfigMap in Deployment:**

```yaml
spec:
  containers:
    - name: frontend
      image: k8s-demo-frontend:v1
      imagePullPolicy: Never
      envFrom:
        - configMapRef:
            name: app-config
      # OR individual keys:
      env:
        - name: API_URL
          valueFrom:
            configMapKeyRef:
              name: app-config
              key: API_URL
```

### 5.2 Secrets

```bash
# Create secret from literal
kubectl create secret generic db-secret \
  --from-literal=username=admin \
  --from-literal=password=secretpass
```

Or via YAML (base64 encoded):

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: db-secret
type: Opaque
data:
  username: YWRtaW4=      # echo -n 'admin' | base64
  password: c2VjcmV0cGFzcw==  # echo -n 'secretpass' | base64
```

**Next: Namespaces for isolation →**

---

## Module 6: Namespaces

### What is a Namespace?
- Virtual cluster within a cluster
- Resource isolation
- Access control boundary

Create `k8s/namespace.yaml`:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: k8s-demo
```

**Commands:**
```bash
# Create namespace
kubectl apply -f k8s/namespace.yaml

# Apply resources to namespace
kubectl apply -f k8s/ -n k8s-demo

# Set default namespace
kubectl config set-context --current --namespace=k8s-demo

# List all namespaces
kubectl get ns
```

**Next: Ingress for external access →**

---

## Module 7: Ingress

### What is Ingress?
- HTTP/HTTPS routing
- Path-based routing
- Host-based routing
- SSL termination

### Prerequisites
```bash
# Install ingress controller (nginx)
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/cloud/deploy.yaml
```

Create `k8s/ingress.yaml`:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: app-ingress
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
spec:
  ingressClassName: nginx
  rules:
    - host: myapp.local
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: frontend-service
                port:
                  number: 3000
          - path: /api
            pathType: Prefix
            backend:
              service:
                name: backend-service
                port:
                  number: 3001
```

---

## Module 8: Persistent Volumes

*Coming soon...*

---

## Module 9: Health Checks

### Liveness & Readiness Probes

```yaml
spec:
  containers:
    - name: backend
      image: k8s-demo-backend:v1
      imagePullPolicy: Never
      livenessProbe:
        httpGet:
          path: /health
          port: 3001
        initialDelaySeconds: 10
        periodSeconds: 5
      readinessProbe:
        httpGet:
          path: /ready
          port: 3001
        initialDelaySeconds: 5
        periodSeconds: 3
```

---

## Module 10: Resource Limits

```yaml
spec:
  containers:
    - name: backend
      image: k8s-demo-backend:v1
      imagePullPolicy: Never
      resources:
        requests:
          memory: "128Mi"
          cpu: "100m"
        limits:
          memory: "256Mi"
          cpu: "500m"
```

---

## 🚀 Quick Reference

```bash
# Common kubectl commands
kubectl get all                    # List all resources
kubectl get pods -o wide           # Pods with more details
kubectl logs -f <pod>              # Stream logs
kubectl exec -it <pod> -- sh       # Shell into pod
kubectl port-forward <pod> 8080:3000  # Local port forward
kubectl delete -f k8s/             # Delete all resources
```

---

## 📁 Final Directory Structure

```
k8s/
├── namespace.yaml
├── configmap.yaml
├── secrets.yaml
├── backend-deployment.yaml
├── backend-service.yaml
├── frontend-deployment.yaml
├── frontend-service.yaml
└── ingress.yaml
```

---

**Happy Learning! 🎉**
