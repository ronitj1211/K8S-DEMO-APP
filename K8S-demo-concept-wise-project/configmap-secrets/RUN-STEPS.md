# Run Steps — ConfigMap & Secret on Colima (k3s)

Concrete commands to bring up this folder on **Colima + k3s**. See [README.md](README.md) for the concept walk-through.

---

## 0. Pre-check

```bash
kubectl get pods       # expect: No resources found
```

---

## 1. CORS fix on the backend (one-time)

Same browser-CORS gotcha as the previous folders. Add to [backend/server.js](backend/server.js):

```js
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});
```

Without it, the frontend on `localhost:30083` calling `localhost:30082` will fail with `Failed to fetch`.

---

## 2. Build images

```bash
cd K8S-demo-concept-wise-project/configmap-secrets/backend
docker build -t k8s-demo-backend:1.0 .

cd ../frontend
docker build -t k8s-demo-frontend:1.0 .
```

---

## 3. Apply manifests

Order matters: the Deployment references the ConfigMap and Secret, so create them first.

```bash
cd K8S-demo-concept-wise-project/configmap-secrets

kubectl apply -f backend/backend-configmap.yaml
kubectl apply -f backend/backend-secret.yaml
kubectl apply -f backend/backend-deployment.yaml
kubectl apply -f frontend/frontend-deployment.yaml

kubectl rollout status deployment/backend
kubectl rollout status deployment/frontend
```

> If the ConfigMap/Secret are missing when the Pod starts, the Pod sits in `ContainerCreating` until they exist — `kubectl describe pod` will show `CreateContainerConfigError`.

---

## 4. Verify all three injection patterns

```bash
curl -s http://localhost:30082/ | python3 -m json.tool
```

Expected response (truncated):

```json
{
  "message": "hello from k8s-demo-backend",
  "logLevel": "debug",
  "apiKeyPreview": "supe***",
  "mountedConfigFile": "# mounted as /etc/config/app.conf\nfeature_flags=new_ui,beta_search\ncache_ttl=60\n"
}
```

What each piece proves:

| Output field | Source | Pattern |
|---|---|---|
| `message: "hello from k8s-demo-backend"` | `GREETING` + `APP_NAME` env vars | Individual ConfigMap key → env var (`configMapKeyRef`) |
| `logLevel: "debug"` | `LOG_LEVEL` env var | Same — ConfigMap key → env var |
| `apiKeyPreview: "supe***"` | `API_KEY` env var | Secret key → env var (`secretKeyRef`) |
| `mountedConfigFile: "..."` | `/etc/config/app.conf` | ConfigMap value mounted as a **file** |

### Look at what got created

```bash
kubectl get cm backend-config -o jsonpath='{.data}'    # plain text in the ConfigMap
kubectl get secret backend-secret -o jsonpath='{.data.API_KEY}' | base64 -d   # Secrets are base64-encoded, NOT encrypted
kubectl exec deployment/backend -- cat /etc/config/app.conf   # mounted file
```

---

## 5. Open the frontend

<http://localhost:30083> — leave the backend URL as `http://localhost:30082`, click **Call backend**. The same JSON appears in the browser.

---

## 6. Try updating the ConfigMap

```bash
kubectl patch configmap backend-config --type=merge -p '{"data":{"GREETING":"howdy"}}'
```

> Env vars sourced from a ConfigMap are **frozen at Pod start** — the response still says "hello" until the Pod restarts. Mounted-file values, however, refresh automatically (kubelet syncs them within ~60s).
>
> To pick up env-var changes:
> ```bash
> kubectl rollout restart deployment/backend
> ```

---

## 7. Cleanup

```bash
cd K8S-demo-concept-wise-project/configmap-secrets
kubectl delete -f backend/backend-deployment.yaml \
                -f frontend/frontend-deployment.yaml \
                -f backend/backend-configmap.yaml \
                -f backend/backend-secret.yaml
```

---

## Notes specific to this setup

- **Secrets ≠ encrypted.** `kubectl get secret ... -o yaml` shows the value base64-encoded only. To get encryption at rest you have to enable EncryptionConfiguration on the API server, or use an external store (Vault, AWS Secrets Manager, etc.).
- **`stringData` vs `data`.** Authoring secrets in `stringData` (as this folder does) lets you write plain text; K8s encodes it. `data` requires you to base64-encode yourself.
- **Env var refresh requires a Pod restart.** Mounted-file values refresh live — useful for nginx.conf / app.conf style config without rolling Pods.
- **NodePorts here:** backend on 30082, frontend on 30083. Both reachable directly on `localhost` thanks to Colima's port exposure for the 30000–32767 range.
