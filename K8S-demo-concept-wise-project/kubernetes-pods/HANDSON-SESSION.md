# Pods — Hands-on Session Log

A recorded walkthrough of an actual hands-on session on the pods project. Every command that was run, every piece of output that came back, and the observations along the way. Includes a modified multi-container Pod that swaps the sidecar from a log-tailer into an HTTP static file server.

Cluster context: Colima + k3s, one node named `colima` (IP `192.168.5.1`), no other workloads at the start.

---

## Step 1 — Land in the project folder

```bash
cd /Users/apple/repos/k8s-demo-app/K8S-demo-concept-wise-project/kubernetes-pods
```

Every command below is run from here. The `backend/` and `frontend/` subfolders hold the Pod YAMLs and Dockerfiles.

## Step 2 — Deploy the backend Pod

```bash
kubectl apply -f backend/backend-pod.yaml
```

```
pod/backend-pod created
```

Immediately check its status:

```bash
kubectl get pods
```

```
NAME          READY   STATUS    RESTARTS   AGE
backend-pod   1/1     Running   0          13s
```

**What just happened**:
- `kubectl apply` sent the manifest to the API server.
- The scheduler picked node `colima` (the only choice).
- Kubelet pulled the image (already present locally as `k8s-demo-backend:1.0` — no external download) and started the container.
- The backend was Ready in ~13 seconds.

## Step 3 — Deploy the frontend Pod

```bash
kubectl apply -f frontend/frontend-pod.yaml
kubectl get pods
```

```
pod/frontend-pod created

NAME           READY   STATUS    RESTARTS   AGE
backend-pod    1/1     Running   0          35s
frontend-pod   1/1     Running   0          7s
```

Two independent Pods now running. Each has its own IP.

## Step 4 — A common typo, and the correct command

```bash
kubectl port-forword pod/backend-pod 3000:3000
```

```
error: unknown command "port-forword" for "kubectl"

Did you mean this?
        port-forward
```

kubectl's suggestion catches the typo. Correct spelling:

```bash
kubectl port-forward pod/backend-pod 3000:3000
```

```
Forwarding from 127.0.0.1:3000 -> 3000
Forwarding from [::1]:3000 -> 3000
Handling connection for 3000
Handling connection for 3000
^C
```

The `Handling connection for 3000` lines appear each time something on the laptop hits `localhost:3000`.
`Ctrl-C` closes the port-forward.

## Step 5 — Run port-forwards in the background (`nohup`)

Foreground port-forwards tie up the terminal. Background them:

```bash
nohup kubectl port-forward pod/backend-pod 3000:3000 > port-forward.log 2>&1 &
```

```
[1] 29835
```

```bash
nohup kubectl port-forward pod/frontend-pod 8080:80 > port-forward.log 2>&1 &
```

```
[2] 29965
```

**What each piece does:**
- `nohup` — run in a way that survives terminal close.
- `> port-forward.log 2>&1` — redirect both stdout and stderr to a log file so they don't spam the terminal.
- `&` — background the process.
- `[1] 29835` — job number 1, PID 29835. Same for the second.

**Gotcha**: both processes wrote to the *same* file (`port-forward.log`). The second overwrote the first. For real work, use distinct files (`port-forward-backend.log`, `port-forward-frontend.log`).

## Step 6 — Stop and re-start the port-forwards

Stop them by pattern:

```bash
pkill -f "kubectl port-forward pod/backend-pod 3000:3000"
```

```
[1]  - terminated  nohup kubectl port-forward pod/backend-pod 3000:3000 > port-forward.log 2>&1
```

```bash
pkill -f "kubectl port-forward pod/frontend-pod 8080:80"
```

```
[2]  + terminated  nohup kubectl port-forward pod/frontend-pod 8080:80 > port-forward.log 2>&1
```

Then start them again:

```bash
nohup kubectl port-forward pod/backend-pod 3000:3000 > port-forward.log 2>&1 &
nohup kubectl port-forward pod/frontend-pod 8080:80 > port-forward.log 2>&1 &
```

```
[1] 30341
[2] 30356
```

## Step 7 — See what's inside the Pods (`describe`)

```bash
kubectl get pods
```

```
NAME           READY   STATUS    RESTARTS   AGE
backend-pod    1/1     Running   0          8m16s
frontend-pod   1/1     Running   0          7m48s
```

Both still running. `describe` shows the details:

```bash
kubectl describe pods
```

Trimmed output (only the interesting parts):

```
Name:             backend-pod
Namespace:        default
Node:             colima/192.168.5.1
Labels:           app=backend
Status:           Running
IP:               10.42.0.89
Containers:
  backend:
    Image:          k8s-demo-backend:1.0
    Port:           3000/TCP
    State:          Running
    Ready:          True
    Environment:
      POD_IP:   (v1:status.podIP)
    Mounts:
      /var/run/secrets/kubernetes.io/serviceaccount from kube-api-access-qjpdh (ro)
Conditions:
  PodReadyToStartContainers   True
  Initialized                 True
  Ready                       True
  ContainersReady             True
  PodScheduled                True
QoS Class:                   BestEffort
Events:
  Type    Reason     Age    Message
  Normal  Scheduled  8m33s  Successfully assigned default/backend-pod to colima
  Normal  Pulled     8m33s  Container image "k8s-demo-backend:1.0" already present on machine
  Normal  Created    8m33s  Created container: backend
  Normal  Started    8m33s  Started container backend


Name:             frontend-pod
Namespace:        default
Node:             colima/192.168.5.1
Labels:           app=frontend
Status:           Running
IP:               10.42.0.90
Containers:
  frontend:
    Image:          k8s-demo-frontend:1.0
    Port:           80/TCP
    State:          Running
    Ready:          True
    Mounts:
      /var/run/secrets/kubernetes.io/serviceaccount from kube-api-access-gjbk5 (ro)
Events:
  Normal  Scheduled  8m5s  Successfully assigned default/frontend-pod to colima
  Normal  Pulled     8m5s  Container image "k8s-demo-frontend:1.0" already present on machine
```

**Things worth noting in the output:**
- `Node: colima/192.168.5.1` — both Pods on the only worker node.
- `IP: 10.42.0.89` (backend), `10.42.0.90` (frontend) — each Pod gets its own IP from the k3s Pod CIDR.
- `QoS Class: BestEffort` — no CPU/memory `requests` or `limits` are set in these Pod manifests. First to be evicted under memory pressure. Fine for a demo; not fine for prod.
- `POD_IP` env var on the backend — populated from the downward API (`status.podIP`).
- **`kube-api-access-*` volume** — the SA's projected token (see [INTERNALS.md](INTERNALS.md#serviceaccount-token--the-mechanics)). Every Pod gets one, whether it needs it or not.
- **Events** shows the full lifecycle: `Scheduled → Pulled → Created → Started`. This is the sequence to memorize for debugging.

## Step 8 — Follow the app's logs

```bash
kubectl logs -f backend-pod
```

```
backend listening on 3000
^C
```

`-f` follows (like `tail -f`). Only one line so far — the startup log. `Ctrl-C` to exit.

## Step 9 — Peek at the source files

```bash
ls backend
```

```
backend-pod.yaml                Dockerfile                      multi-container-pod.yaml
package.json                    server.js
```

Two Pod YAMLs (single-container `backend-pod.yaml`, multi-container `multi-container-pod.yaml`), the Node.js source, and the Dockerfile.

## Step 10 — Delete a naked Pod (and see it stay dead)

Kill the backend port-forward first, since we're about to delete the Pod behind it:

```bash
pkill -f "kubectl port-forward pod/backend-pod 3000:3000"
```

```
[1]  - terminated  nohup kubectl port-forward pod/backend-pod 3000:3000 > port-forward.log 2>&1
```

Now delete the Pod:

```bash
kubectl delete pod backend-pod
```

```
pod "backend-pod" deleted from default namespace
```

Immediately check:

```bash
kubectl get pods
```

```
NAME           READY   STATUS        RESTARTS   AGE
backend-pod    1/1     Terminating   0          13m
frontend-pod   1/1     Running       0          13m
```

`Terminating` — kubelet is running the graceful shutdown (SIGTERM to the container, wait for `terminationGracePeriodSeconds`, then SIGKILL if still alive).

A few seconds later:

```bash
kubectl get pods
```

```
NAME           READY   STATUS    RESTARTS   AGE
frontend-pod   1/1     Running   0          14m
```

**And it's gone.** No replacement Pod. Because a naked Pod isn't managed by a controller (Deployment, ReplicaSet, StatefulSet). Nothing is watching to say "there should be a backend Pod; the current count is 0; create one." This is the fundamental lesson of raw Pods — they're for demos and debugging, never for production.

## Step 11 — The multi-container Pod (with an HTTP-serving sidecar)

The multi-container manifest was modified so the sidecar does something interesting instead of just tailing:

```yaml
# backend/multi-container-pod.yaml
apiVersion: v1
kind: Pod
metadata:
  name: backend-with-sidecar
  labels:
    app: backend
    variant: multi-container
spec:
  volumes:
    - name: logs
      emptyDir: {}

  containers:
    - name: backend
      image: k8s-demo-backend:1.0
      ports:
        - containerPort: 3000
      volumeMounts:
        - name: logs
          mountPath: /var/log/app

    - name: log-sidecar
      image: busybox:1.36
      command:
        - sh
        - -c
        - |
          mkdir -p /www
          echo "Hello from Sidecar" > /www/index.html
          httpd -f -p 8090 -h /www
      ports:
        - containerPort: 8090
      volumeMounts:
        - name: logs
          mountPath: /var/log/app
```

**What changed vs the original**:
- Sidecar used to be `while true; do echo ...; sleep 10; done` — just noise in the logs.
- Now the sidecar runs busybox's `httpd` on port 8090 serving a static "Hello from Sidecar" page.
- The Pod still has `containerPort: 3000` for backend AND `containerPort: 8090` for the sidecar's HTTP server.
- Both containers share the `logs` emptyDir volume (kept for demo purposes — the backend could write to it, the sidecar could read it).

**Why this is interesting**: it demonstrates that a Pod can expose **multiple ports** at once. Backend on `:3000`, sidecar on `:8090`. Two containers, one Pod, two independent HTTP servers reachable at the same Pod IP.

Apply it:

```bash
kubectl apply -f backend/multi-container-pod.yaml
```

```
pod/backend-with-sidecar created
```

```bash
kubectl get pods
```

```
NAME                   READY   STATUS    RESTARTS   AGE
backend-with-sidecar   2/2     Running   0          8s
frontend-pod           1/1     Running   0          15m
```

**`READY 2/2`** — that's the key. Two containers in this Pod, both Ready.

## Step 12 — Inspect the multi-container Pod

```bash
kubectl describe pod backend-with-sidecar
```

Trimmed output:

```
Name:             backend-with-sidecar
Node:             colima/192.168.5.1
Labels:           app=backend
                  variant=multi-container
IP:               10.42.0.92                # ← one IP for the whole Pod
Containers:
  backend:
    Image:          k8s-demo-backend:1.0
    Port:           3000/TCP
    State:          Running
    Mounts:
      /var/log/app from logs (rw)           # ← shared emptyDir mounted here
  log-sidecar:
    Image:         busybox:1.36
    Port:          8090/TCP
    Command:
      sh
      -c
      mkdir -p /www
      echo "Hello from Sidecar" > /www/index.html
      httpd -f -p 8090 -h /www
    State:          Running
    Mounts:
      /var/log/app from logs (rw)           # ← same emptyDir, same mount path
Volumes:
  logs:
    Type:       EmptyDir (a temporary directory that shares a pod's lifetime)
Events:
  Normal  Scheduled  7s   Successfully assigned default/backend-with-sidecar to colima
  Normal  Pulled     6s   Container image "k8s-demo-backend:1.0" already present on machine
  Normal  Created    6s   Created container: backend
  Normal  Started    6s   Started container backend
  Normal  Pulled     6s   Container image "busybox:1.36" already present on machine
  Normal  Created    6s   Created container: log-sidecar
  Normal  Started    6s   Started container log-sidecar
```

**Observations:**
- One IP (`10.42.0.92`) shared by both containers.
- Two `Started container ...` events — one per container.
- Both containers have `/var/log/app from logs (rw)` — the same `emptyDir` volume, mounted at the same path in each container. They can read/write each other's files.
- Two ports open on the same Pod IP: `backend` on 3000, `log-sidecar` on 8090.

## Step 13 — List container names via jsonpath

```bash
kubectl get pod backend-with-sidecar -o jsonpath='{.spec.containers[*].name}'
```

```
backend log-sidecar
```

Two containers. `jsonpath` is Kubernetes' built-in field extractor — see [KUBECTL-GUIDE.md § output formats](../KUBECTL-GUIDE.md#formats).

## Step 14 — Port-forward multi-container: a port conflict

Try to forward both container ports simultaneously:

```bash
kubectl port-forward pod/backend-with-sidecar 3000:3000 8080:8080
```

```
Forwarding from 127.0.0.1:3000 -> 3000
Forwarding from [::1]:3000 -> 3000
Unable to listen on port 8080: Listeners failed to create with the following errors:
  [unable to create listener: Error listen tcp4 127.0.0.1:8080: bind: address already in use
   unable to create listener: Error listen tcp6 [::1]:8080: bind: address already in use]
^C
```

**What went wrong**: `8080` is a mismatch — the sidecar listens on `8090`, not `8080`. Meanwhile local port `8080` was already taken by the still-running `frontend-pod` port-forward (from step 6). So both problems: wrong pod port AND wrong local port.

The fix — match ports correctly:

```bash
kubectl port-forward pod/backend-with-sidecar 3000:3000 8090:8090
```

```
Forwarding from 127.0.0.1:3000 -> 3000
Forwarding from [::1]:3000 -> 3000
Forwarding from 127.0.0.1:8090 -> 8090
Forwarding from [::1]:8090 -> 8090
Handling connection for 3000
Handling connection for 3000
Handling connection for 8090
Handling connection for 8090
Handling connection for 3000
```

Two port-forwards on one Pod, one command. Traffic on `localhost:3000` → the Pod's backend (Node.js). Traffic on `localhost:8090` → the Pod's sidecar (busybox httpd serving "Hello from Sidecar"). `Ctrl-C` closes both.

**The lesson**: `kubectl port-forward` accepts multiple `local:remote` pairs on one command. Cleaner than running two separate port-forwards.

## Recap — what this session demonstrated

| # | Concept | Command |
|---|---|---|
| 1 | Apply a Pod manifest | `kubectl apply -f <file>` |
| 2 | List Pods | `kubectl get pods` |
| 3 | Watch state changes | Repeat `get`; add `-w` to stream |
| 4 | Port-forward from laptop → Pod | `kubectl port-forward pod/X 3000:3000` |
| 5 | Background a port-forward | `nohup kubectl port-forward ... > log 2>&1 &` |
| 6 | Kill a background port-forward | `pkill -f "kubectl port-forward pod/X"` |
| 7 | Describe a Pod (events, state, config) | `kubectl describe pod X` |
| 8 | Follow app logs | `kubectl logs -f X` |
| 9 | Delete a Pod | `kubectl delete pod X` |
| 10 | **Naked Pods don't self-heal** — deleted Pod stays deleted | (observed via `get pods`) |
| 11 | Multi-container Pod = one IP, multiple containers, shared volume | `kubectl apply -f multi-container-pod.yaml` |
| 12 | Extract specific fields | `kubectl get pod X -o jsonpath='{.spec.containers[*].name}'` |
| 13 | Port-forward multiple ports in one command | `kubectl port-forward pod/X 3000:3000 8090:8090` |
| 14 | Port conflicts caught early | "address already in use" from another port-forward |

## Gotchas caught this session

- **Typo suggestion**: `port-forword` → kubectl suggests `port-forward`. Trust kubectl's Did-you-mean prompts.
- **Same log file for two nohup port-forwards**: the second overwrote the first. Use distinct log filenames.
- **QoS BestEffort by default**: these Pods don't set `resources.requests/limits`. Under memory pressure they're evicted first. Set at least memory requests for anything you care about.
- **Naked Pod deletion is permanent**: no replacement. This is why production uses Deployment / StatefulSet / DaemonSet, never bare Pods.
- **Port already in use** on port-forward means either: (a) another local process holds it, or (b) another kubectl port-forward is still running. `lsof -i :8080` shows the owner.

## Related docs

- [README.md](README.md) — the concept
- [INTERNALS.md](INTERNALS.md) — how Pods work under the hood (pause container, namespace sharing, log flow)
- [RUN-STEPS.md](RUN-STEPS.md) — the canonical command list for this project
- [KUBECTL-GUIDE.md](../KUBECTL-GUIDE.md) — full kubectl reference

## Cleanup after the session

```bash
# stop any port-forwards
pkill -f "kubectl port-forward"

# delete the demo pods
kubectl delete pod frontend-pod backend-with-sidecar --ignore-not-found

# verify
kubectl get pods
# No resources found in default namespace.
```
