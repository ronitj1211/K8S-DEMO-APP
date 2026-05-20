# Interview Questions — Deployments

---

## Basic

### Q1. What is a Deployment?
A Deployment is a controller for **stateless** workloads. You declare the desired state (Pod template, replica count, update strategy) and Kubernetes makes the cluster match. It manages a ReplicaSet, which in turn manages Pods.

### Q2. What's the relationship between Deployment, ReplicaSet, and Pod?
```
Deployment ──manages──> ReplicaSet ──manages──> Pods
```
- **Deployment** holds the template, history, rollout policy.
- **ReplicaSet** ensures *N* Pods of a specific Pod template are running. One per Deployment revision.
- **Pod** is the running unit.

You operate on the Deployment; the ReplicaSet is bookkeeping.

### Q3. What rolling-update strategies does Deployment support?
- **`RollingUpdate`** (default) — gradually replace old Pods with new ones, governed by `maxSurge` and `maxUnavailable`.
- **`Recreate`** — kill all old Pods, then create new ones. Brief downtime. Use when two versions can't coexist (e.g., schema lock, port conflict).

### Q4. What do `maxSurge` and `maxUnavailable` mean?
- `maxSurge` — how many **extra** Pods (above `replicas`) can exist during the rollout.
- `maxUnavailable` — how many Pods can be **unavailable** during the rollout.

Common combos:
- `maxSurge: 1, maxUnavailable: 0` — zero-downtime, slightly higher load during rollout.
- `maxSurge: 0, maxUnavailable: 1` — same replica count, briefly lower availability. Useful when resource-constrained.

### Q5. How do you do a rolling update?
Three equivalent ways:
1. Edit YAML and `kubectl apply -f`.
2. `kubectl set image deployment/foo container=image:new-tag`.
3. `kubectl edit deployment/foo`.

Then `kubectl rollout status deployment/foo` to watch progress.

### Q6. How do you roll back?
```bash
kubectl rollout history deployment/foo
kubectl rollout undo deployment/foo                   # back to previous revision
kubectl rollout undo deployment/foo --to-revision=3   # specific revision
```

### Q7. How does scaling work?
```bash
kubectl scale deployment/foo --replicas=5
```
The Deployment updates the ReplicaSet's replica count; the ReplicaSet creates or deletes Pods to match.

### Q8. What's the difference between Deployment and ReplicaSet?
Deployments add **rolling updates and revision history** on top of ReplicaSets. You can use a ReplicaSet directly, but you lose `kubectl rollout undo` and history. Always use Deployment for normal stateless apps.

---

## Intermediate

### Q9. What is `revisionHistoryLimit` and why does it matter?
It caps how many old ReplicaSets the Deployment keeps for rollback (default 10). Set lower (e.g., 3) in environments that deploy often to avoid bloating etcd. Set to 0 and you lose rollback capability.

### Q10. What's `progressDeadlineSeconds`?
How long to wait for a rollout to make progress before marking it `Failed`. Default 600s (10 min). If your app has a long startup probe delay, bump this so the rollout doesn't false-fail.

### Q11. Readiness probe and rollout — why are they coupled?
During a `RollingUpdate`, the Deployment only considers a new Pod **available** once its readiness probe passes for `minReadySeconds`. Without a readiness probe, the old Pod can be killed before the new one is actually serving — brief 5xx burst. Always set a readiness probe for production Deployments.

### Q12. What's the difference between `selector` and `template.metadata.labels`?
The Deployment's `spec.selector.matchLabels` is **immutable** after create. It chooses which Pods this Deployment owns. The `template.metadata.labels` is what new Pods get stamped with. They must match — if they don't, the API rejects the manifest.

### Q13. Why is `selector` immutable?
Changing the selector mid-flight would orphan the existing Pods (they no longer match) or steal Pods that match a new selector. The API blocks this to prevent confusion. To "change" it, delete + recreate the Deployment (or use `--cascade=orphan` to preserve the old Pods, then re-adopt).

### Q14. What happens if you delete a Deployment?
By default, the ReplicaSet and its Pods are deleted (cascade). `kubectl delete deployment/foo --cascade=orphan` deletes only the Deployment object; the ReplicaSet + Pods keep running but are now unmanaged. Useful as a careful pre-cleanup step.

### Q15. Deployment vs. StatefulSet vs. DaemonSet — when to use which?
- **Deployment** — stateless apps. Pods are interchangeable; no ordering, no per-Pod identity.
- **StatefulSet** — apps that need stable identity (databases, queues): stable Pod names + their own PVC.
- **DaemonSet** — one Pod per node (log agents, CNI plugins).

### Q16. Can you mix RollingUpdate with Pod Disruption Budgets?
Yes, and you usually should. A PDB protects against **voluntary** disruptions (drains, evictions). RollingUpdate itself is bounded by `maxUnavailable`. The two work together — e.g., a 3-replica Deployment with `maxUnavailable: 1` and PDB `minAvailable: 2` enforces "never fewer than 2 healthy Pods" across both rollout and node drains.

---

## Scenario-based

### S1. The rollout is stuck — `kubectl rollout status` hangs. What now?
Inspect:
```bash
kubectl describe deployment/foo                # check ProgressDeadlineExceeded conditions
kubectl get pods -l app=foo                    # are new Pods failing?
kubectl describe pod <new-pod>                 # events, probe failures, ImagePullBackOff
kubectl logs <new-pod>                         # app errors
```

Common culprits:
- Image tag doesn't exist → `ImagePullBackOff`.
- Readiness probe failing → check the URL/port matches your app.
- Resource requests too large → `Pending`.
- App config broken → look at logs.

Recover with `kubectl rollout undo deployment/foo`.

### S2. You deployed a bad image and traffic is being served by it. What do you do?
**Roll back immediately:** `kubectl rollout undo deployment/foo`. The previous ReplicaSet still exists; this scales it up and the bad one down — usually faster than rebuilding the good image.

After service is restored, investigate root cause: how did the bad image pass CI? What probes / canary deploys / image-scanning could have caught it?

### S3. You want a canary release — 90% old, 10% new. How?
Plain Deployment doesn't do percentage canaries cleanly. Options:
1. **Two Deployments** with same label `app=foo`, different versions, e.g., 9 replicas of v1 + 1 replica of v2, fronted by one Service. Crude but works.
2. **Service mesh** (Istio, Linkerd) with traffic-split rules — proper L7 splitting.
3. **Argo Rollouts** — purpose-built CRD that wraps Deployment with canary/blue-green strategies.
4. **Two Services + Ingress weights** (ingress-nginx supports `canary-weight` annotations).

### S4. Two Deployments accidentally have selectors that overlap. What happens?
Both ReplicaSets claim the same Pods. The Pods bounce between owners as each controller tries to reach its replica count — usually you see endlessly creating/deleting Pods. Fix: ensure unique selectors. The label `app.kubernetes.io/instance: <release-name>` (Helm convention) exists precisely to make selectors unique per release.

### S5. The app needs ~2 minutes to warm up (load cache from S3). How do you keep the rollout safe?
Three controls:
- **Readiness probe** with `initialDelaySeconds: 120` (or, better, a `startupProbe` that gates everything until the app is up).
- **`minReadySeconds`** on the Deployment — extra grace after probe pass before the Pod counts as available.
- **`progressDeadlineSeconds`** raised above 600s so the rollout doesn't false-fail.
- **`maxSurge: 1, maxUnavailable: 0`** so the old Pod stays serving while the new one warms.

### S6. You delete a Pod managed by a Deployment. What happens to it?
The Deployment's ReplicaSet detects the count is below desired and creates a new Pod (different name). The deleted Pod is *not* the same Pod — a new one comes up, new IP, new UID. That's why your code should never assume Pod IPs are stable.
