# Deployments — Deep Dive for Interviews

The narrative version: what a Deployment really *is*, why it exists on top of Pods and ReplicaSets, and how to talk about it confidently.

---

## The origin story

Once Pods existed, a real problem showed up immediately: what happens when a Pod dies? Nothing. It's gone. So the first solution was **ReplicationController** — a controller that watched Pod counts and recreated them. Fine, but every time you rolled out a new version, you had to manually manage the transition — spin up new Pods, wait for them to be ready, kill the old ones. Error-prone.

The next generation was **ReplicaSet** — same job as ReplicationController but with expressive label selectors. Still no rolling updates.

Deployments landed as the third layer: a controller that *manages ReplicaSets* to give you **declarative rolling updates and rollback history**. That's the key insight — Deployments don't manage Pods directly. They manage ReplicaSets, and each rollout creates a new ReplicaSet. The old ReplicaSet stays around (scaled to 0) so `kubectl rollout undo` can bring it back instantly.

That layered design is why the machinery works: the Deployment is the intent, the ReplicaSet is the mechanism, the Pod is the running unit.

## The mental model

A Deployment is a **versioned declaration of desired state for a stateless workload**. You say "I want 5 Pods running image `myapp:v2` with these env vars." Kubernetes' job is to make that true. If someone deletes a Pod, another appears. If you push a new template, Pods roll to it gradually. If it goes wrong, roll back.

The word "stateless" is doing a lot of work. Deployments assume Pods are interchangeable — no one Pod owns any particular data, no one Pod has a special name that matters. That's why the Pods have random-suffix names like `backend-6d585cbbdd-6tt8v`. For anything where Pod identity matters (databases, queues), you use StatefulSet, not Deployment.

## How it actually works

Under the hood:

**Creation:** You apply a Deployment. The Deployment controller creates a ReplicaSet with the same Pod template + labels. The ReplicaSet controller creates Pods to match the replica count.

**Update:** You change the Pod template — say, a new image tag. The Deployment controller detects the change, creates a **new** ReplicaSet with the new template, and gradually scales up the new one while scaling down the old one, governed by `maxSurge` (how many extra Pods can exist above desired) and `maxUnavailable` (how many Pods can be unavailable at once). Both default to 25%.

**Rollback:** Each ReplicaSet is preserved even after scaling to zero, up to `revisionHistoryLimit` (default 10). `kubectl rollout undo` picks the previous ReplicaSet and scales it back up while scaling the current one down.

**Health gating:** During a rollout, the Deployment considers a new Pod "available" only after it's been Ready for `minReadySeconds`. Without a proper readiness probe, this defaults to "the container started" — which is much weaker than "the app is actually serving." Rolling deploys with bad readiness probes are how you get 5xx spikes.

**Progress deadline:** `progressDeadlineSeconds` (default 600) sets how long a rollout can go without progress before it's marked as Failed. If your app has a legit 3-minute warmup, bump this.

The subtle mechanics: the Deployment updates the ReplicaSet's `replicas` field; the ReplicaSet controller reconciles by creating/deleting Pods; a Pod comes up; readiness probes pass; the endpoints controller adds the Pod IP to any matching Service's endpoints; kube-proxy reprograms iptables/IPVS; new Pod is now taking traffic. All of that happens per Pod, not once for the whole rollout.

## When to use it (and when not to)

**Perfect fit:**
- Stateless HTTP APIs, workers, background processors.
- Anything where "just spin up more copies" is a valid answer to "we need more."
- Apps that gracefully handle SIGTERM and don't need to persist local state.

**Wrong tool:**
- **Databases** — you want stable Pod identity and per-Pod storage. Use StatefulSet.
- **Per-node agents** (log collectors, monitoring daemons) — use DaemonSet.
- **Run-to-completion tasks** (migrations, batch jobs) — use Job or CronJob.
- **Truly leader-elected workloads** — StatefulSet, or an operator that manages elections.

**Gray area:**
- Redis single-node cache — a Deployment is fine (cache is disposable). Redis cluster — StatefulSet.
- Kafka consumer without state — Deployment. Kafka broker itself — StatefulSet.

## Common misunderstandings

**"Deployments are what run my code."** No — Pods do. Deployments are the *management layer* above ReplicaSets, which are the layer above Pods.

**"Rolling update means no downtime."** Only if your readiness probe is real and your `maxUnavailable` is set right. A Deployment with `maxUnavailable: 25%` and a lying readiness probe (returns 200 before the app is ready) will happily give you a 25% error rate for a few seconds during every rollout.

**"You can change a Deployment's selector."** You cannot — `spec.selector` is immutable after creation. Changing it would orphan the existing Pods (they no longer match) or steal Pods from another controller. The API rejects it.

**"Deployment replicas and HPA replicas are the same."** They're related but competing. When an HPA manages a Deployment, the HPA overwrites the Deployment's `replicas`. If someone edits the Deployment manifest and re-applies with `replicas: 3` while HPA thinks it should be 10, the HPA wins on the next reconcile. Best practice: with HPA in the loop, don't set `replicas` explicitly in the Deployment YAML (or add it to `spec.ignoreDifferences` in ArgoCD).

**"Delete Deployment = delete Pods."** With cascade delete (the default), yes. With `--cascade=orphan`, only the Deployment object is deleted — the ReplicaSet and its Pods keep running, now unmanaged. Sometimes useful when swapping controllers.

## The war stories

**"A rollout stopped in the middle and didn't fail loud."** `progressDeadlineSeconds` was too high or infinite. The Deployment sat with 2 of 3 Pods on the new revision, 1 on the old, forever. Fix: set a real deadline. Also check `kubectl rollout status` in CI — its exit code is non-zero on timeout.

**"We had 3 replicas, rolled out a new image, and traffic dropped for 40 seconds."** Two failures at once: no readiness probe, and the old Pods got SIGTERM before the app finished graceful shutdown. Fix readiness probe to actually check the app's serve path. Add a `preStop` sleep or a proper SIGTERM handler in the app.

**"We accidentally rolled out to production instead of staging."** The Deployment manifest had a hardcoded namespace, and someone `kubectl apply -f`'d it against the wrong cluster. Fix in the industry: GitOps (ArgoCD/Flux). The cluster only sees changes when Git changes; the deployer never has cluster credentials.

**"The Deployment says 3/3 ready but users are getting errors."** Readiness probe returns 200 on `/health` because you wired that to nothing. But `/api` fails because a downstream DB is unreachable. Readiness doesn't mean *working* — it means the app told K8s "yes, I'm ready." Design your readiness to check the things that matter (DB reachable, cache warmed, config loaded).

**"HPA and Deployment fight."** HPA scales to 10 Pods; someone re-applies the Deployment manifest with `replicas: 3`; HPA scales back to 10 on the next tick. Users see churn. Fix: remove `replicas` from the manifest when HPA is in the loop, or use ArgoCD's `ignoreDifferences` on `/spec/replicas`.

## What to actually say in an interview

If asked "what's a Deployment?":

> A Deployment is a Kubernetes controller for stateless workloads. It gives you three big things you don't get from raw Pods: self-healing — if a Pod dies, a new one comes up; declarative rolling updates — change the image tag, apply, and Kubernetes replaces Pods gradually; and rollback history — each revision creates a new ReplicaSet, and `kubectl rollout undo` flips back instantly. Under the hood, a Deployment manages ReplicaSets, and ReplicaSets manage Pods. That layered design is what makes rollbacks fast — the previous ReplicaSet is still there, just scaled to zero.

If asked about rolling updates:

> The controls are `maxSurge` and `maxUnavailable`. Both default to 25%. `maxSurge: 1, maxUnavailable: 0` gives you the safest rollout — never fewer than desired replicas, at most one extra during the transition. The critical dependency is the readiness probe. Without it, the Deployment thinks Pods are healthy the moment they start, which lets old Pods get killed before new ones actually serve. A rolling update with a bad readiness probe is worse than a Recreate — you get errors gradually instead of a clean cutover.

If asked "when would you not use a Deployment?":

> Anything with state — databases, queues, distributed systems that care about Pod identity. Those use StatefulSet, which gives stable Pod names, ordered start/stop, and one PVC per Pod. Also per-node workloads like log agents, which use DaemonSet. And batch jobs, which use Job. Deployment is specifically the "run N interchangeable copies of a stateless workload" primitive.

Say the words: **declarative**, **rolling update**, **readiness gates**, **ReplicaSet history**, **stateless**. That's Deployment.
