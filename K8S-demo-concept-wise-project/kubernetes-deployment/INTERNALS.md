# Deployments — Internals

The controller chain: how `Deployment → ReplicaSet → Pod` works under the hood, and how rolling updates actually happen.

---

## Purpose of a Deployment

The Deployment is a **declarative wrapper around ReplicaSets** that adds versioning, rolling updates, and rollback. You describe the desired state (image, replica count, resource limits); Kubernetes' reconcile loops make the cluster match, replace Pods safely on updates, and preserve history for rollback.

It exists because raw ReplicaSets have no notion of "update" — they just enforce replica count for one specific Pod template. Rolling from one image version to another required manually creating a new ReplicaSet, scaling it up, scaling the old one down, deleting the old one. Deployment automated that.

## The three-layer controller chain

```
Deployment (versioned spec)
    │
    │ creates one ReplicaSet per Pod template version
    ▼
ReplicaSet (replica count enforcement for ONE Pod template)
    │
    │ creates Pods to match its desired count
    ▼
Pods (running units)
```

**Deployment controller** (in kube-controller-manager) watches Deployments. On any change:
- If the Pod template differs from the current ReplicaSet's template → create a new ReplicaSet.
- Scale the new RS up, old RS down, respecting `maxSurge` and `maxUnavailable`.
- When a new RS reaches full replicas AND all replicas are healthy → the rollout is `Progressing → Complete`.

**ReplicaSet controller** watches ReplicaSets. Its only job: ensure the RS's `spec.replicas` Pods exist with matching labels. If a Pod is missing, create one. If there's one extra, delete one. Simple loop.

Both loops are event-driven — they wake on API changes and reconcile.

## The `pod-template-hash` label

Every RS created by a Deployment gets a label:

```yaml
labels:
  app: backend
  pod-template-hash: 6d585cbbdd     # <-- hash of the Pod template
```

And it's added to Pods via the RS's selector. This is how Kubernetes distinguishes "Pods from RS v1" vs "Pods from RS v2" — even though both have `app: backend`, the pod-template-hash differs.

The hash is deterministic — same template → same hash. So if you roll from v1 to v2 back to v1, K8s recognizes it as the same RS and re-scales it (rather than creating a third RS).

## How rolling update actually works

Starting state: Deployment `backend`, replicas=3, image=v1. Current RS: `backend-rs-v1` with 3 Pods.

You do `kubectl set image deployment/backend backend=my/image:v2`.

**Reconcile tick 1**:
- Deployment controller sees the Pod template changed (image differs).
- Creates a new RS: `backend-rs-v2` with `replicas: 0`.

**Reconcile tick 2** — governed by `maxSurge: 25%, maxUnavailable: 25%` (defaults for 3 replicas ≈ 1 extra Pod and 1 unavailable allowed):
- Scale `backend-rs-v2` up by 1 → creates 1 Pod on v2.
- Since v1 still has 3 Pods running and we're allowed one extra, total = 4.

**Reconcile tick 3** — the new v2 Pod becomes Ready (readiness probe passes):
- Deployment controller sees "v2 has 1 available".
- Scale `backend-rs-v1` down by 1 → deletes a v1 Pod.
- Scale `backend-rs-v2` up by 1 → creates another v2 Pod.

**Continue** until `backend-rs-v2` = 3 replicas Ready, `backend-rs-v1` = 0.

The invariants (with `maxSurge: 25%, maxUnavailable: 25%`, 3 replicas):
- Total Pods (across both RSes) never exceeds 4.
- Available Pods (Ready + not-yet-old-terminated) never drops below 2.

## `maxSurge` and `maxUnavailable` — the safety dials

- `maxSurge` — max Pods *above* `spec.replicas` allowed during rollout. Absolute number (`1`) or percentage (`25%`).
- `maxUnavailable` — max Pods *below* `spec.replicas` allowed during rollout.

Common combinations:

| Combo | Behavior | When to use |
|---|---|---|
| `maxSurge: 1, maxUnavailable: 0` | Never fewer than desired; briefly one extra. Zero-downtime, uses more resources. | Latency-sensitive prod. |
| `maxSurge: 0, maxUnavailable: 1` | Same total replicas; briefly one down. Uses same resources but drops capacity. | Resource-constrained clusters. |
| `maxSurge: 100%, maxUnavailable: 0` | Blue-green style — double capacity, then cut over. | Fast rollout, expensive. |
| `Recreate` strategy (not RollingUpdate) | Kill all old, then create new. | When two versions can't coexist (schema locks, port conflicts). |

## `progressDeadlineSeconds` and rollout failure

Default 600 seconds. If the Deployment doesn't make progress (new Pods aren't becoming Ready) for that long, the Deployment's condition flips to `Progressing: False, Reason: ProgressDeadlineExceeded`.

That's not the same as an automatic rollback. K8s does NOT automatically roll back on failure. It stops trying and reports failure — a human (or CI) must call `kubectl rollout undo`.

Argo Rollouts, Flagger, and similar tools add automatic rollback based on metrics (error rate spike, latency regression). Vanilla Deployments don't.

## `minReadySeconds`

Time a new Pod must be Ready before it counts as "available." Default 0.

Set to say 10 seconds: after readiness probe passes, wait 10s before considering the Pod done. Guards against apps that pass readiness but crash immediately after — the 10s pause catches that.

## Revision history + rollback

Every time the Pod template changes, the Deployment controller creates a new RS but doesn't delete the old one — it just scales it to 0. Up to `revisionHistoryLimit` (default 10) of these are kept.

```bash
kubectl rollout history deployment/backend
# REVISION  CHANGE-CAUSE
# 1         initial deploy
# 2         image bump to v2
# 3         image bump to v3
```

Under the hood: each RS gets an annotation `deployment.kubernetes.io/revision: N`. `kubectl rollout undo` scales the previous RS up and the current one down — same rolling-update mechanics, just running "backwards."

## The `--record` flag

```bash
kubectl set image deployment/backend backend=my/image:v2 --record
```

Records the command that triggered the change in the RS's annotations. Shows in `kubectl rollout history` as CHANGE-CAUSE. Deprecated in newer kubectl versions (K8s 1.26+); replaced by kubectl's `--field-manager` and metadata tracking.

## Pod template annotations vs Deployment annotations

Two different scopes:

```yaml
metadata:
  annotations:
    my-annotation: this-goes-on-the-deployment-object   # not on Pods
spec:
  template:
    metadata:
      annotations:
        my-annotation: this-goes-on-every-Pod            # rolls with template changes
```

**Key implication**: to force a rolling restart when a ConfigMap changes, annotate the Pod template (not the Deployment metadata) with a hash of the ConfigMap:

```yaml
spec:
  template:
    metadata:
      annotations:
        checksum/config: <sha256 of the ConfigMap>
```

When the checksum changes → Pod template changes → new RS created → rolling restart.

## Scaling — imperatively vs declaratively

```bash
kubectl scale deployment/backend --replicas=5
```

This updates `spec.replicas` on the Deployment. No new RS is created — the current RS is scaled up. Existing Pods are undisturbed.

If HPA is managing replicas, imperatively setting `--replicas` fights HPA — HPA will scale back to its target within seconds. Best practice: remove `replicas:` from the Deployment YAML when HPA is in the loop, or use Argo CD's `ignoreDifferences` on `/spec/replicas`.

## Common pitfalls under the hood

**Selector mismatch after template edit**: `spec.selector.matchLabels` is immutable. Change it, apply fails. To "change" a selector, delete + recreate the Deployment.

**Pods orphaned from a bad rollout**: if you delete a Deployment with `--cascade=orphan`, its RS and Pods remain but are unmanaged. Someone else could accidentally pick them up if labels overlap. Cleanup: `kubectl delete rs -l pod-template-hash=<hash>` manually.

**"My rollout succeeded but the app is broken"**: Deployment considers a Pod Ready based on the readiness probe. A shallow probe (returns 200 immediately) can pass while the app is actually broken. Set probes to test real functionality (DB connection, cache loaded).

**A stuck rollout** with the new RS at partial replicas: usually one Pod failed to become Ready and the rollout paused per `maxUnavailable`. `kubectl describe deployment` shows the last condition; `kubectl get pods -l pod-template-hash=<new-hash>` shows the failing Pod.

---

## The 30-second summary

- Deployment → ReplicaSet → Pod. Deployment manages RS revisions; each RS enforces a specific Pod template's replica count.
- Rolling updates work by creating a new RS, scaling it up, scaling the old one down, governed by `maxSurge` and `maxUnavailable`.
- The `pod-template-hash` label distinguishes Pods across RS versions.
- Rollout failure sets a condition but doesn't auto-rollback — that's your job (or Argo Rollouts, Flagger).
- Old RSes are preserved (scaled to 0) up to `revisionHistoryLimit` — that's what enables `kubectl rollout undo`.
- To force a rolling restart on ConfigMap changes, annotate the **Pod template** with a checksum.
