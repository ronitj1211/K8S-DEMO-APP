# More Production Incidents & Remediation

Companion to [PRODUCTION-INCIDENTS.md](PRODUCTION-INCIDENTS.md). Eight more real-world scenarios with the same shape: symptom → diagnosis path → root cause → fix → prevention. Every step explained in plain language.

Read PRODUCTION-INCIDENTS.md first for the interview-story angle; this file is more of a "here's what breaks and here's how you fix it" catalog.

---

## Table of contents

- [Incident #4: CrashLoopBackOff after a ConfigMap change](#incident-4-crashloopbackoff-after-a-configmap-change)
- [Incident #5: Pods stuck Pending — nothing scheduling](#incident-5-pods-stuck-pending--nothing-scheduling)
- [Incident #6: ImagePullBackOff from a private registry](#incident-6-imagepullbackoff-from-a-private-registry)
- [Incident #7: In-cluster DNS lookups intermittently failing](#incident-7-in-cluster-dns-lookups-intermittently-failing)
- [Incident #8: PVC stuck Pending — StatefulSet won't start](#incident-8-pvc-stuck-pending--statefulset-wont-start)
- [Incident #9: HPA sitting at "unknown / 70%" not scaling](#incident-9-hpa-sitting-at-unknown--70-not-scaling)
- [Incident #10: NetworkPolicy silently breaking legit traffic](#incident-10-networkpolicy-silently-breaking-legit-traffic)
- [Incident #11: Node NotReady, workloads evacuating](#incident-11-node-notready-workloads-evacuating)

---

## Incident #4: CrashLoopBackOff after a ConfigMap change

### Symptom

At 09:22 UTC, alerts fire: `checkout-service` errors spiking. `kubectl get pods` shows:

```
NAME                        READY   STATUS             RESTARTS   AGE
checkout-5f8c9d7b4d-abc12   0/1     CrashLoopBackOff   6          8m
checkout-5f8c9d7b4d-def34   0/1     CrashLoopBackOff   6          8m
checkout-5f8c9d7b4d-ghi56   0/1     CrashLoopBackOff   6          8m
```

All three replicas broken. Deployment hasn't changed (no new image), no code push in the last hour.

### Diagnosis path

**Step 1: What error is the container throwing?**

```bash
kubectl logs checkout-5f8c9d7b4d-abc12
```

**In plain words:** show the container's stdout. Since the container just crashed and restarted, this returns the *current* run's logs.

```
Loading configuration...
Error: environment variable DATABASE_URL is not set
    at loadConfig (/app/src/config.js:14:11)
    at Object.<anonymous> (/app/src/server.js:3:14)
```

App is crashing on startup because `DATABASE_URL` env var is missing.

**Step 2: Where does `DATABASE_URL` come from?**

Check the Deployment YAML:

```bash
kubectl get deployment checkout -o yaml | grep -A 5 env:
```

```yaml
        env:
        - name: DATABASE_URL
          valueFrom:
            configMapKeyRef:
              name: checkout-config
              key: database.url
```

**In plain words:** the env var pulls its value from a key `database.url` in a ConfigMap named `checkout-config`.

**Step 3: Look at the ConfigMap**

```bash
kubectl get configmap checkout-config -o yaml
```

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: checkout-config
data:
  db.url: postgres://prod-db:5432/checkout    # <-- WRONG KEY
  log.level: info
```

**Notice the mismatch:** the Deployment references `database.url` (with a `.`), but the ConfigMap has `db.url`. When Kubernetes tries to set the env var, the key isn't found → the env var is unset → the app crashes on startup.

**Step 4: Verify the theory with describe**

```bash
kubectl describe pod checkout-5f8c9d7b4d-abc12
```

Events section:

```
Warning  Failed  30s  kubelet  Error: couldn't find key database.url in ConfigMap default/checkout-config
```

**Confirmed.** Kubernetes told us exactly the problem, we just weren't looking in the right place first.

### Root cause

Someone renamed the key from `database.url` to `db.url` in the ConfigMap (probably during a config cleanup PR), but didn't update the Deployment's `configMapKeyRef.key`. The Deployment YAML still asks for `database.url`, which doesn't exist anymore.

### Fix

**Immediate (2 minutes):**

Patch the ConfigMap back to the old key name so running Pods can start:

```bash
kubectl patch configmap checkout-config \
  --type=json \
  -p='[{"op":"add","path":"/data/database.url","value":"postgres://prod-db:5432/checkout"}]'
```

**In plain words:** add the old key `database.url` back to the ConfigMap so the Deployment can find it. Pods will now start on the next restart.

Then force Pods to restart quickly instead of waiting for the crash loop:

```bash
kubectl rollout restart deployment/checkout
```

**Long-term:** decide on the canonical key name, update both places, verify.

```bash
# Update ConfigMap to just `database.url`, remove `db.url`
kubectl apply -f configs/checkout-config.yaml     # canonical source

# Verify Deployment matches
kubectl describe deployment checkout | grep -A 3 "database.url"
```

### Prevention

1. **Never edit ConfigMaps without checking who references them.**

```bash
# Find every workload referencing this ConfigMap
kubectl get pods -A -o json | jq -r '
  .items[] |
  select(.spec.containers[].env[]?.valueFrom.configMapKeyRef.name == "checkout-config") |
  "\(.metadata.namespace)/\(.metadata.name)"'
```

**In plain words:** search all Pods that reference this ConfigMap. If you're about to rename a key, you need to update every one of them.

2. **Automate with a checksum annotation** so a ConfigMap edit forces a rolling restart of the Deployment (making the failure loud instead of silent):

```yaml
spec:
  template:
    metadata:
      annotations:
        checksum/config: {{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}
```

(This is Helm syntax. The same idea in plain Kustomize is `configMapGenerator` with `disableNameSuffixHash: false` — a name change on ConfigMap changes forces a new Pod template.)

3. **Add a startup smoke test in CI** that runs the container with the target ConfigMap for 30 seconds. Catches config wiring errors before deploy.

---

## Incident #5: Pods stuck Pending — nothing scheduling

### Symptom

You apply a new Deployment. Pods sit in `Pending` for 5+ minutes:

```
NAME                       READY   STATUS    RESTARTS   AGE
new-service-abc-x1y2z3     0/1     Pending   0          5m
new-service-abc-p4q5r6     0/1     Pending   0          5m
```

No error events immediately visible. What's happening?

### Diagnosis path

**Step 1: Ask Kubernetes why it hasn't scheduled**

```bash
kubectl describe pod new-service-abc-x1y2z3
```

Skip to the bottom — the Events section is where the scheduler tells you why:

```
Warning  FailedScheduling  30s  default-scheduler  0/3 nodes are available:
  1 node(s) had untolerated taint {node-role.kubernetes.io/control-plane: },
  2 Insufficient cpu.
```

**Reading this in plain words:** the scheduler looked at all 3 nodes:
- 1 node was the control-plane, which has a taint saying "don't schedule ordinary Pods here" — and our Pod doesn't have a toleration for it.
- 2 nodes rejected the Pod because they don't have enough CPU available.

**Step 2: How much CPU does the Pod ask for?**

```bash
kubectl get pod new-service-abc-x1y2z3 -o jsonpath='{.spec.containers[*].resources}'
```

```
{"requests":{"cpu":"4","memory":"8Gi"},"limits":{"cpu":"4","memory":"8Gi"}}
```

**Notice:** requests 4 CPUs. On the 2 worker nodes.

**Step 3: How much CPU is available on each node?**

```bash
kubectl top nodes
```

```
NAME     CPU(cores)   CPU%   MEMORY(bytes)   MEMORY%
node-1   1250m        62%    3200Mi          40%
node-2   1100m        55%    2900Mi          36%
node-3   50m          2%     100Mi           1%     (control-plane)
```

Wait — that shows CPU usage, not allocatable. What matters is:

```bash
kubectl describe node node-1 | grep -A 5 "Allocated resources"
```

```
Allocated resources:
  Resource           Requests   Limits
  cpu                1700m      2500m
  memory             4800Mi     6144Mi
  ephemeral-storage  0          0
```

**In plain words:** `node-1` already has 1700m (1.7 CPUs) reserved by other Pods' requests. Node has (say) 2 CPUs total → 300m available. Our Pod wants 4 CPUs → doesn't fit.

Same on node-2. Control plane has room but has a taint.

### Root cause

The new Deployment requests 4 CPUs per Pod, but no worker node has 4 CPUs of allocatable capacity available. The scheduler can't place the Pod anywhere.

### Fix

**Option A — reduce the request:** if 4 CPU was aspirational rather than measured, drop it:

```yaml
resources:
  requests:
    cpu: "1"          # measured p99 usage
    memory: 2Gi
  limits:
    memory: 4Gi
```

**Option B — add more nodes:** if 4 CPU is genuinely needed, add capacity:

- **Cluster Autoscaler / Karpenter enabled?** It should have added a node automatically. Check its logs for why it didn't.
- **Manual node pool?** Bump the node group's `desiredCapacity` in your Terraform / eksctl / cloud console.

**Option C — larger instance type:** if you need one big Pod, add a node with more CPU:

```bash
eksctl create nodegroup --cluster=my-cluster --instance-types=m5.2xlarge --nodes=1
```

### Prevention

1. **Never guess resource requests.** Look at real usage:

```bash
# Get 99th percentile CPU usage over the last day from Prometheus
histogram_quantile(0.99, rate(container_cpu_usage_seconds_total{pod=~"my-app-.*"}[1d]))
```

Right-size requests to about 1.3× measured p99. Not more.

2. **Add HPA + Cluster Autoscaler together.** HPA adds Pods when load rises; if those Pods can't fit on existing nodes, Cluster Autoscaler adds a node. Requires that the Cluster Autoscaler is actually installed and has permission to modify your node groups — it's a checklist item, not a default.

3. **Monitor node capacity.** Alert when average node CPU utilization exceeds 80% — that's your signal to scale before Pods start pending.

---

## Incident #6: ImagePullBackOff from a private registry

### Symptom

Applied a new Deployment; Pods sit in `ImagePullBackOff`:

```
NAME                     READY   STATUS             RESTARTS   AGE
worker-84b6cd7fc-abc12   0/1     ImagePullBackOff   0          3m
```

### Diagnosis path

**Step 1: Read the events**

```bash
kubectl describe pod worker-84b6cd7fc-abc12
```

Events:

```
Warning  Failed  30s  kubelet  Failed to pull image "myregistry.example.com/worker:1.2.3":
  rpc error: code = Unknown desc = failed to pull and unpack image
  "myregistry.example.com/worker:1.2.3": failed to resolve reference:
  unexpected status code: 401 Unauthorized
```

**In plain words:** the kubelet on the node tried to pull the image from `myregistry.example.com`, got a 401 Unauthorized. The image exists; the registry rejected the credentials.

**Step 2: Is `imagePullSecrets` configured on the Pod?**

```bash
kubectl get pod worker-84b6cd7fc-abc12 -o yaml | grep -A 2 imagePullSecrets
```

Nothing.

**Step 3: Is it on the ServiceAccount?**

```bash
kubectl get sa default -o yaml
```

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: default
  namespace: default
```

No `imagePullSecrets` there either. So the Pod has no credentials to authenticate to the registry.

**Step 4: Does the pull secret even exist?**

```bash
kubectl get secret -o custom-columns='NAME:.metadata.name,TYPE:.type' | grep dockerconfigjson
```

Empty — no pull secret exists at all.

### Root cause

The Deployment references a private registry image, but no `imagePullSecrets` are configured — neither on the Pod nor on the ServiceAccount it runs as. Kubelet has no credentials to pull.

### Fix

**Step 1 — Create the pull secret:**

```bash
kubectl create secret docker-registry regcred \
  --docker-server=myregistry.example.com \
  --docker-username=my-username \
  --docker-password='my-password-or-token' \
  --docker-email=me@example.com
```

**In plain words:** creates a Secret of type `kubernetes.io/dockerconfigjson` containing the registry credentials in the format kubelet expects.

**Step 2 — Attach the secret** (two ways):

**Option A — on the Pod:**

```yaml
spec:
  template:
    spec:
      imagePullSecrets:
        - name: regcred
```

**Option B — on the ServiceAccount** (cleaner — every Pod using this SA inherits):

```bash
kubectl patch serviceaccount default \
  -p '{"imagePullSecrets":[{"name":"regcred"}]}'
```

**Step 3 — force Pods to retry the pull:**

```bash
kubectl delete pod -l app=worker
```

The Deployment recreates Pods; they now pick up the pull secret and succeed.

Verify:

```bash
kubectl get pods -l app=worker
```
```
NAME                     READY   STATUS    RESTARTS   AGE
worker-84b6cd7fc-def78   1/1     Running   0          30s
```

### Prevention

1. **Bake pull secrets into every ServiceAccount** that pulls from a private registry. Add via the `default` SA in each namespace, or use External Secrets Operator to sync from a central secret store.

2. **CI check for `imagePullSecrets`** — a pre-deploy validator that fails builds if a Deployment references a non-public registry without a pull secret configured.

3. **Rotate pull-secret credentials on a schedule.** Store the source in your secret manager (Vault, AWS Secrets Manager); sync into K8s via External Secrets Operator. Manual rotation via `kubectl create secret` on a laptop is a smell.

---

## Incident #7: In-cluster DNS lookups intermittently failing

### Symptom

Users report the checkout service is randomly timing out on `db.internal.svc.cluster.local`. Not all requests — maybe 5-10%. Logs show:

```
Error: getaddrinfo ENOTFOUND db.internal.svc.cluster.local
```

The DB itself is fine; other services reach it constantly.

### Diagnosis path

**Step 1: Test DNS from inside a Pod**

```bash
kubectl exec -it checkout-abc123 -- nslookup db.internal.svc.cluster.local
```

Sometimes works:

```
Server:    10.43.0.10
Address:   10.43.0.10#53
Name:      db.internal.svc.cluster.local
Address:   10.42.1.15
```

Sometimes fails:

```
;; connection timed out; no servers could be reached
```

So the DNS server itself is intermittently unreachable. Not a resolution problem — a reachability problem.

**Step 2: Check CoreDNS Pods**

```bash
kubectl get pods -n kube-system -l k8s-app=kube-dns
```

```
NAME                      READY   STATUS    RESTARTS   AGE
coredns-64fd4b4794-abc12  1/1     Running   0          5d
coredns-64fd4b4794-def34  1/1     Running   0          5d
```

Both look fine. But wait — 2 replicas serving a cluster with hundreds of Pods?

**Step 3: Check CoreDNS resource usage and error rate**

```bash
kubectl top pods -n kube-system -l k8s-app=kube-dns
```

```
NAME                      CPU(cores)   MEMORY(bytes)
coredns-64fd4b4794-abc12  200m         85Mi
coredns-64fd4b4794-def34  198m         84Mi
```

Both saturated at 200m CPU. Check their resource limits:

```bash
kubectl get pod coredns-64fd4b4794-abc12 -n kube-system -o jsonpath='{.spec.containers[*].resources.limits}'
```

```
{"cpu":"200m","memory":"170Mi"}
```

**CoreDNS is being throttled** — hitting its 200m CPU limit under load, which introduces latency and dropped queries.

**Step 4: Confirm with CoreDNS logs**

```bash
kubectl logs -n kube-system coredns-64fd4b4794-abc12 --tail=100 | grep -i error
```

```
[ERROR] plugin/errors: 2 db.internal.svc.cluster.local. A: read udp 10.42.0.4:44532->10.43.0.10:53: i/o timeout
```

Even CoreDNS itself is having trouble responding in time.

**Step 5: What's a normal query load?**

```bash
# Look at CoreDNS's built-in Prometheus metrics
kubectl port-forward -n kube-system svc/kube-dns 9153:9153 &
curl -s http://localhost:9153/metrics | grep coredns_dns_requests_total
```

Sum showing thousands of queries per second — because every service call inside the cluster generates a DNS lookup.

### Root cause

CoreDNS was under-provisioned for the cluster's actual query volume. Two replicas at 200m CPU couldn't keep up — queries queued, some timed out. Intermittent failures on random Pods.

### Fix

**Immediate:** scale CoreDNS up:

```bash
kubectl scale deployment coredns -n kube-system --replicas=6
```

DNS resolves reliably again within seconds.

**Long-term:**

1. **Raise resource limits:**

```yaml
resources:
  requests: { cpu: 100m, memory: 128Mi }
  limits:   {           memory: 256Mi }   # no CPU limit → no throttling
```

Note: omitting the CPU limit for latency-critical DNS is a valid choice — leaves the request as the reservation, avoids CFS throttling. See the [autoscaling deep-dive](autoscaling-resources/INTERVIEW-DEEP-DIVE.md).

2. **Enable HPA on CoreDNS:**

```bash
kubectl autoscale deployment coredns -n kube-system --min=3 --max=20 --cpu-percent=70
```

3. **Enable NodeLocal DNSCache** — a DaemonSet that caches DNS answers locally per node, drastically reducing load on central CoreDNS:

```bash
kubectl apply -f https://raw.githubusercontent.com/kubernetes/kubernetes/master/cluster/addons/dns/nodelocaldns/nodelocaldns.yaml
```

**In plain words:** every node runs a small DNS cache. Pod queries hit the local cache first (0ms), fall through to CoreDNS only on cache miss. Cuts CoreDNS load by 90%+.

### Prevention

1. **Monitor CoreDNS.** SLIs to alert on: query latency p99, error rate, cache hit rate.

2. **Include CoreDNS in your capacity planning.** Rule of thumb: 1 CoreDNS replica per 100 Pods (loose starting point; validate with metrics).

3. **Configure `ndots: 2`** in Pods to reduce unnecessary lookups. Default is `ndots: 5`, which means single-word hostnames like `db` get tried against every search domain first (5 failed lookups) before being tried as-is. Set:

```yaml
spec:
  dnsConfig:
    options:
      - name: ndots
        value: "2"
```

Cuts wasteful DNS traffic significantly.

---

## Incident #8: PVC stuck Pending — StatefulSet won't start

### Symptom

Applied a new StatefulSet:

```
NAME       READY   AGE
db         0/3     8m
```

Pod status:

```
NAME    READY   STATUS    RESTARTS   AGE
db-0    0/1     Pending   0          8m
```

Even `db-0` never came up. What's blocking it?

### Diagnosis path

**Step 1: Why is db-0 pending?**

```bash
kubectl describe pod db-0
```

Events:

```
Warning  FailedScheduling  30s  default-scheduler  0/3 nodes are available:
  3 pod has unbound immediate PersistentVolumeClaims.
```

**In plain words:** the Pod needs a PVC to mount, and the PVC hasn't bound to a PV yet. Scheduler won't place the Pod until storage is ready.

**Step 2: Look at the PVC**

```bash
kubectl get pvc
```

```
NAME       STATUS    VOLUME   CAPACITY   ACCESS MODES   STORAGECLASS   AGE
data-db-0  Pending                                     gp3-encrypted   8m
```

Status: `Pending`. StorageClass: `gp3-encrypted`.

**Step 3: Does that StorageClass exist?**

```bash
kubectl get storageclass
```

```
NAME              PROVISIONER          RECLAIMPOLICY   VOLUMEBINDINGMODE
gp3               ebs.csi.aws.com      Delete          WaitForFirstConsumer
local-path        rancher.io/local-path Delete         WaitForFirstConsumer
```

No `gp3-encrypted`. The StorageClass the StatefulSet references doesn't exist in the cluster.

### Root cause

The StatefulSet's `volumeClaimTemplates` specified `storageClassName: gp3-encrypted`, but the cluster only has `gp3` and `local-path` StorageClasses. Without a matching StorageClass, dynamic provisioning can't create a PV, PVC stays Pending, Pod stays Pending.

### Fix

**Option A — use an existing StorageClass** (if you don't specifically need encryption):

```bash
# Edit the StatefulSet
kubectl edit statefulset db
```

Change `storageClassName: gp3-encrypted` to `storageClassName: gp3`. But wait — StatefulSets don't let you edit `volumeClaimTemplates` in place. You have to:

1. Delete the PVC (still Pending, so no data loss).
2. Delete the StatefulSet.
3. Reapply the fixed YAML.

```bash
kubectl delete pvc data-db-0
kubectl delete statefulset db
kubectl apply -f fixed-statefulset.yaml
```

**Option B — create the missing StorageClass** (if you do need encryption):

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3-encrypted
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  encrypted: "true"
  kmsKeyId: arn:aws:kms:us-east-1:123456789012:key/abc-123
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Delete
allowVolumeExpansion: true
```

```bash
kubectl apply -f gp3-encrypted-storageclass.yaml
```

Once the class exists, the pending PVC will bind automatically.

### Prevention

1. **Pre-check StorageClass in CI.** Before applying a StatefulSet, verify the referenced `storageClassName` exists in the target cluster:

```bash
CLASS=$(yq '.spec.volumeClaimTemplates[0].spec.storageClassName' statefulset.yaml)
kubectl get storageclass "$CLASS" || {
  echo "❌ StorageClass $CLASS not found in target cluster"
  exit 1
}
```

2. **Document per-cluster StorageClass inventory.** New team members shouldn't guess which classes exist where. Keep a table:

| Cluster | StorageClass | Provisioner | Use case |
|---|---|---|---|
| prod-us-east | gp3 | ebs.csi.aws.com | default block storage |
| prod-us-east | gp3-encrypted | ebs.csi.aws.com | KMS-encrypted volumes |
| prod-us-east | efs | efs.csi.aws.com | shared filesystem (RWX) |

3. **Set a default StorageClass** so PVCs without an explicit class still bind. This isn't a fix for this specific incident (the class was named) but prevents worse cases where new PVCs silently break.

---

## Incident #9: HPA sitting at "unknown / 70%" not scaling

### Symptom

Load on the API service climbs. Users report latency. But HPA isn't scaling:

```
NAME   REFERENCE            TARGETS         MINPODS   MAXPODS   REPLICAS   AGE
api    Deployment/api       <unknown>/70%   2         20        2          4h
```

`<unknown>` — HPA can't get a reading.

### Diagnosis path

**Step 1: Is metrics-server working?**

```bash
kubectl top nodes
```

```
error: Metrics API not available
```

**In plain words:** metrics-server is what feeds HPA its CPU/memory readings. If `kubectl top` doesn't work, HPA can't get data either.

**Step 2: Is metrics-server even installed / running?**

```bash
kubectl get pods -n kube-system -l k8s-app=metrics-server
```

Case A — nothing returned:

```
No resources found in kube-system namespace.
```

Not installed. Install it:

```bash
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
```

Case B — present but not Ready:

```
NAME                              READY   STATUS    RESTARTS   AGE
metrics-server-7bfffcd44-s5jqz    0/1     Running   200        3d
```

Look at its logs:

```bash
kubectl logs -n kube-system metrics-server-7bfffcd44-s5jqz
```

Common error:

```
E0729 09:15:22.311 scraper.go:139] "Failed to scrape node" err="Get \"https://10.0.1.42:10250/metrics/resource\": tls: failed to verify certificate: x509: cannot validate certificate for 10.0.1.42 because it doesn't contain any IP SANs"
```

**In plain words:** metrics-server can't scrape the kubelet on nodes because the kubelet's TLS certificate is self-signed and metrics-server refuses to trust it.

**Step 3: Also check that Pods have CPU requests**

Even with metrics-server working, HPA calculates utilization *against* the CPU request. If requests aren't set, utilization is undefined.

```bash
kubectl get deployment api -o jsonpath='{.spec.template.spec.containers[*].resources.requests}'
```

If empty:

```
{}
```

That's the problem too.

### Root cause

Two issues stacked:
1. `metrics-server` was installed but failing to scrape kubelets due to TLS validation. Common on kubeadm / self-hosted / k3s installs where kubelet certs are self-signed.
2. The Deployment didn't set CPU requests, so even with metrics available, HPA couldn't compute utilization.

### Fix

**Fix 1: Let metrics-server accept the kubelet's cert.**

```bash
kubectl edit deployment metrics-server -n kube-system
```

Add the `--kubelet-insecure-tls` flag:

```yaml
containers:
  - name: metrics-server
    args:
      - --cert-dir=/tmp
      - --secure-port=4443
      - --kubelet-preferred-address-types=InternalIP,ExternalIP,Hostname
      - --kubelet-use-node-status-port
      - --metric-resolution=15s
      - --kubelet-insecure-tls        # <-- add this
```

**In plain words:** tells metrics-server "trust the kubelet cert without verifying." Fine for internal cluster-only traffic. Managed clusters (EKS, GKE) don't need this — they use properly signed certs.

Wait ~30 seconds for metrics to populate:

```bash
kubectl top nodes
```
```
NAME     CPU(cores)   CPU%   MEMORY(bytes)   MEMORY%
node-1   245m         12%    1200Mi          15%
```

**Fix 2: Add CPU requests to the Deployment.**

```yaml
resources:
  requests:
    cpu: 200m
    memory: 256Mi
  limits:
    memory: 512Mi
```

Apply. Trigger a Pod restart:

```bash
kubectl rollout restart deployment/api
```

**Fix 3: Verify HPA now sees metrics.**

```bash
kubectl get hpa api
```
```
NAME   REFERENCE            TARGETS       MINPODS   MAXPODS   REPLICAS   AGE
api    Deployment/api       45%/70%       2         20        2          4h
```

Numbers instead of `<unknown>`.

### Prevention

1. **Post-install verification:** whenever you install a K8s addon, run its "smoke test." For metrics-server:

```bash
kubectl top nodes >/dev/null && echo "✅ metrics-server OK" || echo "❌ metrics-server broken"
```

Include in your cluster-bootstrap CI.

2. **Mandate resource requests via policy.** Use Kyverno or OPA Gatekeeper to reject any Pod that doesn't specify `requests.cpu` and `requests.memory`. Enforced at admission — bad manifests can't even reach the cluster.

3. **Alert on `HPA target unknown` state:**

```
kube_horizontalpodautoscaler_status_current_metrics_average_utilization == 0
```

If HPA metrics silently go unknown in prod, you don't want to discover it during the next traffic spike.

---

## Incident #10: NetworkPolicy silently breaking legit traffic

### Symptom

A security team applied a "zero-trust" NetworkPolicy across the `prod` namespace. Two hours later, alerts fire: the payments service can't reach its Redis cache. Users see 5xx from the checkout flow.

But there's no error in payments' pod logs — the connections just hang, then time out.

### Diagnosis path

**Step 1: Confirm the connection is being blocked, not the app is broken**

```bash
kubectl exec -it payments-6d8f5b9c-xyz12 -- nc -zv redis 6379
```

```
Connecting to redis (10.43.55.12:6379) ... nc: bad address
```

Wait — it can't even resolve? Or:

```
Connecting to redis (10.43.55.12:6379) ... timed out
```

TCP-level timeout with the address resolving — that's classic NetworkPolicy block. TCP SYN sent, no SYN-ACK, no RST — the packet is silently dropped by the CNI.

**Step 2: Look at what NetworkPolicies exist**

```bash
kubectl get networkpolicies -n prod
```

```
NAME                         POD-SELECTOR    AGE
default-deny-all             <none>          2h
allow-frontend-to-backend    app=backend     2h
allow-monitoring-scrape      app=backend     2h
```

**In plain words:** the `default-deny-all` policy selects **all Pods** in the namespace (empty selector), and with no ingress rules, blocks all inbound traffic. Only Pods with explicit allow rules can receive traffic.

**Step 3: Which Pods does the deny hit? Payments and Redis both**

Payments' outbound isn't restricted (this deny only affects Ingress). But **Redis's inbound is fully denied** — no policy allows connections *to* Redis. So payments → Redis is blocked at Redis's ingress.

**Step 4: Verify by checking the missing allow rule**

```bash
kubectl get networkpolicies -n prod -o yaml | grep -B 2 -A 20 "app: redis"
```

Empty. No policy allows traffic to Redis.

### Root cause

The `default-deny-all` policy correctly denied everything by default, but the accompanying "allow" policies only covered frontend→backend and monitoring→backend. Payments→Redis was never included — a gap in the allowlist.

### Fix

**Immediate — restore payments→Redis:**

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-payments-to-redis
  namespace: prod
spec:
  podSelector:
    matchLabels:
      app: redis
  policyTypes:
    - Ingress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: payments
      ports:
        - protocol: TCP
          port: 6379
```

```bash
kubectl apply -f allow-payments-to-redis.yaml
```

**In plain words:** allow Pods with `app=payments` to connect to Pods with `app=redis` on port 6379. Payments should recover within seconds — the CNI reprograms rules immediately.

**Verify:**

```bash
kubectl exec -it payments-6d8f5b9c-xyz12 -- nc -zv redis 6379
```

```
Connecting to redis (10.43.55.12:6379) ... open
```

### Prevention

1. **Never apply default-deny to a namespace without a documented service map.** Every service-to-service communication needs a corresponding allow policy. Build the map first, then apply the deny.

2. **Stage in "audit" mode first.** Cilium and Calico support policy audit mode: log what *would* be denied without actually denying. Run for 24 hours, review the logs, then flip to enforce.

3. **Emergency escape valve.** Keep a well-known "break glass" NetworkPolicy YAML in the runbook that allows all traffic in the namespace:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: emergency-allow-all
  namespace: prod
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
  ingress: [{}]
  egress:  [{}]
```

Apply this in an incident to restore service, then unwind the strict policies gradually. Faster than debugging under pressure.

4. **CI test for connectivity.** After applying policies, run a matrix of `nc -zv` from each service to each dependency it should be able to reach. If any hang, the policy is incomplete.

---

## Incident #11: Node NotReady, workloads evacuating

### Symptom

Alerts fire: multiple Pods evicted. `kubectl get nodes` shows:

```
NAME     STATUS     ROLES                  AGE    VERSION
node-1   Ready      <none>                 90d    v1.30.5
node-2   NotReady   <none>                 90d    v1.30.5
node-3   Ready      <none>                 90d    v1.30.5
```

`node-2` is NotReady. Pods on it started getting evicted 5 minutes ago; ReplicaSets are spinning up replacements on node-1 and node-3, which are now over-loaded.

### Diagnosis path

**Step 1: Why is the node NotReady?**

```bash
kubectl describe node node-2
```

Conditions section:

```
Conditions:
  Type             Status  LastHeartbeatTime   Reason
  MemoryPressure   True    Mon, 29 Jul 15:22    KubeletHasInsufficientMemory
  DiskPressure     True    Mon, 29 Jul 15:22    KubeletHasDiskPressure
  PIDPressure      False   Mon, 29 Jul 15:22    KubeletHasSufficientPID
  Ready            False   Mon, 29 Jul 15:22    KubeletNotReady
```

**In plain words:** the node is under memory pressure AND disk pressure. Kubelet stops accepting new workloads and starts evicting existing ones.

**Step 2: Which is the primary trigger — memory or disk?**

```bash
kubectl top node node-2
```

```
NAME     CPU(cores)   CPU%   MEMORY(bytes)   MEMORY%
node-2   500m         25%    7800Mi          95%
```

Memory at 95%. But also disk pressure — let's check that separately.

**Step 3: Check node disk usage (via ssh or debug pod)**

```bash
kubectl debug node/node-2 -it --image=busybox
```

Inside the debug Pod (which mounts the node's filesystem at `/host`):

```
/ # df -h /host
Filesystem      Size  Used Avail Use% Mounted on
overlay          40G   38G  1.5G  96% /host
```

Root disk at 96% full.

**Step 4: What's using the disk?**

```
/ # du -sh /host/var/lib/containerd /host/var/log /host/var/lib/kubelet 2>/dev/null | sort -rh
25G  /host/var/lib/containerd
8G   /host/var/log
3G   /host/var/lib/kubelet
```

`/var/lib/containerd` — container images and layers. 25GB. Probably many old images that weren't garbage-collected.

**Step 5: Check container GC settings**

Container image GC kicks in based on disk usage thresholds. But if the threshold isn't set right, or the GC hasn't run recently...

```
/ # crictl images | wc -l
147
```

147 container images on this node. Way too many.

### Root cause

Container image GC was disabled or misconfigured. Old image layers accumulated over 90 days, filling `/var/lib/containerd`. Once disk exceeded the eviction threshold, kubelet marked the node NotReady and started evicting Pods. Compounding it, memory was also high because now the remaining Pods on healthy nodes are over-scheduled.

### Fix

**Immediate — free up disk on node-2:**

```bash
# Cordon the node so no new Pods get scheduled here (they're already avoiding it, but be explicit)
kubectl cordon node-2

# From a debug Pod on the node, force cleanup:
crictl rmi --prune
```

**In plain words:** `crictl rmi --prune` removes container images not currently in use by any Pod. Should free tens of gigabytes.

Verify:

```
/ # df -h /host
Filesystem      Size  Used Avail Use% Mounted on
overlay          40G   12G   28G  30% /host
```

Kubelet detects the pressure clear within a couple of minutes, node returns to Ready:

```bash
kubectl get nodes
```

```
NAME     STATUS   ROLES    AGE    VERSION
node-1   Ready    <none>   90d    v1.30.5
node-2   Ready    <none>   90d    v1.30.5
node-3   Ready    <none>   90d    v1.30.5
```

```bash
kubectl uncordon node-2
```

**Long-term:**

1. **Configure kubelet image GC.** Set eviction thresholds and image GC thresholds explicitly:

```yaml
# /etc/kubernetes/kubelet-config.yaml
imageGCHighThresholdPercent: 80
imageGCLowThresholdPercent: 70
evictionHard:
  memory.available: "100Mi"
  nodefs.available: "10%"
  imagefs.available: "10%"
```

**In plain words:** when disk hits 80% used, kubelet runs image GC to bring it back down to 70%. Eviction thresholds define when the node starts marking itself NotReady.

2. **Set image pull policy to `IfNotPresent`** on non-`:latest` images. Don't repeatedly pull the same tagged image.

3. **Ephemeral-storage requests and limits.** For Pods that write to their filesystem (logs, temp files), declare it:

```yaml
resources:
  requests:
    ephemeral-storage: 1Gi
  limits:
    ephemeral-storage: 5Gi
```

If a Pod exceeds its ephemeral-storage limit, it gets evicted individually — not the whole node.

### Prevention

1. **Alert on node disk usage.** Prometheus rule:

```
disk_used_percent > 75  for 15m  → warning
disk_used_percent > 85  for 5m   → critical
```

You should never wake up to a node already NotReady from disk. The alert should fire days in advance.

2. **Log retention policies.** `/var/log` accumulates. Set logrotate policies, or ship logs via Fluent Bit to external storage and truncate locally.

3. **Node auto-remediation.** In managed clusters (EKS, GKE), enable node auto-repair — the cloud will replace a NotReady node automatically after a timeout. Provides a floor of self-healing.

4. **Add PodDisruptionBudgets** so that even if a node evacuation cascades, critical workloads keep enough replicas up:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: checkout-pdb
spec:
  minAvailable: 3
  selector:
    matchLabels:
      app: checkout
```

Kubernetes won't evict more Pods from a Deployment than the PDB allows, even under node pressure.

---

## Common thread across all these incidents

Read the incidents above and one pattern jumps out: **the diagnostic path is more valuable than the fix.** The commands to run — `describe`, `logs`, `events`, `top`, `nslookup` — are the same across incidents. What changes is the *interpretation* of the output.

The instinct to build:

1. **`describe` first**, always. Events section is 80% of debugging.
2. **`logs --previous`** for anything that just crashed.
3. **`top nodes` and `top pods`** for anything that feels resource-constrained.
4. **`get events --sort-by=.lastTimestamp`** for cluster-wide weirdness.
5. **`exec -it ... -- nc / nslookup / curl`** for connectivity questions.
6. **`auth can-i`** for permission questions.

If you can drive those six commands fluently, you can debug most of what will ever happen to you on Kubernetes. See [KUBECTL-GUIDE.md](KUBECTL-GUIDE.md) for the full command walkthrough.

Then remember the two-track pattern: **mitigate first, root-cause second.** Roll back, cordon, restore. Then investigate what actually broke, so it can't happen the same way twice.
