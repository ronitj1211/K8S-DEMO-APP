# Service Deployment Guide

Complete guide to deploy the K8s Demo App with frontend and backend services.

> **Architecture**: Both Frontend and Backend use NodePort for browser access

---

## Architecture Overview

```
┌────────────────────────────────────────────────────────────────────────────┐
│                          KUBERNETES CLUSTER                                 │
│                                                                             │
│   ┌─────────────────────────┐            ┌─────────────────────────┐       │
│   │  frontend-deployment    │            │  backend-deployment     │       │
│   │  ┌───────┐  ┌───────┐   │            │  ┌───────┐  ┌───────┐   │       │
│   │  │ Pod 1 │  │ Pod 2 │   │            │  │ Pod 1 │  │ Pod 2 │   │       │
│   │  └───────┘  └───────┘   │            │  └───────┘  └───────┘   │       │
│   └───────────┬─────────────┘            └───────────┬─────────────┘       │
│               │                                      │                      │
│   ┌───────────▼─────────────┐            ┌───────────▼─────────────┐       │
│   │   frontend-service      │            │   backend-service       │       │
│   │   NodePort: 30000       │            │   NodePort: 30080       │       │
│   └───────────┬─────────────┘            └───────────┬─────────────┘       │
│               │                                      │                      │
└───────────────┼──────────────────────────────────────┼──────────────────────┘
                │                                      │
                ▼                                      ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                              USER'S BROWSER                                 │
│                                                                             │
│   1. Load page ────► http://<minikube-ip>:30000                            │
│   2. API calls ────► http://<minikube-ip>:30080                            │
│                                                                             │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## Prerequisites

| Tool | Verify Command |
|------|----------------|
| Docker | `docker --version` |
| Minikube | `minikube version` |
| kubectl | `kubectl version --client` |

---

## Step 1: Start Minikube

```bash
minikube start
```

Verify cluster is running:

```bash
kubectl cluster-info
```

---

## Step 2: Configure Docker Environment

**Important**: Build images inside Minikube's Docker daemon.

```bash
eval $(minikube docker-env)
```

> Run this in every new terminal session.

---

## Step 3: Build Docker Images

```bash
# Build backend image
docker build -t k8s-demo-backend:v2 ./backend

# Build frontend image  
docker build -t k8s-demo-frontend:v1 ./frontend
```

Verify images:

```bash
docker images | grep k8s-demo
```

---

## Step 4: Deploy Backend

### 4.1 Apply Backend Deployment

```bash
kubectl apply -f backend/backend-deployment.yaml
```

**File: `backend/backend-deployment.yaml`**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: backend-deployment
spec:
  replicas: 2
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
          image: k8s-demo-backend:v2
          imagePullPolicy: Never
          ports:
            - containerPort: 3001
```

### 4.2 Apply Backend Service (NodePort)

```bash
kubectl apply -f backend/backend-nodeport-service.yaml
```

**File: `backend/backend-nodeport-service.yaml`**

```yaml
apiVersion: v1
kind: Service
metadata:
  name: backend-service
spec:
  type: NodePort
  selector:
    app: backend
  ports:
    - port: 3001
      targetPort: 3001
      nodePort: 30080
```

---

## Step 5: Deploy Frontend

### 5.1 Apply Frontend Deployment

```bash
kubectl apply -f frontend/frontend-deployment.yaml
```

**File: `frontend/frontend-deployment.yaml`**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: frontend-deployment
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

### 5.2 Apply Frontend Service (NodePort)

```bash
kubectl apply -f frontend/frontend-nodeport-service.yaml
```

**File: `frontend/frontend-nodeport-service.yaml`**

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
      nodePort: 30000
```

---

## Step 6: Verify Deployment

### Check Pods

```bash
kubectl get pods
```

Expected:

```
NAME                                   READY   STATUS    RESTARTS   AGE
backend-deployment-xxxxx-xxxxx         1/1     Running   0          1m
backend-deployment-xxxxx-xxxxx         1/1     Running   0          1m
frontend-deployment-xxxxx-xxxxx        1/1     Running   0          1m
frontend-deployment-xxxxx-xxxxx        1/1     Running   0          1m
```

### Check Services

```bash
kubectl get services
```

Expected:

```
NAME               TYPE        CLUSTER-IP      PORT(S)          AGE
backend-service    NodePort    10.x.x.x        3001:30080/TCP   1m
frontend-service   NodePort    10.x.x.x        3000:30000/TCP   1m
kubernetes         ClusterIP   10.96.0.1       443/TCP          10m
```

### Check Deployments

```bash
kubectl get deployments
```

Expected:

```
NAME                  READY   UP-TO-DATE   AVAILABLE   AGE
backend-deployment    2/2     2            2           1m
frontend-deployment   2/2     2            2           1m
```

---

## Step 7: Access the Application

### Get Frontend URL

```bash
minikube service frontend-service --url
```

Output:

```
http://192.168.49.2:30000
```

### Open in Browser

```bash
# Auto-open in browser
minikube service frontend-service
```

Or manually visit: `http://<minikube-ip>:30000`

---

## How Frontend Connects to Backend

The frontend JavaScript dynamically detects the backend URL:

```javascript
// frontend/src/app.js
const API_URL = window.API_URL || (
  window.location.hostname === 'localhost' 
    ? 'http://localhost:3001' 
    : `http://${window.location.hostname}:30080`
);
```

| Environment | API_URL |
|-------------|---------|
| Local Dev | `http://localhost:3001` |
| Kubernetes | `http://<minikube-ip>:30080` |

---

## Quick Deploy (All-in-One)

```bash
#!/bin/bash

# Start minikube
minikube start

# Use minikube's docker
eval $(minikube docker-env)

# Build images
docker build -t k8s-demo-backend:v2 ./backend
docker build -t k8s-demo-frontend:v1 ./frontend

# Deploy backend
kubectl apply -f backend/backend-deployment.yaml
kubectl apply -f backend/backend-nodeport-service.yaml

# Deploy frontend
kubectl apply -f frontend/frontend-deployment.yaml
kubectl apply -f frontend/frontend-nodeport-service.yaml

# Wait for pods
kubectl wait --for=condition=ready pod -l app=backend --timeout=60s
kubectl wait --for=condition=ready pod -l app=frontend --timeout=60s

# Open in browser
minikube service frontend-service
```

---

## Useful Commands

| Command | Description |
|---------|-------------|
| `kubectl get all` | View all resources |
| `kubectl logs <pod-name>` | View pod logs |
| `kubectl describe pod <pod-name>` | Pod details |
| `kubectl exec -it <pod-name> -- sh` | Shell into pod |
| `minikube dashboard` | Open K8s dashboard |

---

## Troubleshooting

### Pods not starting?

```bash
kubectl describe pod <pod-name>
kubectl logs <pod-name>
```

### Image pull errors?

Make sure you ran `eval $(minikube docker-env)` before building.

### Frontend can't connect to backend?

1. Check backend service is running: `kubectl get svc backend-service`
2. Test backend directly: `curl http://$(minikube ip):30080/health`

### Reset everything?

```bash
kubectl delete deployment backend-deployment frontend-deployment
kubectl delete service backend-service frontend-service
```

---

## Cleanup

Remove all deployed resources:

```bash
# Delete deployments and services
kubectl delete -f backend/backend-deployment.yaml
kubectl delete -f backend/backend-nodeport-service.yaml
kubectl delete -f frontend/frontend-deployment.yaml
kubectl delete -f frontend/frontend-nodeport-service.yaml

# Or delete all at once
kubectl delete deployment --all
kubectl delete service backend-service frontend-service
```

Stop Minikube:

```bash
minikube stop
```

---

## Summary

| Component | Type | Port | External Access |
|-----------|------|------|-----------------|
| Frontend Deployment | Deployment | 3000 | - |
| Frontend Service | NodePort | 30000 | `http://<ip>:30000` |
| Backend Deployment | Deployment | 3001 | - |
| Backend Service | NodePort | 30080 | `http://<ip>:30080` |
