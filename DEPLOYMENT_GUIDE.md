# Kubernetes Deployment Guide

Step-by-step guide to deploy the frontend and backend applications from scratch.

> **Architecture**: Backend uses ClusterIP (internal), Frontend uses NodePort (external access)

---

## Prerequisites

- Docker installed and running
- Kubernetes cluster (minikube/kind/k3s)
- kubectl configured

```bash
# Verify setup
docker --version
kubectl cluster-info
```

---

## Step 1: Build Docker Images

### Backend Image

```bash
cd backend
docker build -t k8s-demo-backend:v1 .
cd ..
```

### Frontend Image

```bash
cd frontend
docker build -t k8s-demo-frontend:v1 .
cd ..
```

> **Minikube users**: Run `eval $(minikube docker-env)` before building images.

---

## Step 2: Create Backend Deployment

Create `backend/backend-deployment.yaml`:

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
          image: k8s-demo-backend:v1
          imagePullPolicy: Never
          ports:
            - containerPort: 3001
```

Apply:

```bash
kubectl apply -f backend/backend-deployment.yaml
```

---

## Step 3: Create Backend ClusterIP Service

Create `backend/backend-clusterip-service.yaml`:

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

Apply:

```bash
kubectl apply -f backend/backend-clusterip-service.yaml
```

> **Note**: ClusterIP makes backend accessible only within the cluster at `backend-service:3001`

---

## Step 4: Create Frontend Deployment

Create `frontend/frontend-deployment.yaml`:

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

Apply:

```bash
kubectl apply -f frontend/frontend-deployment.yaml
```

---

## Step 5: Create Frontend NodePort Service

Create `frontend/frontend-nodeport-service.yaml`:

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

Apply:

```bash
kubectl apply -f frontend/frontend-nodeport-service.yaml
```

---

## Step 6: Verify Deployment

### Check All Resources

```bash
kubectl get deployments
kubectl get pods
kubectl get services
```

Expected output:

```
NAME                  READY   UP-TO-DATE   AVAILABLE
backend-deployment    2/2     2            2
frontend-deployment   2/2     2            2

NAME               TYPE        CLUSTER-IP      PORT(S)
backend-service    ClusterIP   10.x.x.x        3001/TCP
frontend-service   NodePort    10.x.x.x        3000:30000/TCP
```

---

## Step 7: Access the Application

### Frontend (NodePort)

```bash
# Minikube
minikube service frontend-service --url

# Other clusters
# Access via: http://<NODE-IP>:30000
```

### Backend (Internal Only)

Backend is accessible only within the cluster. Frontend communicates with backend using:

```
http://backend-service:3001
```

---

## Quick Deploy Script

Run all steps at once:

```bash
# Build images
docker build -t k8s-demo-backend:v1 ./backend
docker build -t k8s-demo-frontend:v1 ./frontend

# Deploy backend
kubectl apply -f backend/backend-deployment.yaml
kubectl apply -f backend/backend-clusterip-service.yaml

# Deploy frontend
kubectl apply -f frontend/frontend-deployment.yaml
kubectl apply -f frontend/frontend-nodeport-service.yaml

# Verify
kubectl get all
```

---

## Cleanup

Remove all deployed resources:

```bash
kubectl delete deployment backend-deployment frontend-deployment
kubectl delete service backend-service frontend-service
```

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                     Kubernetes Cluster                       │
│                                                              │
│  ┌─────────────────────────┐  ┌─────────────────────────┐   │
│  │   Frontend Deployment   │  │   Backend Deployment    │   │
│  │   ┌─────┐   ┌─────┐    │  │   ┌─────┐   ┌─────┐    │   │
│  │   │Pod 1│   │Pod 2│    │  │   │Pod 1│   │Pod 2│    │   │
│  │   └─────┘   └─────┘    │  │   └─────┘   └─────┘    │   │
│  └───────────┬─────────────┘  └───────────┬─────────────┘   │
│              │                            │                  │
│  ┌───────────▼─────────────┐  ┌───────────▼─────────────┐   │
│  │   frontend-service      │  │   backend-service       │   │
│  │   (NodePort: 30000)     │──│   (ClusterIP)           │   │
│  └───────────┬─────────────┘  └─────────────────────────┘   │
│              │                                               │
└──────────────┼───────────────────────────────────────────────┘
               │
        ┌──────▼──────┐
        │   Browser   │
        │  :30000     │
        └─────────────┘
```

---

## Service Type Summary

| Service | Type | Port | Access |
|---------|------|------|--------|
| backend-service | ClusterIP | 3001 | Internal only |
| frontend-service | NodePort | 30000 | External via node IP |
