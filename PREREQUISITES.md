# Prerequisites & First Pod Setup

Everything you need to get Kubernetes running on your local machine.

---

## ✅ Required Tools Checklist

| Tool | Purpose | Required |
|------|---------|----------|
| Docker | Container runtime | ✅ Yes |
| kubectl | Kubernetes CLI | ✅ Yes |
| minikube | Local K8s cluster | ✅ Yes |

---

## 🍎 Installation (macOS)

### 1. Install Homebrew (if not installed)

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

### 2. Install Docker Desktop

```bash
brew install --cask docker
```

Or download from: https://www.docker.com/products/docker-desktop

### 3. Install kubectl

```bash
brew install kubectl
```

### 4. Install minikube

```bash
brew install minikube
```

---

## 🔍 Verify Installation

Run these commands to verify everything is installed:

```bash
# Check Docker
docker --version
# Expected: Docker version 2X.X.X

# Check kubectl
kubectl version --client
# Expected: Client Version: vX.XX.X

# Check minikube
minikube version
# Expected: minikube version: vX.XX.X
```

---

## 🚀 Starting Your Environment

### Step 1: Start Docker Desktop

```bash
# Open Docker Desktop app
open -a Docker
```

Wait until the Docker icon in menu bar shows **"Docker Desktop is running"**.

Verify Docker is running:
```bash
docker info
# Should show Docker system information (no errors)
```

### Step 2: Start Minikube Cluster

```bash
# Start minikube with Docker driver
minikube start --driver=docker
```

**First time takes 2-5 minutes** (downloads Kubernetes images).

Expected output:
```
✅ minikube v1.XX.X
✅ Using the docker driver
✅ Starting control plane node minikube
✅ Preparing Kubernetes vX.XX.X
✅ Configuring local host environment
🏄 Done! kubectl is now configured to use "minikube" cluster
```

### Step 3: Verify Cluster is Running

```bash
# Check minikube status
minikube status

# Expected output:
# minikube
# type: Control Plane
# host: Running
# kubelet: Running
# apiserver: Running
# kubeconfig: Configured
```

```bash
# Check kubectl can connect
kubectl cluster-info

# Expected output:
# Kubernetes control plane is running at https://127.0.0.1:XXXXX
```

```bash
# List nodes
kubectl get nodes

# Expected output:
# NAME       STATUS   ROLES           AGE   VERSION
# minikube   Ready    control-plane   XX    vX.XX.X
```

---

## 🐳 Build Your Docker Images

Before creating pods, build the app images inside minikube:

```bash
# Point shell to minikube's Docker daemon
By default:

Your Mac uses your local Docker engine

Minikube uses its own Docker engine inside the Minikube VM/container

So if you build a Docker image on your Mac, Minikube cannot see it.

eval $(minikube docker-env)

means:

✔ Set my Docker CLI to use Minikube’s Docker engine
✔ Any docker build, docker images, docker run now happens inside Minikube
✔ Kubernetes inside Minikube can now see the images automatically

eval $(minikube docker-env)
docker build -t k8s-demo-backend:v1 .

This builds the image inside Minikube’s Docker, making the image instantly available for Kubernetes pods.
 --------------------------------

# Build backend image
docker build -t k8s-demo-backend:v1 ./backend

# Build frontend image
docker build -t k8s-demo-frontend:v1 ./frontend

# Verify images exist
docker images | grep k8s-demo
```

---

## 🎯 Create Your First Pod!

### Step 1: Create the k8s folder

```bash
mkdir -p k8s
```

### Step 2: Create Pod YAML file

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
      imagePullPolicy: Never
      ports:
        - containerPort: 3001
```

### Step 3: Deploy the Pod

```bash
# Create the pod
kubectl apply -f k8s/backend-pod.yaml

# Expected output:
# pod/backend-pod created
```

### Step 4: Verify Pod is Running

```bash
# Check pod status
kubectl get pods

# Expected output:
# NAME          READY   STATUS    RESTARTS   AGE
# backend-pod   1/1     Running   0          10s
```

```bash
# Watch pods in real-time (Ctrl+C to exit)
kubectl get pods -w
```

### Step 5: Explore Your Pod

```bash
# View pod details
kubectl describe pod backend-pod

# View pod logs
kubectl logs backend-pod

# Execute command inside pod
kubectl exec -it backend-pod -- sh

# Inside the pod, you can run:
# ls
# env
# exit
```

### Step 6: Access Your Pod (Port Forward)

```bash
# Forward local port 3001 to pod port 3001
kubectl port-forward backend-pod 3001:3001

# Now open browser: http://localhost:3001
```

### Step 7: Clean Up

```bash
# Delete the pod
kubectl delete pod backend-pod

# Verify it's gone
kubectl get pods
```

---

## 🎉 Congratulations!

You've successfully:
- ✅ Installed all prerequisites
- ✅ Started a Kubernetes cluster
- ✅ Built Docker images
- ✅ Created your first Pod
- ✅ Explored and accessed the Pod

---

## 📋 Quick Reference Commands

```bash
# --- Docker ---
open -a Docker              # Start Docker Desktop
docker info                 # Check Docker status

# --- Minikube ---
minikube start              # Start cluster
minikube stop               # Stop cluster
minikube delete             # Delete cluster
minikube status             # Check status
minikube dashboard          # Open K8s dashboard (web UI)
eval $(minikube docker-env) # Use minikube's Docker

# --- kubectl ---
kubectl get pods            # List pods
kubectl get all             # List all resources
kubectl describe pod <name> # Pod details
kubectl logs <pod>          # View logs
kubectl exec -it <pod> -- sh # Shell into pod
kubectl delete pod <name>   # Delete pod
kubectl apply -f <file>     # Create from YAML
```

---

## ⚠️ Common Issues & Fixes

### Issue: "docker: command not found"
**Fix:** Install Docker Desktop and restart terminal.

### Issue: "minikube start" hangs
**Fix:** Ensure Docker Desktop is fully running first.

### Issue: Pod stuck in "ImagePullBackOff"
**Fix:** You forgot `imagePullPolicy: Never` or didn't build the image in minikube's Docker.

```bash
# Re-run these commands:
eval $(minikube docker-env)
docker build -t k8s-demo-backend:v1 ./backend
```

### Issue: "The connection to the server localhost:8080 was refused"
**Fix:** Start minikube first: `minikube start`

### Issue: Pod in "CrashLoopBackOff"
**Fix:** Check logs for errors:
```bash
kubectl logs backend-pod
kubectl describe pod backend-pod
```

---

## 🛑 Stopping Everything

When you're done for the day:

```bash
# Stop minikube (preserves cluster)
minikube stop

# Quit Docker Desktop (optional)
osascript -e 'quit app "Docker"'
```

To resume later:
```bash
open -a Docker
# Wait for Docker to start...
minikube start
```

---

**Next Step:** Continue to `KUBERNETES_COURSE.md` → Module 1 (Pods) 📚
