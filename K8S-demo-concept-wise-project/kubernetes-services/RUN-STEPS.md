# Run Steps — Services on Colima (k3s)

Concrete sequence to bring up this folder on a **Colima + k3s** cluster. See [README.md](README.md) for the concept walk-through.

> Cluster: `colima` (k3s + docker runtime). Images built via `docker build` are immediately usable — no `kind load` / `minikube docker-env` step.

---

## 0. Pre-check

```bash
kubectl get pods -A | head            # cluster healthy
kubectl get svc                       # expect only the default `kubernetes` Service
```

---

## 1. CORS fix on the backend (one-time)

The frontend page (served at NodePort `30081`) calls the backend (NodePort `30080`) — different ports, so the browser treats them as different origins. Add this near the top of [backend/server.js](backend/server.js):

```js
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});
```

Without it the frontend shows **`Error: Failed to fetch`** in the browser even though the Service responds fine to `curl`.

---

## 2. Build images

Tags must match the manifests (`k8s-demo-backend:1.0`, `k8s-demo-frontend:1.0`) and these are **shared across all concept-wise folders** — whichever you built last is what k3s runs:

```bash
cd K8S-demo-concept-wise-project/kubernetes-services/backend
docker build -t k8s-demo-backend:1.0 .

cd ../frontend
docker build -t k8s-demo-frontend:1.0 .
```

---

## 3. Apply Deployment + all three Service types + frontend

The folder has `package.json` next to the YAMLs, so `kubectl apply -f backend/` will trip on it. Apply files individually (or move the package.json out):

```bash
cd K8S-demo-concept-wise-project/kubernetes-services

kubectl apply -f backend/backend-deployment.yaml
kubectl apply -f backend/backend-clusterip-service.yaml
kubectl apply -f backend/backend-nodeport-service.yaml
kubectl apply -f backend/backend-loadbalancer-service.yaml
kubectl apply -f frontend/frontend-deployment.yaml

kubectl rollout status deployment/backend
kubectl rollout status deployment/frontend
```

Inspect:

```bash
kubectl get svc
kubectl get endpoints                 # which Pods sit behind each Service
```

Expected: 3 backend Pods, 1 frontend Pod, 4 services + the cluster default.

---

## 4. Test each Service type

### ClusterIP (in-cluster only)

```bash
kubectl run debug --rm -i --restart=Never --image=curlimages/curl \
  --command -- sh -c 'for i in 1 2 3 4 5; do curl -s http://backend-clusterip; echo; done'
```

You'll see `hostname` rotate across the 3 backend Pods — proof the Service is load-balancing.

### NodePort (from your laptop)

Colima exposes ports in the NodePort range (30000–32767) on `localhost`, so the manifests' explicit `nodePort: 30080`/`30081` Just Work:

```bash
curl http://localhost:30080/                       # backend via NodePort
curl -o /dev/null -w "%{http_code}\n" http://localhost:30081/   # frontend (200)
```

Open the frontend at <http://localhost:30081>, leave the backend URL as `http://localhost:30080`, and click **Call 20x** to see the Service distribute requests across Pods.

### LoadBalancer

k3s ships **ServiceLB (klipper-lb)** which provisions an external IP without a cloud provider. After `apply`:

```bash
kubectl get svc backend-lb
# EXTERNAL-IP shows something like 192.168.5.1 (the colima VM IP)
```

On a managed cloud cluster (EKS/GKE/AKS) that EXTERNAL-IP would be a public IP you could `curl` directly. On Colima, **the LB IP is inside the VM network and isn't reachable from macOS**. The same Service is still load-balancing across Pods — verify in-cluster:

```bash
kubectl run debug --rm -i --restart=Never --image=curlimages/curl \
  -- curl -s http://backend-lb
```

Or use a port-forward to reach it from the host:

```bash
kubectl port-forward svc/backend-lb 8080:80
curl http://localhost:8080/
```

---

## 5. Watch the endpoints update live

```bash
kubectl get endpoints backend-clusterip -w
# in another terminal:
kubectl delete pod -l app=backend --field-selector status.phase=Running | head -1   # delete one
```

The endpoints list immediately drops the dead Pod's IP and adds the replacement's — that's why Services give a stable address while Pod IPs churn.

---

## 6. Cleanup

```bash
cd K8S-demo-concept-wise-project/kubernetes-services
kubectl delete -f backend/backend-deployment.yaml \
                -f backend/backend-clusterip-service.yaml \
                -f backend/backend-nodeport-service.yaml \
                -f backend/backend-loadbalancer-service.yaml \
                -f frontend/frontend-deployment.yaml
```

---

## Notes specific to this setup

- **Colima exposes NodePorts on `localhost`.** Anything in 30000–32767 declared explicitly in the manifest is reachable via `localhost:<nodePort>`. Auto-allocated NodePorts (e.g. the one ServiceLB assigns to a LoadBalancer Service) are **not** automatically exposed — `curl localhost:32206` returns "connection refused". Use the EXTERNAL-IP in-cluster, or `kubectl port-forward` from the host.
- **k3s ServiceLB (klipper) gives every LoadBalancer Service a real EXTERNAL-IP**, but on Colima that IP is the VM's, not your laptop's. The Service still works; just access it from inside the cluster or via port-forward.
- **CORS still bites here.** Frontend (`localhost:30081`) and backend (`localhost:30080`) are different origins. The CORS middleware in step 1 is what makes the browser demo work. With Ingress (next folder) both can sit behind one host and CORS goes away.
- **`kubectl apply -f backend/` fails** on this folder because `package.json` is next to the YAMLs — apply files individually.
