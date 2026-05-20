# Run Steps — Pods on Colima (k3s)

This is the concrete sequence of commands used to run this folder's Pods on the local cluster. The main [README.md](README.md) covers the concepts and a generic recipe; this file logs **exactly what we ran** on a **Colima + k3s** setup.

> Cluster context used here: `colima` (Kubernetes provided by k3s, container runtime `docker`).
> On this setup, images built with `docker build` are visible to k3s — no `kind load` / `minikube docker-env` step is needed.

---

## 0. Verify the cluster

```bash
colima status
kubectl cluster-info
kubectl config current-context     # expect: colima
kubectl get nodes                  # expect: 1 node, Ready, k3s
```

---

## 1. Build the images

The Pod manifests reference `k8s-demo-backend:1.0` and `k8s-demo-frontend:1.0`, so we tag exactly those.

```bash
cd K8S-demo-concept-wise-project/kubernetes-pods/backend
docker build -t k8s-demo-backend:1.0 .

cd ../frontend
docker build -t k8s-demo-frontend:1.0 .
```

Sanity check that k3s can see them:

```bash
colima ssh -- sudo crictl images | grep k8s-demo
```

---

## 2. Apply the single-container Pods

```bash
kubectl apply -f backend/backend-pod.yaml
kubectl apply -f frontend/frontend-pod.yaml

kubectl get pods            # wait until both show 1/1 Running
```

---

## 3. Port-forward and hit the backend

In one terminal:

```bash
kubectl port-forward pod/backend-pod 3000:3000
```

In another:

```bash
curl http://localhost:3000/
```

Expected response (your `podIP` will differ):

```json
{"message":"Hello from backend Pod","hostname":"backend-pod","podIP":"10.42.0.15","time":"..."}
```

---

## 4. Port-forward and open the frontend

Keep the backend port-forward running, then in a new terminal:

```bash
kubectl port-forward pod/frontend-pod 8080:80
```

Open <http://localhost:8080> in a browser. Click **Call backend** — the page fetches `http://localhost:3000` via your laptop, so both port-forwards must be active.

---

## 5. Try the multi-container (sidecar) Pod

```bash
kubectl apply -f backend/multi-container-pod.yaml
kubectl get pod backend-with-sidecar      # wait for 2/2 Running

kubectl logs backend-with-sidecar -c backend
kubectl logs backend-with-sidecar -c log-sidecar
```

`-c <container>` is required because there's more than one container in the Pod. Both containers share the same Pod IP and can talk over `localhost`.

---

## 6. Cleanup

```bash
kubectl delete -f backend/backend-pod.yaml
kubectl delete -f backend/multi-container-pod.yaml
kubectl delete -f frontend/frontend-pod.yaml

# Stop any port-forwards still running in background terminals.
```

---

## Notes specific to this setup

- **No image-import step.** Because Colima's k3s uses the same docker daemon, `docker build` is enough. On `kind` you'd need `kind load docker-image ...`; on `minikube` you'd need `eval $(minikube docker-env)` before building.
- **Image tags must match the manifest.** Pre-existing `:v1` images on this machine were ignored by the Pods — the manifests pin `:1.0`. Build with the exact tag.
- **`imagePullPolicy: IfNotPresent`** in the manifests is what lets k3s use the locally-built image instead of trying to pull from a registry.
