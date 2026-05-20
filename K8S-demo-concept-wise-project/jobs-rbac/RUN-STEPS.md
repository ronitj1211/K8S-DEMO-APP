# Run Steps — Jobs, CronJobs, Namespaces, RBAC on Colima (k3s)

Concrete commands to walk through this folder on **Colima + k3s**. See [README.md](README.md) for the concepts.

> This folder uses **different image names** (`jobs-rbac-backend:1.0`, `jobs-rbac-ui:1.0`) — it does not share the `k8s-demo-*` tags with the other folders.

---

## 0. Pre-check

```bash
kubectl get ns                  # team-alpha / team-beta should NOT exist yet
```

---

## 1. CORS fix on the backend (one-time)

The frontend Pod calls the backend across NodePorts — different origins. Add to [backend/server.js](backend/server.js):

```js
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});
```

---

## 2. Build images

```bash
cd K8S-demo-concept-wise-project/jobs-rbac/backend
docker build -t jobs-rbac-backend:1.0 .

cd ../frontend
docker build -t jobs-rbac-ui:1.0 .
```

---

## 3. Namespaces, backend, frontend, RBAC

Apply in numeric order — file names are prefixed to make the dependency clear:

```bash
cd K8S-demo-concept-wise-project/jobs-rbac

kubectl apply -f backend/01-namespaces.yaml      # team-alpha + team-beta
kubectl apply -f backend/02-deployment.yaml      # backend Deployment + Service in team-alpha
kubectl apply -f frontend/frontend.yaml          # frontend Deployment + Service in team-alpha
kubectl apply -f backend/20-serviceaccount.yaml  # ServiceAccount: pod-reader
kubectl apply -f backend/21-role.yaml            # Role + RoleBinding

kubectl rollout status deployment/backend  -n team-alpha
kubectl rollout status deployment/frontend -n team-alpha
```

Confirm the API objects:

```bash
kubectl get ns
kubectl get all,sa,role,rolebinding -n team-alpha
```

Smoke-test:

```bash
curl -s http://localhost:30095/ | python3 -m json.tool       # backend
open http://localhost:30096                                  # frontend page
```

---

## 4. Run the Job

```bash
kubectl apply -f backend/10-job.yaml
kubectl wait --for=condition=complete job/hello-job -n team-alpha --timeout=60s
kubectl get job hello-job -n team-alpha          # COMPLETIONS 3/3
kubectl logs -n team-alpha -l job-name=hello-job --tail=20
```

Each of the 3 Pods echoes a "hello" line and exits. With `parallelism: 2`, up to 2 ran concurrently.

---

## 5. Run the CronJob

```bash
kubectl apply -f backend/11-cronjob.yaml         # schedule: every minute
kubectl get cronjob -n team-alpha
```

Don't wait — trigger one immediately:

```bash
kubectl create job heartbeat-manual --from=cronjob/heartbeat -n team-alpha
kubectl wait --for=condition=complete job/heartbeat-manual -n team-alpha --timeout=30s
kubectl logs -n team-alpha -l job-name=heartbeat-manual
# heartbeat at Wed May 20 06:56:54 UTC 2026
```

If you leave the CronJob running, you'll see a new Job each minute:

```bash
kubectl get jobs -n team-alpha -w     # Ctrl-C to stop
```

---

## 6. Prove RBAC: the rbac-test Job

```bash
kubectl apply -f backend/22-rbac-test-job.yaml
kubectl wait --for=condition=complete job/rbac-test -n team-alpha --timeout=60s
kubectl logs -n team-alpha -l job-name=rbac-test
```

Expected output (sections):

1. **SUCCESS** — list pods in `team-alpha` → returns a `PodList`.
2. **403 FORBIDDEN** — list **secrets** in `team-alpha` → `"secrets is forbidden: ... cannot list resource \"secrets\" ..."`.
3. **403 FORBIDDEN** — list pods in `team-beta` → `"pods is forbidden: ... cannot list resource \"pods\" in ... \"team-beta\""`.

The Role allows `get/list/watch` on `pods` in `team-alpha` only — everything else is denied. That's **least privilege** in action.

---

## 7. The `can-i` shortcut

Test the same matrix without running anything:

```bash
kubectl auth can-i list pods    -n team-alpha --as=system:serviceaccount:team-alpha:pod-reader   # yes
kubectl auth can-i list secrets -n team-alpha --as=system:serviceaccount:team-alpha:pod-reader   # no
kubectl auth can-i list pods    -n team-beta  --as=system:serviceaccount:team-alpha:pod-reader   # no
```

Note: the final `no` makes `kubectl` exit with code 1 — that's by design, useful for shell-driven policy checks.

---

## 8. Cleanup

Two ways. Granular:

```bash
cd K8S-demo-concept-wise-project/jobs-rbac
kubectl delete -f backend/22-rbac-test-job.yaml \
                -f backend/11-cronjob.yaml \
                -f backend/10-job.yaml \
                -f frontend/frontend.yaml \
                -f backend/02-deployment.yaml \
                -f backend/21-role.yaml \
                -f backend/20-serviceaccount.yaml
```

Or nuke both namespaces (also wipes everything inside them in one shot):

```bash
kubectl delete namespace team-alpha team-beta
```

---

## Notes specific to this setup

- **`kubectl get pods` without `-n` looks at `default`.** All real action here lives in `team-alpha` — always pass `-n team-alpha` (or use `-A` for all namespaces).
- **`ttlSecondsAfterFinished` on the Job** auto-deletes finished Pods after 10 minutes. Without it, `kubectl get pods` accumulates ghosts.
- **CronJob `concurrencyPolicy: Forbid`** — if a run is still going when the next minute fires, the new run is skipped. Useful for jobs that mustn't double-up.
- **NodePorts here:** backend 30095, frontend 30096 (both in `team-alpha`). Colima exposes them on `localhost`.
- **No image-import step** because k3s on Colima uses the same docker daemon; `docker build` is enough.
