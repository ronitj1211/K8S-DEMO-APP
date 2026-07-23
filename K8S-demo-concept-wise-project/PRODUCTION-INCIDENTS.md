# Production Incidents — Interview Stories

The single most-asked interview question for anyone working on infrastructure is:

> **"Tell me about a production incident you handled."**

You need one ready. This doc gives you three complete incident stories in the format interviewers want, plus detailed step-by-step explanations of what every command did and why — in plain language, so anyone can understand and adapt them.

---

## The framework interviewers want

Every good incident story has five parts, in this order:

| Part | What goes here |
|---|---|
| **Symptom** | What alerted you / what the user saw. Concrete, not vague. |
| **Diagnosis path** | The specific steps you took, in order, and what each revealed. |
| **Root cause** | The one-sentence-ish "why it happened" that explains everything. |
| **Fix** | Immediate mitigation, then the actual root fix. Two stages. |
| **Prevention** | Changes you made so this class of thing can't happen again. |

Why this shape works:
- **Symptom first** shows you don't assume — you observe.
- **Diagnosis path** shows how you *think*, not just what you know.
- **Root cause** proves you got to the real answer instead of stopping at a symptom.
- **Fix in two stages** proves you understand the difference between "stop the bleeding" and "cure the disease."
- **Prevention** shows you're a builder, not a firefighter.

Never say "I don't remember exactly" — pick a real one, remember it in detail. Or use one of these as a template with your own project names.

---

## Incident #1: Cascading Pod Evictions from a Memory Leak

This is the strongest generic answer — everyone has seen an OOMKill, so nobody will call it exotic, but the diagnosis path shows depth.

### The setting

A checkout service running on Kubernetes with a Deployment of ~6 replicas, fronted by a Service and an Ingress. Traffic pattern: steady weekdays with a lunchtime peak.

### The symptom (what got us paged)

At 12:14 UTC, PagerDuty fired: "checkout-service error rate > 2% for 5 minutes." I looked at our error dashboard and saw:

- **502 Bad Gateway** responses spiking every 15-20 minutes, not gradually rising.
- The spikes correlated with **Pods restarting** — not one Pod slowly getting sicker, but sudden bursts.
- `kubectl get pods -n prod -l app=checkout` showed several Pods cycling through `Running → OOMKilled → CrashLoopBackOff → Running` in a ~2-minute loop.

The 502s were happening because when Pods restart, the Service's Endpoints briefly excludes them; if enough replicas are down at once, incoming requests can't find a healthy backend.

### The diagnosis path — step by step

Each command is explained in plain language, why we ran it, and what it told us.

#### Step 1: Confirm the crash reason

```bash
kubectl describe pod checkout-6d8f5b9c-xyz12 -n prod
```

**What this does in simple words:** Prints everything Kubernetes knows about a specific Pod — its status, recent events, container states, resource limits, and importantly, **why the last container died**.

**Why we ran it first:** Before doing anything else, we needed to know *exactly* how the Pods were dying. The word "OOMKilled" in `kubectl get pods` is a hint, but `describe` gives you the exit code and confirms it.

**What we saw:**

```
Last State:  Terminated
  Reason:    OOMKilled
  Exit Code: 137
  Started:   Mon, 15 Jul 2026 12:01:22 UTC
  Finished:  Mon, 15 Jul 2026 12:19:47 UTC
```

- **"OOMKilled"** = the Linux kernel killed the container because it exceeded its memory limit.
- **"Exit Code: 137"** = 128 + 9 (SIGKILL). Confirms it wasn't a graceful shutdown; the kernel used the OOM killer.
- **"Finished at 12:19"** — the container ran for ~18 minutes before dying. That's important — a healthy container doesn't die on a schedule.

#### Step 2: Check the memory limit

Same `describe` output further down:

```
Limits:    memory: 512Mi, cpu: 500m
Requests:  memory: 256Mi, cpu: 200m
```

**What this tells us:** The container was allowed up to 512Mi. The moment it tried to use more, the kernel killed it.

**Why this matters:** If the limit were 5 GB, we'd suspect a runaway allocation or a huge single request. 512Mi is normal for a lean Node/Python service. So the leak was gradual.

#### Step 3: Look at memory usage over time

We opened Grafana and queried Prometheus:

```
container_memory_working_set_bytes{pod=~"checkout-.*", container="checkout"}
```

**What this does in simple words:** Prometheus stores every container's actual memory usage over time. This query pulls the graph for all Pods of the `checkout` service. "Working set" is the memory the container is actively using (excluding freeable cache).

**Why we needed this:** `kubectl describe` gives you a snapshot right now. To see if this is a leak or a spike, you need the **shape over time**.

**What we saw — the classic sawtooth**:

```
memory
  ^
  |          /|          /|          /|
  |         / |         / |         / |
  |        /  |        /  |        /  |
  |       /   X       /   X       /   X   ← OOM kill, restart
  |      /    |      /    |      /    |
  |_____/_____|_____/_____|_____/_____|_____
        0    18min  0    18min  0    18min       time
```

**Reading the graph:** Memory climbs from ~200Mi at Pod start, up to 512Mi at ~18 minutes, container dies, kubelet restarts it, memory drops back to ~200Mi, and the whole shape repeats.

**Why the sawtooth was the smoking gun:**
- A **traffic spike** would show a fast rise then plateau or drop.
- A **memory leak** shows a **monotonic climb** regardless of traffic.
- Because the climb continued even during low-traffic windows (we checked the request-rate graph in parallel and it dipped between spikes), traffic wasn't the cause.

That's the diagnostic move — "memory grew during low traffic" is what rules out traffic-driven memory bloat and locks in "leak."

#### Step 4: Look at what changed recently

```bash
kubectl rollout history deployment/checkout -n prod
```

**What this does in simple words:** Shows every version of the Deployment (revision history). Each `kubectl apply` or image update creates a new revision.

**Why we ran it:** Production incidents that appear "suddenly" are almost always tied to a recent change. Before diving into code, check what changed and when.

**What we saw:**

```
REVISION  CHANGE-CAUSE
14        image bump to checkout:1.42.0
15        image bump to checkout:1.43.0    ← last change, 2 days ago
```

Two days ago something shipped. Not "yesterday" — which is why we hadn't noticed sooner; the leak was slow.

#### Step 5: Look at what the change actually contained

We opened the merged PR for `1.43.0` in GitHub. The changelog said "add response caching for the /pricing endpoint." Opened `pricing_cache.py`:

```python
CACHE = {}

def get_pricing(sku):
    if sku not in CACHE:
        CACHE[sku] = expensive_lookup(sku)
    return CACHE[sku]
```

**Reading this code in plain words:**
- A Python dictionary called `CACHE` at module level (survives for the lifetime of the process).
- When someone asks for a SKU's pricing, check the dict. If it's there, return it. If not, do the expensive lookup and **store the result forever**.

**Why this is a bug:** No maximum size, no eviction policy, no time-to-live. Every unique SKU ever requested stays in memory forever. In production, we had ~40,000 unique SKUs and were slowly discovering more via customer searches. Every request added potential entries.

At about 40k entries × ~10Kb per entry (each cached response was a fair-sized JSON blob) = ~400Mb of cache. Plus normal process memory (~200Mb baseline) = ~600Mb. Container limit was 512Mi. OOM.

### The root cause — one sentence

> The new pricing cache used an unbounded dictionary with no TTL or size limit, so it grew without bound as unique SKUs were queried, eventually exceeding the container's memory limit and triggering OOM kills every ~18 minutes.

### The fix — two stages

#### Immediate mitigation (2 minutes into the incident)

```bash
kubectl rollout undo deployment/checkout -n prod
```

**What this does in simple words:** Kubernetes remembers old versions of the Deployment. This command rolls back to the previous version — same image, same config as before the bad change. Pods restart on the old (working) image.

**Why we did this first:**
- **Stop the bleeding**. Users hitting 502s don't care about the root cause; they care that checkout works.
- Rolling back is safer than trying to hotfix under pressure. We had a known-good version one command away.
- The pattern here — **rollback first, root-fix second** — is a hallmark of good incident response.

Within 90 seconds, `kubectl get pods` showed all Pods on the previous revision, Running, Ready. Error rate dropped to baseline. Incident downgraded from "active fire" to "post-mortem in progress."

#### Real fix (that same day)

Two changes:

**1. Replace the unbounded dict with a real cache.**

```python
from cachetools import TTLCache

CACHE = TTLCache(maxsize=5000, ttl=300)   # 5k entries, 5-minute expiry
```

**In plain words:** `TTLCache` is a Python library cache with two guardrails:
- `maxsize=5000` — at most 5000 entries. When full, adding a new one evicts the least-recently-used.
- `ttl=300` — every entry expires after 5 minutes regardless.

Together these bound memory usage to a predictable number, no matter how many unique SKUs get requested.

**2. Verified under load before shipping.**

Before merging the fix, we ran a **soak test** — synthetic sustained traffic for 30 minutes with a Python memory profiler attached. Memory rose to about 380Mb (the cache filled to its size limit), then held steady. Sawtooth eliminated.

**3. Bumped the memory limit slightly with headroom.**

```yaml
resources:
  limits:
    memory: 768Mi     # was 512Mi
  requests:
    memory: 384Mi     # was 256Mi
```

**Why:** the fixed version needed ~380Mb steady-state. We wanted headroom for future feature growth without immediately hitting the limit again. Not a huge bump, but based on measured usage.

### The prevention

Postmortem produced three concrete items:

**1. Alert on memory *growth rate*, not just absolute usage.**

The original alert only fired when a Pod was already OOMKilled — too late. The new alert:

```
Prometheus rule:
  expr: rate(container_memory_working_set_bytes{...}[10m]) > 5*1024*1024
  for: 30m
```

**In plain words:** if a container's memory is growing more than 5Mb every 10 minutes, sustained for 30 minutes → page. A stable app has memory usage that hovers; a leaking app has memory that climbs. Growth-rate alerts catch leaks *before* the OOM, ideally in staging.

**2. Added a memory soak-test step to CI.**

Every new image runs through a 30-minute synthetic-load test with memory monitored. If memory grows more than X% between minute 5 and minute 30, the pipeline fails the build.

**In plain words:** we now automatically do what we did manually for the fix. Leaks like this can't get through CI anymore.

**3. Added a PodDisruptionBudget.**

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: checkout-pdb
spec:
  minAvailable: 4        # of 6 replicas, at least 4 must be up at all times
  selector:
    matchLabels: { app: checkout }
```

**In plain words:** even during future incidents like this, Kubernetes won't let too many Pods be unavailable at once. If 3 Pods are already OOMKilled and cycling, the PDB stops normal disruptions (like node drains) from taking down a 4th. Limits the blast radius.

### The interview version

Here's how to say it in 60-90 seconds:

> We got paged at midday for a 502 spike on our checkout service. `kubectl get pods` showed several Pods cycling through OOMKilled → restart every 18 minutes, not correlated with traffic. `kubectl describe` confirmed OOMKilled with exit code 137. In Grafana, memory showed a clear sawtooth pattern — climbing steadily from Pod start to the 512Mi limit, then dying. Because the climb continued during low-traffic windows, it wasn't a traffic issue — it was a leak.
>
> `kubectl rollout history` showed a new version had shipped two days earlier that added response caching. I opened the code and found a plain Python dictionary being used as a cache — no max size, no TTL. Every unique request was being cached forever.
>
> Immediate fix: `kubectl rollout undo` to the previous version — restored service in about 90 seconds. Real fix: replaced the dictionary with a proper LRU cache with a max size and TTL, soak-tested it under sustained load with a memory profiler, and bumped the memory limit slightly based on the measured steady-state usage.
>
> Postmortem produced three changes: a Prometheus alert on memory *growth rate* rather than just absolute threshold, a mandatory 30-minute soak test in CI to catch leaks before they ship, and a PodDisruptionBudget on the checkout Deployment so future incidents can't disrupt too many replicas at once.

---

## Incident #2: Cluster-Wide API Slowness from etcd Disk Contention

Use this one if the interviewer already asked about a "typical" incident and you want to demonstrate deeper cluster ops knowledge.

### The setting

A managed EKS cluster running ~40 services. Suddenly, `kubectl` commands started taking 15+ seconds for simple things. New Pods scheduled slowly. Everything felt sluggish, but nothing was actually crashing.

### The symptom

- SREs complaining that `kubectl get pods` was taking 20+ seconds.
- Deployments' new Pods were sitting in `Pending` for minutes before scheduling.
- HPA-triggered scale-ups were arriving late — CPU already high before new Pods came online.
- No 5xx errors from apps. No CrashLoopBackOffs. **Just slow.**

### The diagnosis path

#### Step 1: Confirm the slowness is in the control plane, not the network

```bash
time kubectl get pods -n prod
```

**In plain words:** `time` reports how long a command took. `kubectl get pods` normally takes < 1 second.

We saw:

```
real    0m22.4s
```

22 seconds. That's the API server responding slowly. If it were network-only, we'd see failures or intermittent hangs, not consistent slow responses.

#### Step 2: Check API server metrics

Every managed K8s exposes API server metrics. In EKS: CloudWatch Container Insights → Control Plane metrics.

**In plain words:** the API server is a program that all `kubectl` commands eventually hit. It stores state in **etcd** (a special database). If either the API server or etcd is slow, everything is slow.

**What we saw:**

- API server request latency p99: normally 50ms, now 8-15 seconds.
- etcd disk fsync latency p99: normally under 50ms, now **1.2 seconds**.

That last number was the smoking gun. `fsync` is "make sure this write is durably on disk." If fsync takes over a second, etcd can't commit writes fast enough — every K8s operation stalls.

#### Step 3: Understand why etcd's disk was slow

etcd is very sensitive to disk latency. In this cluster (an older setup we'd inherited), etcd's data directory sat on a shared EBS volume that also held other node-local caches. We checked EBS metrics:

- **VolumeQueueLength**: elevated (many pending I/O operations).
- **BurstBalance**: depleted (gp2 burst credits were used up).

**In plain words:**
- `VolumeQueueLength` = how many I/O requests are lined up waiting for the disk. High = disk is a bottleneck.
- `BurstBalance` = AWS gp2 disks have a "burst" performance mode; you accumulate credits when idle and burn them under high load. Once burnt to zero, performance drops to the baseline (which for a small gp2 was very low).

The disk had been fine for months, until another workload on the same volume started doing lots of writes, drained the burst credits, and now etcd was throttled to baseline performance.

### Root cause — one sentence

> etcd's data volume shared physical storage with a chatty workload; the workload's burst-credit consumption forced the volume down to baseline IOPS, making etcd's fsyncs 25× slower than normal, which stalled the entire Kubernetes API layer.

### Fix

**Immediate mitigation:** identified the chatty workload (a batch job doing bulk writes) and paused it. Burst credits regenerated over ~30 minutes, latency returned to normal.

**Real fix:** moved etcd's data to **dedicated local NVMe SSD** — completely isolated from any other workload. NVMe latency is measured in microseconds, so even under contention, etcd fsyncs stay under 5ms.

### Prevention

**1. etcd-specific SLOs and alerts.**

New alert: "etcd fsync p99 > 100ms for 5 minutes → page."

**In plain words:** we set a threshold well below the pain point. If disk latency ever creeps up, we know about it before it becomes user-visible.

**2. Runbook updated.**

Added a hard rule to our cluster-provisioning docs: etcd storage MUST be dedicated, local (not network), and NVMe-class. Reviewed by SRE for every new cluster.

**3. Capacity-planning docs.**

Documented the actual etcd disk requirements (IOPS, latency, size) so nobody re-invents the shared-volume mistake in a future cluster.

### The interview version

> We got a paging chain reporting cluster-wide slowness — kubectl was taking 20+ seconds, Pods were stuck Pending, and HPA scale-ups were late. Checked API server metrics and found request latency at 8-15 seconds, with etcd fsync latency at over a second. Normally etcd should be sub-50ms.
>
> Traced etcd's disk to a shared EBS volume with another workload that had drained its burst credits, throttling us to baseline IOPS. Immediate fix: paused the chatty workload so credits could regenerate. Real fix: moved etcd to dedicated NVMe local storage, which is what etcd really needs.
>
> The learnings became infrastructure standards: etcd fsync alert at 100ms p99, runbook requirement that etcd storage is always dedicated NVMe, and clear documentation of etcd's disk requirements so nobody makes that mistake in a new cluster.

---

## Incident #3: Rolling Update Caused a Full Outage from a Bad Readiness Probe

Use this if the interviewer wants to see you understand K8s primitives deeply.

### The setting

A routine deploy of the API service — image bump, standard rolling update. It should have been a non-event. Instead, we had a full outage for about 90 seconds during the rollout.

### The symptom

- Deploy started at 15:32.
- Between 15:32:30 and 15:34:00, the API service returned **100% 502 errors**.
- Grafana showed the Pod ready-count graph: old Pods scaled down, new Pods scaled up, but the count of `Ready` Pods hit **zero** for ~90 seconds.
- After 15:34:00, everything recovered.

### The diagnosis path

#### Step 1: Look at what "Ready" meant in this case

The Deployment had a readiness probe:

```yaml
readinessProbe:
  httpGet:
    path: /health
    port: 8080
  initialDelaySeconds: 2
  periodSeconds: 5
```

**In plain words:** Kubernetes marks a Pod "Ready" (able to receive traffic) once its `/health` endpoint returns 200. Traffic doesn't flow to a Pod until it's Ready. During a rolling update, old Pods stay Ready until new Pods become Ready — that's supposed to give continuous coverage.

#### Step 2: Look at what `/health` actually did

Opened the app's code:

```python
@app.get("/health")
def health():
    return {"status": "ok"}, 200
```

**In plain words:** the health endpoint always returned 200. It didn't check if the app was actually ready — it just confirmed the HTTP server was up.

#### Step 3: Look at what happens on Pod startup

Startup log for a new Pod:

```
15:33:12  HTTP server listening on :8080
15:33:12  Loading configuration from vault...
15:33:14  Establishing database connection pool...
15:33:22  Priming redis cache...
15:33:30  Warming up ML model...
15:33:41  ✅ Ready to serve traffic
```

**Reading this:** the HTTP server binds early (12s in), so `/health` starts responding 200 at 15:33:14 — but the app can't actually serve real requests until 15:33:41, almost 30 seconds later.

#### Step 4: Line up the timeline

- 15:33:12 — new Pod's HTTP server is up. `/health` returns 200.
- 15:33:14 — Kubernetes marks it Ready. Service Endpoints include it. Traffic starts flowing.
- 15:33:14 → 15:33:41 — Pod receives real requests, tries to hit DB/Redis/model, fails because it's not ready yet. Returns 502.
- Meanwhile, the old Pod (which *was* actually working) got terminated because "the new Pod is Ready."
- Rolling update proceeded, replacing more old Pods with new (fake-Ready) Pods.
- At 15:33:41, the first new Pod actually became truly ready. Traffic started succeeding.
- By 15:34:00, all Pods were truly ready, service recovered.

### Root cause — one sentence

> The readiness probe checked whether the HTTP server was listening, not whether the application was truly ready to serve traffic — so during rolling updates, Kubernetes marked new Pods "Ready" while they were still initializing, took down the old Pods that were actually working, and briefly served 100% errors until the new Pods finished warming up.

### Fix

**Immediate mitigation:** rolled back with `kubectl rollout undo deployment/api`. Old Pods (which had already been through their startup and were genuinely working) came back. Service restored in ~60 seconds.

**Real fix — a real readiness probe:**

```python
@app.get("/health")
def health():
    return {"status": "ok"}, 200         # liveness — is the process alive?

@app.get("/ready")
def ready():
    checks = {
        "database": db.ping(),
        "redis": redis.ping(),
        "model_loaded": model_is_loaded(),
    }
    if all(checks.values()):
        return {"ready": True, "checks": checks}, 200
    else:
        return {"ready": False, "checks": checks}, 503
```

**In plain words:** two endpoints now.
- `/health` — used as the **liveness probe** (kill the container if it's totally hung, unresponsive process).
- `/ready` — used as the **readiness probe** (only route traffic when DB, Redis, and model are all up).

Then updated the Deployment:

```yaml
readinessProbe:
  httpGet: { path: /ready, port: 8080 }
  initialDelaySeconds: 10
  periodSeconds: 5
  failureThreshold: 3

livenessProbe:
  httpGet: { path: /health, port: 8080 }
  initialDelaySeconds: 30
  periodSeconds: 10
  failureThreshold: 3
```

**In plain words:** separated the two probes, gave readiness a real check, set `initialDelaySeconds` to 10 (don't even *ask* /ready for 10s — app hasn't started yet), and `failureThreshold: 3` (wait for 3 consecutive failures before marking not-ready) to tolerate flaky checks.

### Prevention

**1. Canary deploys.**

Configured Argo Rollouts to roll out changes to 10% of Pods first, hold for 5 minutes, then progress if error rate stays clean. **In plain words:** if a bad Pod slips through, only 10% of traffic is affected, and the rollout auto-halts.

**2. Readiness probe review in code review.**

Added a checklist item to our PR template: "If this PR changes health check code, does the readiness probe check *real* dependencies?" Kept us honest.

**3. Synthetic monitoring.**

Added an external synthetic check that hits the API from outside every 30 seconds. During any future rollout, if the synthetic check fails, PagerDuty fires immediately — we don't wait for user reports.

### The interview version

> A routine deploy caused a 90-second full outage — 100% 502 errors during a rolling update. Traced it to the readiness probe: /health returned 200 the moment the HTTP server was up, but the app took another 30 seconds to finish loading config, connecting to the DB, and warming the cache. Kubernetes marked the new Pods "Ready" while they were still initializing, took down the old Pods that were actually working, and briefly served errors until the new Pods finished warming up.
>
> Immediate mitigation: rolled back. Real fix: split the probes — /health for liveness (is the process alive), /ready for readiness (are DB, Redis, and model actually available). Set initialDelaySeconds high enough that we don't ask too early.
>
> The learnings: added canary deploys via Argo Rollouts so bad Pods only affect a small percentage first, PR template item to review readiness probes, and external synthetic monitoring so we catch this class of thing from the user's perspective, not just internal metrics.

---

## How to actually use these stories

### Make them yours

Interviewers can spot a memorized script. Pick the incident closest to something you've dealt with — even if the details are different, the structure holds. Change:
- The service name (`checkout` → your actual service).
- The stack (Python + gp2 → whatever you use).
- The specific numbers (18-minute cycle → whatever the sawtooth looked like on your Grafana).

If you haven't personally been the one running the commands, that's fine — but be honest about your role. "I was on-call as the secondary and ran the diagnosis with the primary" is better than pretending you were solo.

### Handle the follow-up questions

Interviewers will probe. Common follow-ups and how to handle them:

**"What if the rollback hadn't fixed it?"**

> Then rollback isn't a mitigation for this incident — meaning the root cause is elsewhere, not in the new code. I'd have widened the search: check if any config change hit at the same time, check whether the underlying node had failed, check if a downstream dependency (DB, Redis) had degraded. Rollback failing to help is a signal, not a dead end.

**"How did you decide to roll back before diagnosing?"**

> Two-track thinking. Mitigation and diagnosis happen in parallel, not in series. Someone rolls back to stop bleeding; someone else pulls logs and metrics for the root cause. If it's just me on-call, rollback first, diagnose after — I can always debug the container image afterward without users bleeding.

**"How did you rule out a traffic spike?"**

> Compared the memory graph to the request-rate graph over the same window. If memory correlated with requests, it's traffic-driven. In this case, memory kept climbing during low-traffic windows, so it was decoupled from load — that's a leak signature.

**"Why did you bump the memory limit at all if the root fix eliminated the leak?"**

> The leak was fixed, but the steady-state usage of the new cache was still real memory — about 380Mb versus 200Mb baseline. Setting the limit to 768Mi gave headroom for growth without immediately hitting the ceiling if the feature scales. Rightsizing is a separate skill from leak-fixing.

**"What was the total downtime?"**

Give a number, even if approximate. "Users saw elevated 502s from 12:14 to 12:16 UTC — about 2 minutes of significant impact — with a tail of a few percent errors until 12:22." Interviewers value precision.

### What NOT to do

- **Don't over-technicalize.** Interviewers include managers, generalists, and cross-functional engineers. If your story requires knowing what `container_memory_working_set_bytes` is, use plain language: "I looked at memory usage over time."

- **Don't pretend everything went smoothly.** Real incidents have false starts. "We first thought it was a traffic spike, but the memory graph didn't correlate" is more credible than "I immediately knew it was a leak."

- **Don't skip prevention.** Interviewers listen for it. Someone who thinks "incident is over when service is restored" is a firefighter; someone who thinks "incident is over when it can't happen again" is a builder.

- **Don't blame people.** "The developer who shipped the bad code" → "the feature was shipped without a load test." Blameless framing is universal in mature engineering culture.

- **Don't invent numbers.** If you don't remember a specific latency, say "roughly 20 seconds" or "on the order of." Making up "27.3 seconds" reads fake.

---

## Quick reference — the framework

```
Symptom              →  What you observed. Specific, concrete.
                        "kubectl get pods showed sudden restart cycles"
                        NOT "there was a problem."

Diagnosis path       →  Ordered list of steps. Each step:
                          - what you ran
                          - what it told you
                          - why the next step made sense

Root cause           →  ONE sentence that explains everything.
                        Avoid multiple root causes — pick the one
                        that, if removed, would have prevented all
                        the symptoms.

Fix (immediate)      →  Stop the bleeding. Rollback / restart / scale.
                        Fast. Reversible. Preserves user experience.

Fix (real)           →  Address root cause. Code change, config
                        change, infrastructure change. Tested.

Prevention           →  Systemic changes. Alerts on the right signal,
                        CI checks, runbook additions, PDB / canary /
                        health-check improvements. Answers the
                        question: "how does this class of thing not
                        happen again?"
```

Practice each of the three incidents until you can say the interview-version in 60-90 seconds without hesitating. Then pick your favorite and make it yours.
