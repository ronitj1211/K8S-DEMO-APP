# Run Steps — DaemonSets on Colima (k3s)

Concrete commands to walk through the DaemonSet demo on **Colima + k3s**. See [README.md](README.md) for the concepts.

> Single-node cluster note: Colima has one node, so the DaemonSet creates exactly one Pod. You still get to see the per-node identity (`nodeName`), hostPath mount, and ServiceAccount/Service plumbing — just not `nodeName` rotation. To see that, add nodes (e.g. `colima start --nodes 3`) and re-run.

---

## 0. Pre-check

```bash
kubectl get nodes      # how many nodes? on Colima, expect 1 named "colima"
kubectl get ds         # No resources (default ns)
```

---

## 1. CORS fix on the backend

The frontend calls the agent across NodePorts. Add to [backend/server.js](backend/server.js):

```js
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});
```

---

## 2. Build images

```bash
cd K8S-demo-concept-wise-project/daemonsets/backend
docker build -t k8s-demo-node-agent:1.0 .

cd ../frontend
docker build -t k8s-demo-frontend:1.0 .
```

> The frontend uses the shared `k8s-demo-frontend:1.0` tag. Each concept folder ships its own `index.html`, so **rebuild before each demo**.

---

## 3. Apply

```bash
cd K8S-demo-concept-wise-project/daemonsets

kubectl apply -f backend/node-agent-daemonset.yaml
kubectl apply -f backend/node-agent-service.yaml
kubectl apply -f frontend/frontend.yaml

kubectl get ds                       # DESIRED == AVAILABLE == # of nodes
kubectl get pods -l app=node-agent -o wide   # 1 Pod per node
```

On Colima you'll see one Pod, scheduled to node `colima`.

---

## 4. Verify per-node identity + hostPath mount

```bash
curl -s http://localhost:30084/ | python3 -m json.tool
```

Expected:

```json
{
  "message": "Hello from DaemonSet Pod (one per node)",
  "podHostname": "node-agent-xxxxx",
  "nodeName": "colima",
  "sampleHostLog": "(could not read /host-logs/messages: ENOENT)",
  "time": "..."
}
```

- `nodeName` came from `spec.nodeName` via the **downward API** — proves each DaemonSet Pod knows which node it's on.
- `sampleHostLog` shows the file-not-found because **Ubuntu (Colima's base) doesn't ship `/var/log/messages`** — that's a RHEL/Alpine convention. The mount itself works; prove it directly:

```bash
kubectl exec ds/node-agent -- ls /host-logs           # contents of /var/log on the VM
kubectl exec ds/node-agent -- cat /host-logs/dpkg.log | tail -3
```

You're reading files from the node's filesystem from inside the Pod — that's the whole point of `hostPath`.

---

## 5. The frontend page

<http://localhost:30085> — leave the agent URL as `http://localhost:30084`, click **Call 20x**. On a multi-node cluster you'd see `nodeName` rotate (the Service load-balances across DaemonSet Pods). On Colima all 20 calls hit the same Pod.

---

## 6. hostPort is **not** exposed on Colima

The DaemonSet also declares `hostPort: 33000`. On a real multi-node cluster you could `curl <nodeIP>:33000` to hit that node's agent directly. On Colima:

```bash
curl --max-time 3 http://localhost:33000/    # connection refused
```

Colima exposes ports in the standard NodePort range (30000–32767) on `localhost`. `hostPort: 33000` is outside that range and isn't forwarded. Use the Service NodePort (30084) instead.

---

## 7. (Optional) See rolling updates

DaemonSet defaults to `RollingUpdate, maxUnavailable: 1`. Force a rollout:

```bash
kubectl rollout restart daemonset/node-agent
kubectl rollout status daemonset/node-agent
```

With one node you'll see the Pod get replaced. With many nodes, one at a time.

---

## 8. Cleanup

```bash
cd K8S-demo-concept-wise-project/daemonsets
kubectl delete -f backend/node-agent-daemonset.yaml \
                -f backend/node-agent-service.yaml \
                -f frontend/frontend.yaml
```

---

## Notes specific to this setup

- **Colima = single node.** The DaemonSet still functions correctly; it just lands on one node. To genuinely demo per-node behavior, run `colima delete && colima start --nodes 3 --kubernetes` (heavy — recreates the VM).
- **hostPath `/var/log` exposes the VM's logs, not your macOS logs.** Colima's VM is an Ubuntu (or close) guest. `/var/log/messages` doesn't exist; `dpkg.log`, `cloud-init.log`, `journal/` do.
- **hostPort 33000 is unreachable from macOS.** Outside Colima's NodePort window.
- **Image tags collide with other folders** (`k8s-demo-frontend:1.0`). Rebuild this folder's frontend before running the demo.
