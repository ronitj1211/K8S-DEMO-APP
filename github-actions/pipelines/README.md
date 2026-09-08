# Production pipeline — Spring Boot → EKS

[`spring-boot-eks-prod.yml`](spring-boot-eks-prod.yml) — a full production
pipeline with a human approval gate.

**Validated with `actionlint` (0 issues) and parsed as YAML.** It is *not*
installed in `.github/workflows/` in this repo, so nothing runs here — copy it
in once the setup below is done.

---

## The flow

```
 PR opened / synchronised
        │
        ▼
 ┌──────────────┐
 │  1. setup    │  compute image tag (sha-abc12345), version, gates
 └──────┬───────┘
        ├────────────────────────┐
        ▼                        ▼
 ┌──────────────┐        ┌────────────────────────────────────┐
 │  2. test     │        │  3. security  (matrix, parallel)   │
 │              │        │   • dependencies  OWASP CVE scan   │
 │ unit +       │        │   • sast          CodeQL           │
 │ integration  │        │   • secrets       gitleaks         │
 │ vs real      │        │   • iac           Trivy config     │
 │ Postgres     │        └────────────────┬───────────────────┘
 │ + Redis      │                         │
 └──────┬───────┘                         │
        └────────────┬────────────────────┘
                     ▼
            ┌──────────────────┐
            │  4. build-push   │  package → docker build → TRIVY SCAN
            │                  │  → push to ECR   (OIDC, no AWS keys)
            └────────┬─────────┘  image is scanned BEFORE it is pushed
                     ▼
            ┌──────────────────┐
            │ 5. request-      │  job summary + PR comment + Slack
            │    approval      │  everything the approver needs
            └────────┬─────────┘
                     ▼
        ╔════════════════════════════════╗
        ║   ⏸  HUMAN APPROVAL GATE       ║   environment: production
        ║   run PAUSES here              ║   required reviewers notified
        ╚════════════════┬═══════════════╝
                         ▼  approved
            ┌──────────────────────┐
            │  6. deploy-          │  record current image (for rollback)
            │     production       │  kubectl set image → rollout status
            └────────┬─────────────┘  concurrency: NO cancel-in-progress
                     ▼
            ┌──────────────────┐
            │  7. smoke-test   │  curl /actuator/health from in-cluster
            │                  │  verify readyReplicas == desired
            └────────┬─────────┘
                     │ failed?
                     ▼
            ┌──────────────────┐
            │  8. rollback     │  kubectl rollout undo (automatic)
            └────────┬─────────┘
                     ▼
            ┌──────────────────┐
            │  9. report       │  if: always() — one authoritative summary
            └──────────────────┘
```

---

## How the approval gate actually works

**There is no "wait for approval" keyword.** The gate is this:

```yaml
deploy-production:
  environment:
    name: production
```

When the run reaches a job with an environment that has **required
reviewers**, GitHub pauses it and notifies them. They see "Review pending" in
the Actions tab, review the summary posted by job 5, and click **Approve** —
then the job proceeds.

Configure it once: **Settings → Environments → New environment → `production`**

| Setting | Value | Why |
|---|---|---|
| Required reviewers | your approvers (up to 6) | This *is* the gate |
| Wait timer | 0 | Optional cool-off |
| Deployment branches | `main` + `Allow protected branches` | Stops arbitrary branches deploying |
| Environment secrets | `AWS_DEPLOY_ROLE_ARN` | Prod credentials unreachable from other jobs |

> Putting `AWS_DEPLOY_ROLE_ARN` in the **environment** rather than the repo is
> the important part — it means no unapproved job can even see it.

---

## AWS setup

### 1. Register GitHub as an OIDC provider (once per account)

```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1
```

### 2. Two roles, deliberately

| Role | Used by | Permissions |
|---|---|---|
| `gha-build-role` | `build-push` | ECR push only |
| `gha-deploy-role` | `deploy-production`, `smoke-test`, `rollback` | `eks:DescribeCluster` + the RBAC below |

Splitting them means a compromised build job cannot deploy.

### 3. Trust policies — the security boundary

**Build role** — any branch may build:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
      "StringLike":   { "token.actions.githubusercontent.com:sub": "repo:MY_ORG/MY_REPO:*" }
    }
  }]
}
```

**Deploy role** — only an *approved* job in the `production` environment:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        "token.actions.githubusercontent.com:sub": "repo:MY_ORG/MY_REPO:environment:production"
      }
    }
  }]
}
```

> **This is the single most important block on the page.** `StringEquals` on
> `environment:production` means the token is only mintable by a job that
> passed the approval gate. Using `StringLike` with `repo:MY_ORG/MY_REPO:*`
> here would let **any branch, including an outsider's PR branch**, assume your
> production deploy role — defeating the entire gate.

### 4. Let the deploy role talk to Kubernetes

IAM gets you to the API server; **RBAC** decides what you may do there.

```bash
eksctl create iamidentitymapping \
  --cluster prod-eks-cluster \
  --region ap-south-1 \
  --arn arn:aws:iam::123456789012:role/gha-deploy-role \
  --group github-deployers \
  --username github-actions
```

```yaml
# least-privilege RBAC — enough to roll a deployment, nothing more
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: deployer
  namespace: production
rules:
  - apiGroups: ["apps"]
    resources: ["deployments", "deployments/scale"]
    verbs: ["get", "list", "patch", "update"]
  - apiGroups: ["apps"]
    resources: ["replicasets"]
    verbs: ["get", "list"]
  - apiGroups: [""]
    resources: ["pods", "pods/log"]
    verbs: ["get", "list", "create", "delete"]   # create/delete for the smoke-test pod
  - apiGroups: [""]
    resources: ["services"]
    verbs: ["get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: deployer
  namespace: production
subjects:
  - kind: Group
    name: github-deployers
    apiGroup: rbac.authorization.k8s.io
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: deployer
```

Note there is no `secrets` access and no `create deployments` — deliberately.

### 5. ECR repository

```bash
aws ecr create-repository \
  --repository-name spring-boot-app \
  --region ap-south-1 \
  --image-scanning-configuration scanOnPush=true \
  --image-tag-mutability IMMUTABLE
```

`IMMUTABLE` means a tag can never be repointed — so `sha-abc12345` always
refers to exactly one image. That's what makes the deploy auditable.

---

## GitHub configuration

**Secrets** (Settings → Secrets and variables → Actions):

| Name | Scope | Value |
|---|---|---|
| `AWS_BUILD_ROLE_ARN` | Repository | `arn:aws:iam::…:role/gha-build-role` |
| `AWS_DEPLOY_ROLE_ARN` | **Environment `production`** | `arn:aws:iam::…:role/gha-deploy-role` |
| `SLACK_WEBHOOK_URL` | Repository | optional |

**Variables:**

| Name | Value |
|---|---|
| `SLACK_WEBHOOK_CONFIGURED` | `true` to enable the Slack step |

Then edit the `env:` block at the top of the workflow for your region, cluster
name, ECR repo, namespace and deployment name.

---

## Concepts demonstrated, and where

| Concept | Where | Note |
|---|---|---|
| **OIDC** | `build-push`, `deploy-production`, `smoke-test`, `rollback` | `permissions: id-token: write` + `configure-aws-credentials`. No stored AWS keys |
| **`if:`** | ~15 places | Branch/event gating, `needs.*.result` checks, `always()`, `!cancelled()` |
| **`concurrency`** | workflow + `deploy-production` | `cancel-in-progress` is an **expression** — true for PRs, false for deploys |
| **`env`** | workflow, job (`test`), step (integration tests) | All three levels, narrowest scope winning |
| **`needs` + outputs** | throughout | Image URI/digest flows build → deploy → rollback |
| **matrix** | `test`, `security` | Java versions; four scanners in parallel |
| **`services`** | `test` | Postgres + Redis **with health checks** |
| **caching** | `setup-java` `cache: maven` | Plus Docker layer cache via `type=gha` |
| **artifacts** | test reports, JAR | `if: always()` on reports |
| **environments** | `deploy-production`, `rollback` | The approval gate |
| **permissions** | workflow `contents: read`, widened per job | Least privilege |
| **job summaries** | test, approval, rollback, report | `$GITHUB_STEP_SUMMARY` |
| **injection safety** | `request-approval` | PR title/author via `env:`, never interpolated into `run:` |
| **`timeout-minutes`** | every job | No job can burn the 6-hour default |

---

## Design decisions worth defending in a review

**Scan the image before pushing it.** `build-push` uses `load: true, push: false`,
runs Trivy with `exit-code: 1`, and only then pushes. A vulnerable image never
reaches the registry.

**`sha-<short>` tags, never `latest`.** With `latest`, "what is running in
prod?" is unanswerable and a node restart can silently pull different code.

**Deploy the exact image that was tested.** `deploy-production` consumes
`needs.build-push.outputs.image_uri` — it never rebuilds. Rebuilding for prod
means shipping an artifact nothing verified.

**`cancel-in-progress` differs by event.** True for PRs (a new commit makes the
old run pointless), false for deploys (cancelling mid-apply leaves a partial
release). The deploy job also has its own `group: deploy-production` so two
deploys queue instead of racing.

**Rollback uses `!cancelled()`, not `always()`.** If a human cancelled the run,
an unattended rollback is the last thing you want.

**`always() && needs.test.result == 'success'`** on `build-push` lets the job
run when `security` was *skipped* (emergency hotfix via
`workflow_dispatch`) while still requiring tests to have genuinely passed.
Plain `needs:` would skip it whenever security was skipped.

---

## Before you enable it

- [ ] Replace `env:` values (region, cluster, ECR repo, namespace, deployment)
- [ ] Create the OIDC provider and both IAM roles
- [ ] Pin the deploy role's trust policy to `environment:production`
- [ ] Map the deploy role into EKS RBAC
- [ ] Create the `production` environment with required reviewers
- [ ] Store `AWS_DEPLOY_ROLE_ARN` as an **environment** secret
- [ ] Add a `Dockerfile` (multi-stage; JRE base, non-root user)
- [ ] Add `spring-boot-starter-actuator` so `/actuator/health` exists
- [ ] Configure the OWASP plugin and `.security/suppressions.xml` in `pom.xml`
- [ ] Confirm the Deployment already exists — `kubectl set image` patches, it
      doesn't create. First deploy needs `kubectl apply`.
- [ ] Add a **branch protection rule** on `main` requiring the `test` and
      `security` checks
- [ ] Pin third-party actions to full SHAs (see [../SECURITY.md](../SECURITY.md))

## Trade-off to be aware of

Because `pull_request` is a trigger, an **approved PR can deploy code that is
not yet merged to `main`**. That is what you asked for — approve, then deploy —
and some teams deliberately work this way so prod is validated before merge.

The more common convention is deploy-on-merge. To switch, add this to
`deploy-production`:

```yaml
if: |
  always() &&
  needs.build-push.result == 'success' &&
  github.event_name != 'pull_request'
```

Or keep PR deploys but require an explicit opt-in label:

```yaml
if: |
  always() &&
  needs.build-push.result == 'success' &&
  (github.event_name != 'pull_request' ||
   contains(github.event.pull_request.labels.*.name, 'deploy:production'))
```
