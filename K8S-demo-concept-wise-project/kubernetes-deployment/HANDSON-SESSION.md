# Deployment — Hands-on Session Log

A recorded walkthrough of an actual hands-on session on the kubernetes-deployment project. Every command that was run, every piece of output, and the observations along the way. Also captures a few teaching moments — misfires and course-corrections — that were more instructive than a clean happy path.

Cluster context: Colima + k3s, one node `colima`, only k3s system pods running at the start.

---

## Step 1 — Clean slate: remove old images

The previous session left images from the pods folder around. To start fresh:

```bash
docker rmi k8s-demo-backend:1.0 k8s-demo-frontend:1.0
```

```
Untagged: k8s-demo-backend:1.0
Deleted: sha256:11ec59ea558839c3ffe9d948361cbe3764d3ae7a1a43b7593932f8298790f956
Deleted: sha256:39c3fad7881a73eb0beb5200d397dd2164412a84686d98b742304f8cbeffe8e8
Deleted: sha256:aa28bcdf9b328cc022531bad8956e7bf1f750d635a9441998c94568c93ffdc9c
Deleted: sha256:da8e1a11b61e1403aaa77cbf731dbbdde7e690c41922cc90f3db39e3526edc34
Deleted: sha256:9e4ed107cb23ef7f3c2de9bb2738f52a52fc1228c6eae78ef9cfac08ddef540d
Deleted: sha256:d829bca81c410126ad28006ca568a28e9cba9c72a8a6ec8d714b4a1ac5fc0a77
Untagged: k8s-demo-frontend:1.0
Deleted: sha256:97c018d616bbc45b17e938733b6f7b82dd7ca796cd695038aeeb96ccb469f464
Deleted: sha256:c99109684a359c0d968ce27bcb35c3a51cc923f24ec1cce4eaa524f55cc36d70
```

`docker rmi` removes the tags AND any dangling layers that no other image references. Notice the many `Deleted: sha256:...` lines — those are the individual filesystem layers that made up the backend image. Layers get cleaned up when the last tag referencing them goes away.

## Step 2 — Directory navigation (a common misfire)

Attempted to `cd` into a path that didn't exist relative to the current location:

```bash
cd K8S-demo-concept-wise-project/kubernetes-deployment/backend
docker build -t k8s-demo-backend:1.0 .
```

```
cd: no such file or directory: K8S-demo-concept-wise-project/kubernetes-deployment/backend
DEPRECATED: The legacy builder is deprecated and will be removed in a future release.
            Install the buildx component to build images with BuildKit:
            https://docs.docker.com/go/buildx/

unable to prepare context: unable to evaluate symlinks in Dockerfile path:
  lstat /Users/apple/repos/k8s-demo-app/K8S-demo-concept-wise-project/kubernetes-deployment/Dockerfile:
  no such file or directory
```

**Two problems in one attempt:**
1. `cd` failed (we were already inside `kubernetes-deployment` — the path is redundant).
2. Because `cd` failed but the shell kept executing (semicolons continue on failure), `docker build .` ran from the `kubernetes-deployment` folder itself, which has no Dockerfile — hence the "no such file" error.

**Lesson**: use `&&` between commands so a failed `cd` stops the pipeline:
```bash
cd backend && docker build -t k8s-demo-backend:1.0 .
```

The Docker deprecation warning about the legacy builder is not blocking — just noise until you `docker buildx install`.

## Step 3 — Correct build (backend then frontend)

```bash
cd backend
docker build -t k8s-demo-backend:1.0 .
```

```
Step 1/7 : FROM node:20-alpine
 ---> fb4cd12c85ee
Step 2/7 : WORKDIR /app
Step 3/7 : COPY package.json ./
Step 4/7 : RUN npm install --omit=dev
...
 added 68 packages, and audited 69 packages in 4s
Step 5/7 : COPY server.js ./
Step 6/7 : EXPOSE 3000
Step 7/7 : CMD ["node", "server.js"]
Successfully built e87cb94401a0
Successfully tagged k8s-demo-backend:1.0
```

Then the frontend from a sibling directory:

```bash
cd ../frontend
docker build -t k8s-demo-frontend:1.0 .
```

```
Step 1/3 : FROM nginx:1.27-alpine
 ---> 65645c7bb6a0
Step 2/3 : COPY index.html /usr/share/nginx/html/index.html
Step 3/3 : EXPOSE 80
Successfully built 2fa8c79e92ae
Successfully tagged k8s-demo-frontend:1.0
```

Both images ready.

**Note on `imagePullPolicy: IfNotPresent`** — this is in the Deployment YAMLs. When kubelet needs to start a Pod, it checks the local docker daemon first. Since the image is there (we just built it), no registry pull is attempted. This is what makes local iteration possible without a registry.

## Step 4 — Apply the Deployments (another path gotcha)

From the `frontend` subfolder:

```bash
kubectl apply -f frontend/frontend-deployment.yaml
```

```
error: the path "frontend/frontend-deployment.yaml" does not exist
```

We were **inside** `frontend/` — the file was in the current directory:

```bash
kubectl apply -f frontend-deployment.yaml
```

```
deployment.apps/frontend-deployment created
```

Then the backend (relative path with `..`):

```bash
kubectl apply -f ../backend/backend-deployment.yaml
```

```
deployment.apps/backend-deployment created
```

**Lesson**: `kubectl apply -f <path>` is relative to wherever your shell is. When copy-pasting commands from docs, either match the docs' cwd or convert to absolute paths.

## Step 5 — Watch the rollouts complete

```bash
kubectl rollout status deployment/backend-deployment
```

```
deployment "backend-deployment" successfully rolled out
```

```bash
kubectl rollout status deployment/frontend-deployment
```

```
deployment "frontend-deployment" successfully rolled out
```

```bash
kubectl get deployments
```

```
NAME                  READY   UP-TO-DATE   AVAILABLE   AGE
backend-deployment    3/3     3            3           46s
frontend-deployment   2/2     2            2           64s
```

**Reading the columns:**
- **READY**: `3/3` = 3 replicas Ready out of 3 desired. `AVAILABLE` = same number that passed readiness for at least `minReadySeconds` (0 by default here).
- **UP-TO-DATE**: how many replicas have the latest Pod template. If you're mid-rollout you'll see this differ from READY briefly.
- **AVAILABLE**: how many are actually available (Ready + minReadySeconds elapsed).

On a healthy static Deployment, all three columns tie.

## Step 6 — Port-forward the backend (background)

```bash
nohup kubectl port-forward deployment/backend-deployment 3000:3000 > port-forward.log 2>&1 &
```

```
[1] 96942
```

Job `[1]`, PID `96942`. Backgrounded. `port-forward.log` catches its output.

## Step 7 — A port collision (great teaching moment)

Started a second port-forward for the frontend on port 3000 by mistake — same as the backend:

```bash
nohup kubectl port-forward deployment/frontend-deployment 3000:3000 > port-forward.log 2>&1 &
```

```
[2] 96970
```

The job appeared to start… but immediately died:

```
[2]  + exit 1     nohup kubectl port-forward deployment/frontend-deployment 3000:3000 >  2>&1
```

**What went wrong**: local port `3000` was already held by the backend port-forward. The second `port-forward` couldn't bind and exited with code 1. `nohup` captured the error in `port-forward.log` — worth checking log files for these background-mode failures because the terminal only prints a terse summary.

Also this line:
```bash
pkill -f "kubectl port-forward deployment/frontend-pod 3000:3000"
```
Didn't kill anything either — that pattern says `frontend-pod` but the running command was `frontend-deployment`. `pkill -f` matches literal strings against the full command line; typos = no matches = no kills.

## Step 8 — Correct the frontend port

Front-end should map local `8080` → Pod container port `80`:

```bash
nohup kubectl port-forward deployment/frontend-deployment 8080:80 > port-forward.log 2>&1 &
```

```
[2] 97138
```

Now backend on `:3000` and frontend on `:8080` — no clash.

Verify Pods:

```bash
kubectl get pods
```

```
NAME                                   READY   STATUS    RESTARTS   AGE
backend-deployment-64ff964b5-2rzk6     1/1     Running   0          17m
backend-deployment-64ff964b5-jkx55     1/1     Running   0          17m
backend-deployment-64ff964b5-s9zvg     1/1     Running   0          17m
frontend-deployment-795dc84d44-ct4nd   1/1     Running   0          17m
frontend-deployment-795dc84d44-hcjbg   1/1     Running   0          17m
```

**Reading the Pod names:**
- `backend-deployment-64ff964b5-2rzk6` — the middle part `64ff964b5` is the **pod-template-hash**. All 3 backend Pods share it, meaning they all use the same Pod template version. If we rolled out a new image, we'd see a *different* hash appear as new Pods came up.
- The suffix (`2rzk6`, `jkx55`, `s9zvg`) is random — one per Pod.
- Same story for frontend: 2 Pods sharing template hash `795dc84d44`.

## Step 9 — Update the HTML and rebuild the image

Edited `frontend/index.html`. Then rebuilt the frontend image with the SAME tag:

```bash
cd frontend
docker build -t k8s-demo-frontend:1.0 .
```

```
Step 1/3 : FROM nginx:1.27-alpine
 ---> 65645c7bb6a0
Step 2/3 : COPY index.html /usr/share/nginx/html/index.html
 ---> 0a22bc464906              # ← new layer hash for the new HTML content
Step 3/3 : EXPOSE 80
Successfully built b6c45cea117b
Successfully tagged k8s-demo-frontend:1.0
```

At this point the local docker daemon has a NEW image with the SAME tag `:1.0` — but the running frontend Pods still have the OLD image loaded into their containers. Rebuilding the image doesn't tell K8s to restart anything.

**The critical thing to understand**: K8s doesn't watch your docker daemon. It only reacts to changes in **Kubernetes objects**.

## Step 10 — A failed attempt to trigger a rollout

Killed the frontend port-forward and re-applied the YAML:

```bash
pkill -f "kubectl port-forward deployment/frontend-deployment 8080:80"
kubectl apply -f frontend-deployment.yaml
```

```
deployment.apps/frontend-deployment unchanged
```

**"unchanged"** — this is the key output. `kubectl apply` compared the YAML to what's already in etcd. Nothing differs. So K8s does nothing. The Pods keep running the old image.

**Why**: the YAML says `image: k8s-demo-frontend:1.0`, and the cluster's Deployment also says `image: k8s-demo-frontend:1.0`. Identical. From K8s's POV, there's nothing to do.

**This is a common trap**: you think editing the source and rebuilding the image is enough. It's not. You need to change something the Deployment object cares about.

## Step 11 — The "big hammer" approach (works but not best practice)

To force new Pods:

```bash
kubectl delete deployment frontend-deployment
```

```
deployment.apps "frontend-deployment" deleted from default namespace
```

```bash
kubectl apply -f frontend-deployment.yaml
```

```
deployment.apps/frontend-deployment created
```

New Pods come up. `imagePullPolicy: IfNotPresent` finds the (new) `:1.0` image on the local docker daemon and starts fresh containers with the new HTML.

Restart the port-forward against the new Deployment:

```bash
nohup kubectl port-forward deployment/frontend-deployment 8080:80 > port-forward.log 2>&1 &
```

```
[2] 902
```

Open http://localhost:8080 — the new HTML is showing.

**But…**

## Step 12 — Why this approach isn't the best practice

Delete + recreate works, but:

1. **All frontend Pods die at once** — 2 out of 2 gone. Users see errors during the gap until the new Deployment's Pods come up Ready (~10-30s downtime).
2. **The old ReplicaSet is destroyed** — `kubectl rollout history` no longer shows anything to roll back to. If the new HTML is broken, there's no `rollout undo`.
3. **`revision` counter resets to 1**.

For a demo on your laptop this is fine. In prod it's a red flag.

The better pattern is one of these:

### Best practice A — versioned tag

```bash
# Rebuild with a NEW tag
docker build -t k8s-demo-frontend:1.1 ./frontend

# Update the Deployment to reference the new tag
kubectl set image deployment/frontend-deployment frontend=k8s-demo-frontend:1.1

# Watch rolling update
kubectl rollout status deployment/frontend-deployment
```

- Rolling replace, zero downtime (`maxUnavailable: 0`).
- Rollback history preserved — `kubectl rollout undo` brings back `:1.0`.
- Two immutable image tags — you can inspect either at any time.

### Best practice B — same tag + rollout restart (dev-only)

```bash
docker build -t k8s-demo-frontend:1.0 ./frontend
kubectl rollout restart deployment/frontend-deployment
```

- Rolling replace (still zero downtime).
- `rollout history` records the restart but rollback is a lie (same tag now points to different bytes).
- OK for local iteration when you don't care about rollback fidelity.

### Best practice C — commit-SHA tag (CI/CD pattern)

```bash
TAG=$(git rev-parse --short HEAD)
docker build -t k8s-demo-frontend:$TAG ./frontend
kubectl set image deployment/frontend-deployment frontend=k8s-demo-frontend:$TAG
```

Every deploy tied to a specific commit. Standard in production.

## Recap — commands and their outputs from this session

| # | Command | Key output / behavior |
|---|---|---|
| 1 | `docker rmi <images>` | Removes tags + dangling layers |
| 2 | `cd nonexistent && docker build` | `cd` fails, but shell continues → confusing follow-on error |
| 3 | `docker build -t <tag> .` | Layer-by-layer build; ends with `Successfully tagged` |
| 4 | `kubectl apply -f <path>` | `created` (first time) or `unchanged` (no diff) |
| 5 | `kubectl rollout status deployment/X` | Blocks until rollout done; non-zero exit on timeout |
| 6 | `kubectl get deployments` | READY / UP-TO-DATE / AVAILABLE columns |
| 7 | `nohup kubectl port-forward ... &` | Backgrounded; PID + job number returned |
| 8 | Port collision | Second port-forward `exit 1`; error logged, not printed |
| 9 | `pkill -f` with wrong pattern | Silently kills nothing |
| 10 | Rebuild same tag + `apply` | Deployment reports `unchanged` — no rollout |
| 11 | `kubectl delete deployment` + `apply` | Full recreate; loses history; brief downtime |
| 12 | `kubectl get pods` after deploy | Pod name = `<deployment>-<template-hash>-<random>` |

## Gotchas caught this session

- **`cd` failures don't stop shell pipelines**: use `&&` (`cd X && docker build ...`) to abort on cd failure.
- **`kubectl apply` on identical YAML is a no-op**: `unchanged` output = zero action. You need something in the K8s object to change to trigger a rollout.
- **Rebuilding an image with the same tag doesn't tell K8s anything**: K8s watches its own API, not your docker daemon.
- **Two port-forwards can't share the same local port**: second one exits with `bind: address already in use` — visible in the log file, not the terminal.
- **`pkill -f` matches command-line strings literally**: typos = no matches. Look at `ps -ef | grep kubectl` to see actual running commands.
- **`kubectl delete deployment` + recreate is the "big hammer"**: works but loses revision history and causes brief downtime. Use `kubectl set image` or `kubectl rollout restart` for real rollouts.

## What to try next

**Practice a real rolling update** (Best practice A above):

```bash
# 1. Change index.html again
# 2. Tag as :1.1
docker build -t k8s-demo-frontend:1.1 ./frontend

# 3. Roll to the new tag
kubectl set image deployment/frontend-deployment frontend=k8s-demo-frontend:1.1

# 4. Watch the rolling replace — you'll see mixed template hashes briefly
kubectl get pods -w
# Ctrl-C when both Pods are on the new hash

# 5. Look at rollout history
kubectl rollout history deployment/frontend-deployment
# should now show revisions 1 (with :1.0) and 2 (with :1.1)

# 6. Roll back to :1.0
kubectl rollout undo deployment/frontend-deployment
kubectl rollout status deployment/frontend-deployment

# You'll see the ORIGINAL HTML come back — genuine rollback because :1.0 is still on the docker daemon.
```

**See self-healing**:

```bash
POD=$(kubectl get pod -l app=backend -o jsonpath='{.items[0].metadata.name}')
kubectl delete pod $POD

# Immediately:
kubectl get pods -l app=backend
# You'll see one Pod Terminating and a new one already Running.
# That's the ReplicaSet controller keeping 3 replicas alive.
```

## Related docs

- [README.md](README.md) — the concept
- [RUN-STEPS.md](RUN-STEPS.md) — the canonical command list
- [INTERNALS.md](INTERNALS.md) — controller chain, pod-template-hash, rolling update mechanics
- [KUBECTL-GUIDE.md](../KUBECTL-GUIDE.md) — full kubectl reference
- [../kubernetes-pods/HANDSON-SESSION.md](../kubernetes-pods/HANDSON-SESSION.md) — the previous session (naked Pods)

## Cleanup after the session

```bash
# Stop port-forwards
pkill -f "kubectl port-forward"

# Delete the Deployments (this cascade-deletes their ReplicaSets and Pods)
kubectl delete deployment backend-deployment frontend-deployment

# Verify
kubectl get all
# Only the default `kubernetes` Service should remain in the default namespace.
```
