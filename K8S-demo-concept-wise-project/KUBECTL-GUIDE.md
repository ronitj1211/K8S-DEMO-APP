# kubectl — The Command Guide with Real Output

A hands-on walkthrough of the kubectl commands you'll actually use, with realistic output examples for each. Grouped by task so you can find things fast.

**How to read this doc:** each section shows the command, what it does in one line, and an example output block so you know what to expect on your terminal.

---

## Table of contents

- [1. Cluster access & context](#1-cluster-access--context)
- [2. Namespaces](#2-namespaces)
- [3. Getting resources](#3-getting-resources)
- [4. Describing / inspecting](#4-describing--inspecting)
- [5. Creating & applying](#5-creating--applying)
- [6. Editing / patching](#6-editing--patching)
- [7. Deleting](#7-deleting)
- [8. Pods — logs, exec, port-forward, cp](#8-pods--logs-exec-port-forward-cp)
- [9. Rollouts](#9-rollouts)
- [10. Scaling](#10-scaling)
- [11. Debugging](#11-debugging)
- [12. RBAC — auth can-i](#12-rbac--auth-can-i)
- [13. Output formats & filters](#13-output-formats--filters)
- [14. Labels & selectors](#14-labels--selectors)
- [15. Watch mode & filters](#15-watch-mode--filters)
- [16. Config / kubeconfig](#16-config--kubeconfig)
- [17. Diff & dry-run](#17-diff--dry-run)
- [18. Useful patterns / one-liners](#18-useful-patterns--one-liners)
- [19. Common flags reference](#19-common-flags-reference)
- [20. Aliases & plugins worth installing](#20-aliases--plugins-worth-installing)

---

## 1. Cluster access & context

### Check what cluster you're pointed at

```bash
kubectl cluster-info
```

**Does:** confirms you can talk to the API server and prints its URL.

```
Kubernetes control plane is running at https://127.0.0.1:56922
CoreDNS is running at https://127.0.0.1:56922/api/v1/namespaces/kube-system/services/kube-dns:dns/proxy
Metrics-server is running at https://127.0.0.1:56922/api/v1/namespaces/kube-system/services/https:metrics-server:https/proxy
```

### See which cluster / user / namespace is the current context

```bash
kubectl config current-context
```

**Does:** prints the name of the currently-active context (a triple of cluster + user + namespace).

```
colima
```

### Show cluster nodes

```bash
kubectl get nodes
```

**Does:** lists worker + control-plane nodes.

```
NAME     STATUS   ROLES                  AGE    VERSION
colima   Ready    control-plane,master   214d   v1.33.4+k3s1
```

Add `-o wide` for IPs, OS, container-runtime:

```bash
kubectl get nodes -o wide
```
```
NAME     STATUS   ROLES                  AGE    VERSION       INTERNAL-IP     EXTERNAL-IP   OS-IMAGE                        KERNEL-VERSION   CONTAINER-RUNTIME
colima   Ready    control-plane,master   214d   v1.33.4+k3s1   192.168.5.15   <none>        Ubuntu 24.04.1 LTS              6.8.0-49-generic docker://27.4.0
```

### Cluster version

```bash
kubectl version
```

**Does:** prints the client (your kubectl) and server (the cluster) versions.

```
Client Version: v1.30.5
Kustomize Version: v5.0.4-0.20230601165947-6ce0bf390ce3
Server Version: v1.33.4+k3s1
```

---

## 2. Namespaces

### List all namespaces

```bash
kubectl get namespaces
# short form:
kubectl get ns
```

```
NAME              STATUS   AGE
default           Active   214d
kube-system       Active   214d
kube-public       Active   214d
kube-node-lease   Active   214d
```

### Create a namespace

```bash
kubectl create namespace my-team
```

```
namespace/my-team created
```

### Set the default namespace for the current context

Instead of typing `-n my-team` on every command:

```bash
kubectl config set-context --current --namespace=my-team
```

```
Context "colima" modified.
```

Now `kubectl get pods` looks in `my-team`.

### Cross-namespace get

- `-n <ns>` — one namespace.
- `-A` (or `--all-namespaces`) — everything, everywhere.

```bash
kubectl get pods -A
```
```
NAMESPACE     NAME                                       READY   STATUS    RESTARTS   AGE
kube-system   coredns-64fd4b4794-jrt4f                   1/1     Running   0          1d
kube-system   local-path-provisioner-774c6665dc-j9wvp    1/1     Running   0          1d
kube-system   metrics-server-7bfffcd44-s5jqz             1/1     Running   0          1d
default       backend-6d585cbbdd-6tt8v                   1/1     Running   0          2h
default       backend-6d585cbbdd-ft97n                   1/1     Running   0          2h
default       backend-6d585cbbdd-l9lsh                   1/1     Running   0          2h
default       frontend-795dc84d44-s88x4                  1/1     Running   0          2h
```

---

## 3. Getting resources

The `get` verb is the workhorse. Same shape for every resource type:

```bash
kubectl get <resource> [name] [-n namespace] [-o format] [-l label-selector]
```

### Common resource shortnames

| Full | Short |
|---|---|
| pods | po |
| deployments | deploy |
| replicasets | rs |
| services | svc |
| configmaps | cm |
| secrets | (none — use full) |
| namespaces | ns |
| persistentvolumeclaims | pvc |
| persistentvolumes | pv |
| statefulsets | sts |
| daemonsets | ds |
| ingresses | ing |
| horizontalpodautoscalers | hpa |
| serviceaccounts | sa |

### Get Pods

```bash
kubectl get pods
```
```
NAME                        READY   STATUS    RESTARTS   AGE
backend-6d585cbbdd-6tt8v    1/1     Running   0          2h
backend-6d585cbbdd-ft97n    1/1     Running   0          2h
frontend-795dc84d44-s88x4   1/1     Running   0          2h
```

### With more columns

```bash
kubectl get pods -o wide
```
```
NAME                        READY   STATUS    RESTARTS   AGE   IP           NODE     NOMINATED NODE   READINESS GATES
backend-6d585cbbdd-6tt8v    1/1     Running   0          2h    10.42.0.15   colima   <none>           <none>
backend-6d585cbbdd-ft97n    1/1     Running   0          2h    10.42.0.16   colima   <none>           <none>
frontend-795dc84d44-s88x4   1/1     Running   0          2h    10.42.0.17   colima   <none>           <none>
```

### Get all common types at once

```bash
kubectl get all
```
```
NAME                            READY   STATUS    RESTARTS   AGE
pod/backend-6d585cbbdd-6tt8v    1/1     Running   0          2h
pod/backend-6d585cbbdd-ft97n    1/1     Running   0          2h
pod/frontend-795dc84d44-s88x4   1/1     Running   0          2h

NAME                 TYPE        CLUSTER-IP     EXTERNAL-IP   PORT(S)   AGE
service/kubernetes   ClusterIP   10.43.0.1      <none>        443/TCP   214d
service/backend      ClusterIP   10.43.167.12   <none>        80/TCP    2h
service/frontend     NodePort    10.43.183.180  <none>        80:30080/TCP 2h

NAME                       READY   UP-TO-DATE   AVAILABLE   AGE
deployment.apps/backend    2/2     2            2           2h
deployment.apps/frontend   1/1     1            1           2h

NAME                                  DESIRED   CURRENT   READY   AGE
replicaset.apps/backend-6d585cbbdd    2         2         2       2h
replicaset.apps/frontend-795dc84d44   1         1         1       2h
```

Note: `get all` doesn't include everything (no ConfigMaps, Secrets, PVCs) — those are excluded because there'd be too much noise. Use `kubectl get configmap,secret,pvc` for those.

### Get a specific Pod by name

```bash
kubectl get pod backend-6d585cbbdd-6tt8v
```
```
NAME                       READY   STATUS    RESTARTS   AGE
backend-6d585cbbdd-6tt8v   1/1     Running   0          2h
```

### Get with more detail

```bash
kubectl get pod backend-6d585cbbdd-6tt8v -o yaml | head
```
```yaml
apiVersion: v1
kind: Pod
metadata:
  annotations:
    ...
  creationTimestamp: "2026-07-23T14:15:22Z"
  generateName: backend-6d585cbbdd-
  labels:
    app: backend
    pod-template-hash: 6d585cbbdd
```

`-o yaml` prints the full object. Also works: `-o json`.

---

## 4. Describing / inspecting

`describe` is what you reach for when `get` isn't enough. It shows events, conditions, container state, resource limits — everything Kubernetes knows about a resource.

```bash
kubectl describe pod backend-6d585cbbdd-6tt8v
```

Truncated output:

```
Name:             backend-6d585cbbdd-6tt8v
Namespace:        default
Priority:         0
Service Account:  default
Node:             colima/192.168.5.15
Start Time:       Wed, 23 Jul 2026 14:15:22 +0530
Labels:           app=backend
                  pod-template-hash=6d585cbbdd
Status:           Running
IP:               10.42.0.15
IPs:
  IP:           10.42.0.15
Containers:
  backend:
    Container ID:   docker://abc123...
    Image:          k8s-demo-backend:1.0
    Image ID:       docker://sha256:...
    Port:           3000/TCP
    State:          Running
      Started:      Wed, 23 Jul 2026 14:15:24 +0530
    Ready:          True
    Restart Count:  0
    Requests:
      cpu:      100m
      memory:   128Mi
    Limits:
      memory:   256Mi
    Environment:  <none>
Conditions:
  Type              Status
  Initialized       True
  Ready             True
  ContainersReady   True
  PodScheduled      True
Events:
  Type    Reason     Age   From               Message
  ----    ------     ----  ----               -------
  Normal  Scheduled  2h    default-scheduler  Successfully assigned default/backend-6d585cbbdd-6tt8v to colima
  Normal  Pulled     2h    kubelet            Container image "k8s-demo-backend:1.0" already present on machine
  Normal  Created    2h    kubelet            Created container backend
  Normal  Started    2h    kubelet            Started container backend
```

**Read the Events section first when debugging.** It's where scheduling failures, image pull errors, and probe failures show up.

### Describe a Node

```bash
kubectl describe node colima
```
Shows: capacity, allocated, taints, conditions, Pod list, events. Useful for "why can't this Pod schedule?"

### Describe a Deployment

```bash
kubectl describe deployment backend
```

Shows replica counts, strategy, template, conditions, events, associated ReplicaSets.

### Explain — what fields does this resource type have?

```bash
kubectl explain deployment.spec.strategy
```
```
KIND:     Deployment
VERSION:  apps/v1

RESOURCE: strategy <Object>

DESCRIPTION:
     The deployment strategy to use to replace existing pods with new ones.

FIELDS:
   rollingUpdate	<Object>
     Rolling update config params. Present only if DeploymentStrategyType =
     RollingUpdate.

   type	<string>
     Type of deployment. Can be "Recreate" or "RollingUpdate". Default is
     RollingUpdate.
```

Add `--recursive` for the whole subtree.

---

## 5. Creating & applying

### apply (declarative — recommended)

```bash
kubectl apply -f deployment.yaml
```
```
deployment.apps/backend created
```

Or with existing resource, it updates:

```
deployment.apps/backend configured
```

Or unchanged:

```
deployment.apps/backend unchanged
```

Apply from a directory (all `*.yaml` files inside):

```bash
kubectl apply -f manifests/
```

Apply from URL:

```bash
kubectl apply -f https://raw.githubusercontent.com/.../deployment.yaml
```

### create (imperative — quick one-offs)

```bash
kubectl create namespace demo
kubectl create deployment nginx --image=nginx:latest
kubectl create secret generic api-key --from-literal=API_KEY=abc123
kubectl create configmap app-config --from-file=./config.yaml
```

Difference from `apply`: `create` errors if the resource exists. `apply` upserts.

### run (throwaway Pod for testing)

```bash
kubectl run debug --rm -it --image=busybox --command -- sh
```

Flags:
- `--rm` — delete the Pod when the command exits.
- `-it` — interactive terminal.
- `--command --` — everything after is the command to run inside.

```
If you don't see a command prompt, try pressing enter.
/ # nslookup backend
Server:    10.43.0.10
Address:   10.43.0.10:53

Name:   backend.default.svc.cluster.local
Address: 10.43.167.12

/ # exit
pod "debug" deleted
```

Great for network debugging, DNS tests, quick curl checks from inside the cluster.

---

## 6. Editing / patching

### edit — open the live resource in your $EDITOR

```bash
kubectl edit deployment backend
```

Opens a YAML editor. Save & close → kubectl applies the change. Ctrl-C to abandon.

```
deployment.apps/backend edited
```

### patch — non-interactive edit

```bash
kubectl patch deployment backend -p '{"spec":{"replicas":5}}'
```
```
deployment.apps/backend patched
```

Patch types:
- Strategic merge (default) — K8s-aware; understands lists like `containers`.
- JSON merge — `--type=merge`.
- JSON patch — `--type=json` — for op-based edits.

Example JSON patch:

```bash
kubectl patch deployment backend --type=json \
  -p='[{"op":"replace","path":"/spec/replicas","value":3}]'
```

### label / annotate

```bash
kubectl label pod backend-6d585cbbdd-6tt8v env=prod
kubectl label pod backend-6d585cbbdd-6tt8v env-        # removes the label
kubectl annotate deployment backend team="platform"
```

---

## 7. Deleting

### Delete by resource + name

```bash
kubectl delete pod backend-6d585cbbdd-6tt8v
```
```
pod "backend-6d585cbbdd-6tt8v" deleted
```

If the Pod is managed by a Deployment, a replacement Pod comes up immediately.

### Delete by YAML

```bash
kubectl delete -f deployment.yaml
```
```
deployment.apps/backend deleted
service/backend deleted
```

### Delete by label

```bash
kubectl delete pod -l app=backend
```
Deletes all Pods matching the selector.

### Force delete a stuck Pod

```bash
kubectl delete pod stuck-pod --grace-period=0 --force
```
```
warning: Immediate deletion does not wait for confirmation that the running resource has been terminated. The resource may continue to run on the cluster indefinitely.
pod "stuck-pod" force deleted
```

Use only when a Pod is stuck `Terminating` because kubelet is unreachable. Data loss risk for stateful workloads.

### Delete a whole namespace (careful!)

```bash
kubectl delete namespace team-alpha
```

Deletes everything inside. Takes time — resources have finalizers that need to clear.

---

## 8. Pods — logs, exec, port-forward, cp

### Logs

```bash
kubectl logs backend-6d585cbbdd-6tt8v
```
```
backend listening on 3000
[2026-07-23T14:15:24Z] request GET /health -> 200
[2026-07-23T14:15:30Z] request GET / -> 200
```

Follow (like `tail -f`):
```bash
kubectl logs -f backend-6d585cbbdd-6tt8v
```

Previous container's logs (after a crash):
```bash
kubectl logs backend-6d585cbbdd-6tt8v --previous
```

Multi-container Pod — pick a container:
```bash
kubectl logs pod-name -c container-name
```

Logs from all Pods matching a label:
```bash
kubectl logs -l app=backend --tail=50
```

Last N lines:
```bash
kubectl logs backend-6d585cbbdd-6tt8v --tail=100
```

Since a time:
```bash
kubectl logs backend-6d585cbbdd-6tt8v --since=10m
kubectl logs backend-6d585cbbdd-6tt8v --since-time=2026-07-23T14:00:00Z
```

### Exec — run commands inside a container

```bash
kubectl exec backend-6d585cbbdd-6tt8v -- ls /
```
```
bin  dev  etc  home  lib  media  mnt  opt  proc  root  run  sbin  srv  sys  tmp  usr  var
```

Interactive shell:

```bash
kubectl exec -it backend-6d585cbbdd-6tt8v -- sh
```
```
/app # ps aux
PID   USER     TIME  COMMAND
    1 root      0:00 node server.js
   15 root      0:00 sh
   21 root      0:00 ps aux
/app # exit
```

Specific container in a multi-container Pod:
```bash
kubectl exec -it pod-name -c container-name -- bash
```

### port-forward — reach a Pod / Service from your laptop

```bash
kubectl port-forward pod/backend-6d585cbbdd-6tt8v 3000:3000
```
```
Forwarding from 127.0.0.1:3000 -> 3000
Forwarding from [::1]:3000 -> 3000
```

Now `curl http://localhost:3000/` on your host hits the Pod inside the cluster.

For a Service (more resilient — survives Pod restarts):
```bash
kubectl port-forward svc/backend 3000:80
```

Random local port:
```bash
kubectl port-forward svc/backend :80
Forwarding from 127.0.0.1:54321 -> 80
```

Background it:
```bash
kubectl port-forward svc/backend 3000:80 &
```

Kill with Ctrl-C (or `kill %1` if backgrounded).

### cp — copy files in/out of a container

```bash
kubectl cp backend-6d585cbbdd-6tt8v:/app/config.json ./local-config.json
kubectl cp ./local-file.txt backend-6d585cbbdd-6tt8v:/tmp/local-file.txt
```

Uses `tar` under the hood, so the container image needs `tar` available.

---

## 9. Rollouts

The `rollout` verb manages Deployments, StatefulSets, and DaemonSets.

### Watch a rollout in progress

```bash
kubectl rollout status deployment/backend
```
```
Waiting for deployment "backend" rollout to finish: 1 out of 3 new replicas have been updated...
Waiting for deployment "backend" rollout to finish: 2 out of 3 new replicas have been updated...
deployment "backend" successfully rolled out
```

The command blocks until the rollout is done (or fails). Exit code is 0 on success, non-zero on timeout — useful in CI.

### History

```bash
kubectl rollout history deployment/backend
```
```
deployment.apps/backend
REVISION  CHANGE-CAUSE
1         <none>
2         kubectl set image deployment/backend backend=k8s-demo-backend:2.0
3         kubectl set image deployment/backend backend=k8s-demo-backend:3.0
```

Details of a specific revision:
```bash
kubectl rollout history deployment/backend --revision=2
```

### Undo — roll back

```bash
kubectl rollout undo deployment/backend
```
```
deployment.apps/backend rolled back
```

To a specific revision:
```bash
kubectl rollout undo deployment/backend --to-revision=1
```

### Restart — trigger a rolling restart without changing anything

```bash
kubectl rollout restart deployment/backend
```
```
deployment.apps/backend restarted
```

Under the hood: adds an annotation to the Pod template, which triggers a new ReplicaSet. Common use: pick up new ConfigMap / Secret values without changing the YAML.

### Pause / resume

```bash
kubectl rollout pause deployment/backend
```
Any changes made now (`kubectl set image`, `kubectl edit`) don't take effect until you resume. Useful for making multiple related changes atomically.

```bash
kubectl rollout resume deployment/backend
```

---

## 10. Scaling

### Manual scale

```bash
kubectl scale deployment/backend --replicas=5
```
```
deployment.apps/backend scaled
```

### Scale a StatefulSet

Same syntax:
```bash
kubectl scale statefulset/db --replicas=3
```

### HPA (autoscale)

Create imperatively:
```bash
kubectl autoscale deployment/backend --min=2 --max=10 --cpu-percent=70
```
```
horizontalpodautoscaler.autoscaling/backend autoscaled
```

Check HPAs:
```bash
kubectl get hpa
```
```
NAME      REFERENCE            TARGETS   MINPODS   MAXPODS   REPLICAS   AGE
backend   Deployment/backend   35%/70%   2         10        3          1h
```

`TARGETS` shows `current/target`. If it says `<unknown>/70%`, metrics-server isn't running or hasn't scraped yet.

---

## 11. Debugging

### Node & Pod resource usage (needs metrics-server)

```bash
kubectl top nodes
```
```
NAME     CPU(cores)   CPU%   MEMORY(bytes)   MEMORY%
colima   245m         6%     1234Mi          20%
```

```bash
kubectl top pods
```
```
NAME                        CPU(cores)   MEMORY(bytes)
backend-6d585cbbdd-6tt8v    12m          45Mi
backend-6d585cbbdd-ft97n    15m          47Mi
frontend-795dc84d44-s88x4   3m           12Mi
```

Sort by usage:
```bash
kubectl top pods --sort-by=memory
kubectl top pods --sort-by=cpu
```

### Cluster events

```bash
kubectl get events --sort-by=.lastTimestamp
```
```
LAST SEEN   TYPE      REASON              OBJECT                            MESSAGE
5m          Normal    Scheduled           pod/backend-6d585cbbdd-6tt8v      Successfully assigned default/backend-6d585cbbdd-6tt8v to colima
5m          Normal    Pulled              pod/backend-6d585cbbdd-6tt8v      Container image "k8s-demo-backend:1.0" already present on machine
5m          Normal    Created             pod/backend-6d585cbbdd-6tt8v      Created container backend
2m          Warning   BackOff             pod/frontend-broken-x1y2z3        Back-off restarting failed container
```

`Warning`-level events are where problems announce themselves.

### Watch events live

```bash
kubectl get events -w
```

### Debug a Pod interactively (K8s 1.23+)

```bash
kubectl debug backend-6d585cbbdd-6tt8v -it --image=busybox
```

Attaches an ephemeral debug container to a running Pod — useful when the main container image doesn't have shell / debug tools.

### Node debug

```bash
kubectl debug node/colima -it --image=busybox
```

Starts a Pod on the node with the node's filesystem mounted at `/host`. For root-cause node-level debugging.

---

## 12. RBAC — auth can-i

Check what a user or service account is allowed to do — before you deploy them.

```bash
kubectl auth can-i list pods
```
```
yes
```

```bash
kubectl auth can-i delete deployments -n kube-system
```
```
no
```

As a specific user or SA:
```bash
kubectl auth can-i list secrets -n prod --as=alice
kubectl auth can-i list secrets -n prod --as=system:serviceaccount:prod:my-app
```

List everything a subject can do:
```bash
kubectl auth can-i --list --as=system:serviceaccount:default:default
```

---

## 13. Output formats & filters

### Formats

```bash
kubectl get pod backend-6d585cbbdd-6tt8v -o yaml           # full YAML
kubectl get pod backend-6d585cbbdd-6tt8v -o json           # full JSON
kubectl get pod backend-6d585cbbdd-6tt8v -o wide           # extra columns
kubectl get pod backend-6d585cbbdd-6tt8v -o name           # just "pod/name"
```

### JSONPath — pull specific fields

```bash
kubectl get pod backend-6d585cbbdd-6tt8v -o jsonpath='{.status.podIP}'
```
```
10.42.0.15
```

Multiple values:
```bash
kubectl get pods -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.podIP}{"\n"}{end}'
```
```
backend-6d585cbbdd-6tt8v      10.42.0.15
backend-6d585cbbdd-ft97n      10.42.0.16
frontend-795dc84d44-s88x4     10.42.0.17
```

### Custom columns

```bash
kubectl get pods -o custom-columns='NAME:.metadata.name,IP:.status.podIP,NODE:.spec.nodeName'
```
```
NAME                         IP           NODE
backend-6d585cbbdd-6tt8v     10.42.0.15   colima
backend-6d585cbbdd-ft97n     10.42.0.16   colima
frontend-795dc84d44-s88x4    10.42.0.17   colima
```

---

## 14. Labels & selectors

### Filter get by label

```bash
kubectl get pods -l app=backend
```
```
NAME                       READY   STATUS    RESTARTS   AGE
backend-6d585cbbdd-6tt8v   1/1     Running   0          2h
backend-6d585cbbdd-ft97n   1/1     Running   0          2h
```

Multiple labels (all must match):
```bash
kubectl get pods -l app=backend,tier=web
```

Set-based:
```bash
kubectl get pods -l 'env in (prod, staging)'
kubectl get pods -l 'env!=dev'
kubectl get pods -l '!experimental'
```

### Show labels

```bash
kubectl get pods --show-labels
```
```
NAME                        READY   STATUS    RESTARTS   AGE   LABELS
backend-6d585cbbdd-6tt8v    1/1     Running   0          2h    app=backend,pod-template-hash=6d585cbbdd
```

### Add / remove labels

```bash
kubectl label pod backend-6d585cbbdd-6tt8v env=prod
kubectl label pod backend-6d585cbbdd-6tt8v env=staging --overwrite
kubectl label pod backend-6d585cbbdd-6tt8v env-      # trailing dash to remove
```

---

## 15. Watch mode & filters

### Watch resources change in real time

```bash
kubectl get pods -w
```

Output updates as Pods change state:
```
NAME                         READY   STATUS              RESTARTS   AGE
backend-6d585cbbdd-6tt8v     1/1     Running             0          2h
backend-6d585cbbdd-6tt8v     1/1     Terminating         0          2h
backend-6d585cbbdd-xj912     0/1     Pending             0          0s
backend-6d585cbbdd-xj912     0/1     ContainerCreating   0          0s
backend-6d585cbbdd-xj912     1/1     Running             0          3s
```

Ctrl-C to exit.

### Field selectors (server-side filtering)

```bash
kubectl get pods --field-selector status.phase=Running
kubectl get pods --field-selector spec.nodeName=colima
kubectl get pods --field-selector status.phase!=Succeeded,status.phase!=Failed
```

Only certain fields are indexed by the API server; unindexed fields error out.

---

## 16. Config / kubeconfig

### List all contexts

```bash
kubectl config get-contexts
```
```
CURRENT   NAME              CLUSTER           AUTHINFO      NAMESPACE
*         colima            colima            colima        default
          docker-desktop    docker-desktop    docker-desktop
          prod-eks          prod-eks          prod-eks      prod
```

### Switch contexts

```bash
kubectl config use-context prod-eks
```
```
Switched to context "prod-eks".
```

### View config

```bash
kubectl config view
```
```yaml
apiVersion: v1
clusters:
- cluster:
    server: https://127.0.0.1:56922
  name: colima
contexts:
- context:
    cluster: colima
    user: colima
  name: colima
current-context: colima
kind: Config
users:
- name: colima
  user:
    client-certificate-data: DATA+OMITTED
    client-key-data: DATA+OMITTED
```

Sensitive data (certs, tokens) is redacted by default. Add `--raw` to see it.

### Multiple kubeconfigs

Merge them via env var:
```bash
export KUBECONFIG=~/.kube/config:~/.kube/prod-config
kubectl config get-contexts     # shows contexts from both files
```

---

## 17. Diff & dry-run

### Diff — what would change if I applied this?

```bash
kubectl diff -f deployment.yaml
```
```
diff -u -N /tmp/LIVE/apps.v1.Deployment.default.backend /tmp/MERGED/apps.v1.Deployment.default.backend
--- /tmp/LIVE/apps.v1.Deployment.default.backend	2026-07-23 14:15:22.000000000 +0000
+++ /tmp/MERGED/apps.v1.Deployment.default.backend	2026-07-23 14:20:15.000000000 +0000
@@ -8,7 +8,7 @@
 spec:
-  replicas: 2
+  replicas: 5
   selector:
     matchLabels:
       app: backend
```

Exit code: 0 if identical, 1 if different. Great in CI to warn about drift.

### Dry-run — validate without applying

```bash
kubectl apply -f deployment.yaml --dry-run=server
```
```
deployment.apps/backend configured (server dry run)
```

`--dry-run=client` — parse/validate on your machine.
`--dry-run=server` — send to the API server (runs webhooks, admission), still doesn't persist.

Combine with `-o yaml` to see what the server *would* create:
```bash
kubectl create configmap demo --from-literal=key=value --dry-run=client -o yaml
```
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: demo
data:
  key: value
```

Pipeline pattern: build manifest, apply:
```bash
kubectl create secret generic mysec --from-literal=api=xyz --dry-run=client -o yaml | kubectl apply -f -
```

---

## 18. Useful patterns / one-liners

### Get the image of every Pod

```bash
kubectl get pods -o custom-columns='NAME:.metadata.name,IMAGE:.spec.containers[*].image'
```

### Find Pods not Ready

```bash
kubectl get pods -A --field-selector=status.phase!=Running,status.phase!=Succeeded
```

### Restart a Deployment (rolling restart)

```bash
kubectl rollout restart deployment/backend
```

### Get all resources in a namespace

```bash
kubectl api-resources --namespaced=true --verbs=list -o name | \
  xargs -n 1 kubectl get --show-kind --ignore-not-found -n my-namespace
```

### Delete all Pods with `Completed` status

```bash
kubectl delete pod --field-selector=status.phase=Succeeded
```

### Get the newest Pod matching a label

```bash
kubectl get pod -l app=backend --sort-by=.metadata.creationTimestamp | tail -1
```

### Tail logs from any/all backend Pods

```bash
kubectl logs -f -l app=backend --max-log-requests=6 --all-containers
```

### Get memory limits per Deployment

```bash
kubectl get deployments -o custom-columns='NAME:.metadata.name,MEMLIMIT:.spec.template.spec.containers[*].resources.limits.memory'
```

### Base64-decode a Secret

```bash
kubectl get secret my-secret -o jsonpath='{.data.password}' | base64 -d
echo
```

### Find which Pod owns a PVC

```bash
kubectl describe pvc my-pvc | grep Used
```

### Delete all evicted Pods

```bash
kubectl get pods --all-namespaces --field-selector=status.phase=Failed -o json | \
  kubectl delete -f -
```

### `kubectl top` cluster-wide by Node

```bash
kubectl top nodes --sort-by=cpu
```

---

## 19. Common flags reference

Flags that work on almost every command:

| Flag | Meaning |
|---|---|
| `-n <ns>` | Namespace |
| `-A` / `--all-namespaces` | All namespaces |
| `--context <name>` | Which cluster context to use |
| `--kubeconfig <path>` | Alternate kubeconfig file |
| `-o wide` | More columns |
| `-o yaml` / `-o json` | Full object |
| `-o name` | Just `kind/name` |
| `-o jsonpath='{...}'` | JSONPath expression |
| `-o custom-columns=...` | Table with custom columns |
| `-l 'k=v,k2!=v2'` | Label selector |
| `--field-selector='...'` | Field selector |
| `-w` | Watch mode |
| `--show-labels` | Add a LABELS column to get output |
| `-v=<N>` | Verbosity (2 = normal, 6 = show HTTP requests, 8 = payloads) |
| `--dry-run=client\|server` | Validate without applying |
| `--force` | Force delete / apply |
| `--grace-period=<seconds>` | Override terminationGracePeriodSeconds |

### The `-v` flag for troubleshooting kubectl itself

```bash
kubectl get pods -v=8
```
Prints every HTTP request/response between kubectl and the API server. When something's failing weirdly, this shows you exactly what kubectl is trying.

---

## 20. Aliases & plugins worth installing

### Shell alias — save keystrokes

Add to `~/.zshrc` or `~/.bashrc`:

```bash
alias k=kubectl
alias kgp='kubectl get pods'
alias kgs='kubectl get svc'
alias kaf='kubectl apply -f'
alias kdel='kubectl delete'
alias kdesc='kubectl describe'
alias klog='kubectl logs'
alias kex='kubectl exec -it'
```

Auto-completion:
```bash
source <(kubectl completion zsh)     # or bash
complete -F __start_kubectl k
```

Now `k get po` works, tab completion included.

### krew — the kubectl plugin manager

Install ([official docs](https://krew.sigs.k8s.io/docs/user-guide/setup/install/)) then:

```bash
kubectl krew install ctx      # kubectx: switch contexts fast
kubectl krew install ns       # kubens: switch namespaces fast
kubectl krew install neat     # clean 'kubectl get -o yaml' output
kubectl krew install tree     # visualize resource ownership tree
```

### stern — tail logs across many Pods

```bash
brew install stern
stern -n prod backend                # tail all backend Pods, colored per Pod
stern -n prod --tail=100 --since=5m 'checkout-.*'
```

Better than `kubectl logs -f -l ...` for multi-Pod tailing.

### k9s — full-screen TUI

```bash
brew install k9s
k9s
```

Launches an interactive terminal UI: browse Pods with arrow keys, hit `l` for logs, `s` for shell, `d` for describe. Fastest way to poke around a cluster.

### kubectx / kubens — switch cluster / namespace fast

```bash
brew install kubectx     # includes both
kubectx prod-eks         # switch context
kubens my-team           # switch namespace
```

Same as `kubectl config use-context` / `kubectl config set-context --current --namespace=...` but 10× less typing.

---

## Quick-reference cheat card

```
Cluster
  kubectl cluster-info                           # confirm connection
  kubectl config current-context                 # which cluster
  kubectl get nodes -o wide                      # nodes + IPs

Namespaces
  kubectl get ns                                 # list
  kubectl config set-context --current --namespace=X  # default ns

Getting
  kubectl get <res> [-A|-n ns] [-o wide|yaml|json]
  kubectl get all
  kubectl get pods -l app=backend --show-labels

Inspecting
  kubectl describe pod X                         # events + state
  kubectl explain <res>.<field>                  # field docs

Logs / exec / forward
  kubectl logs -f X                              # tail
  kubectl logs X --previous                      # crashed container
  kubectl exec -it X -- sh
  kubectl port-forward svc/X 8080:80

Rollouts
  kubectl rollout status deployment/X
  kubectl rollout history deployment/X
  kubectl rollout undo deployment/X
  kubectl rollout restart deployment/X

Scaling
  kubectl scale deployment/X --replicas=N
  kubectl autoscale deployment/X --min=2 --max=10 --cpu-percent=70

Debugging
  kubectl top pods --sort-by=memory
  kubectl get events --sort-by=.lastTimestamp
  kubectl auth can-i list secrets --as=SA

Diff / dry-run
  kubectl diff -f file.yaml
  kubectl apply -f file.yaml --dry-run=server

Delete
  kubectl delete pod X
  kubectl delete -f file.yaml
  kubectl delete pod X --grace-period=0 --force    # careful
```

---

## The three commands you'll run 100× a day

Learn these first; everything else builds on them:

1. **`kubectl get`** — what's running?
2. **`kubectl describe`** — why is it in this state?
3. **`kubectl logs`** — what does the app itself say?

If you can drive those three commands fluently, you can debug 80% of cluster issues.
