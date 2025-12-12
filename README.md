# K8s Demo App 🚀

A sample full-stack application designed for local Kubernetes deployment.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    Kubernetes Cluster                     │
│  ┌─────────────────┐          ┌─────────────────┐        │
│  │    Frontend     │          │     Backend     │        │
│  │   (2 replicas)  │ ──────▶  │   (2 replicas)  │        │
│  │    Port 3000    │          │    Port 3001    │        │
│  └─────────────────┘          └─────────────────┘        │
│           │                            │                  │
│  ┌────────┴────────┐          ┌───────┴────────┐         │
│  │ Service: NodePort│         │ Service: ClusterIP│       │
│  └─────────────────┘          └────────────────┘         │
└──────────────────────────────────────────────────────────┘
```

## Prerequisites

- **Docker Desktop** with Kubernetes enabled, OR
- **Minikube** installed and running
- **kubectl** CLI installed

### macOS Quick Setup

```bash
# Option 1: Docker Desktop (Recommended)
# Install Docker Desktop, then enable Kubernetes in Settings > Kubernetes

# Option 2: Minikube
brew install minikube
minikube start
```

## Quick Start

### 1. Deploy with Script

```bash
cd k8s-demo-app

# Make script executable
chmod +x deploy.sh

# Deploy everything
./deploy.sh

# To cleanup/delete
./deploy.sh cleanup
```

### 2. Manual Deployment

```bash
# Build Docker images
docker build -t k8s-demo-backend:latest ./backend
docker build -t k8s-demo-frontend:latest ./frontend

# If using Minikube, build images in Minikube's Docker:
# eval $(minikube docker-env)
# docker build -t k8s-demo-backend:latest ./backend
# docker build -t k8s-demo-frontend:latest ./frontend

# Create namespace and deploy
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/configmap.yaml
kubectl apply -f k8s/backend-deployment.yaml
kubectl apply -f k8s/frontend-deployment.yaml
```

## Accessing the Application

### Docker Desktop

```bash
# Get the NodePort
kubectl get svc frontend -n k8s-demo

# Or use port-forwarding (recommended)
kubectl port-forward svc/frontend 3000:3000 -n k8s-demo &
kubectl port-forward svc/backend 3001:3001 -n k8s-demo &

# Access at http://localhost:3000
```

### Minikube

```bash
# Get service URL
minikube service frontend -n k8s-demo

# Or use tunnel
minikube tunnel
```

## Useful Commands

```bash
# Check pod status
kubectl get pods -n k8s-demo

# View logs
kubectl logs -f deployment/backend -n k8s-demo
kubectl logs -f deployment/frontend -n k8s-demo

# Describe resources
kubectl describe deployment backend -n k8s-demo
kubectl describe deployment frontend -n k8s-demo

# Scale deployments
kubectl scale deployment backend --replicas=3 -n k8s-demo

# Delete everything
kubectl delete namespace k8s-demo
```

## Project Structure

```
k8s-demo-app/
├── backend/
│   ├── Dockerfile
│   ├── package.json
│   └── server.js
├── frontend/
│   ├── Dockerfile
│   ├── package.json
│   ├── index.html
│   └── src/
│       ├── app.js
│       └── styles.css
├── k8s/
│   ├── namespace.yaml
│   ├── configmap.yaml
│   ├── backend-deployment.yaml
│   ├── frontend-deployment.yaml
│   └── ingress.yaml
├── deploy.sh
└── README.md
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/api/info` | GET | Server/pod information |
| `/api/items` | GET | List all items |
| `/api/items/:id` | GET | Get item by ID |

## Troubleshooting

### Pods stuck in ImagePullBackOff

This means Kubernetes can't find the Docker images. Ensure:

1. Images are built locally: `docker images | grep k8s-demo`
2. `imagePullPolicy: Never` is set in deployments
3. For Minikube, build images in Minikube's Docker: `eval $(minikube docker-env)`

### Connection refused to backend

1. Check if backend pods are running: `kubectl get pods -n k8s-demo`
2. Check backend logs: `kubectl logs deployment/backend -n k8s-demo`
3. Verify service exists: `kubectl get svc -n k8s-demo`

### Frontend can't connect to backend

When using port-forwarding, the frontend needs the backend URL updated:
- The default frontend expects backend at `http://localhost:3001`
- Make sure you're port-forwarding both services

## Development

### Run locally without Kubernetes

```bash
# Backend
cd backend
npm install
npm start

# Frontend (in another terminal)
cd frontend
npm install
npm start
```

---

Built with ♥ for Kubernetes learning

