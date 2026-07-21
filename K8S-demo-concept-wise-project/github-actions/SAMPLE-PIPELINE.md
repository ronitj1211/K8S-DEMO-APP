# Sample Pipeline — Build Your First GitHub Actions Workflow

A hands-on walkthrough. By the end you'll have three workflows running: **CI** (test on every PR), **Build+Push** (Docker image to GHCR on merge), and **Deploy** (to Kubernetes with manual approval). Each builds on the previous.

Uses the demo Node.js backend from [`../kubernetes-pods/backend/`](../kubernetes-pods/backend/) as the example app. Any Node app works.

---

## Prerequisites

- A GitHub repo (this one works). Actions enabled by default on new repos.
- The demo app has a working `package.json` with `test` and `Dockerfile`.
- **Local**: `git`, optional [`act`](https://github.com/nektos/act) for local runs, optional `gh` CLI.

---

## Step 1 — Add the CI workflow

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
          cache-dependency-path: K8S-demo-concept-wise-project/kubernetes-pods/backend/package-lock.json

      - name: Install deps
        working-directory: K8S-demo-concept-wise-project/kubernetes-pods/backend
        run: npm ci

      - name: Run tests
        working-directory: K8S-demo-concept-wise-project/kubernetes-pods/backend
        run: npm test --if-present
```

Commit + push. Open **Actions** tab — you should see the workflow running against your PR / push.

### What each line does
- `on:` — run on PR events and every push to `main`.
- `runs-on: ubuntu-latest` — GitHub's Ubuntu VM.
- `actions/checkout@v4` — clone the repo into the runner.
- `setup-node` with `cache: 'npm'` — install Node 20, cache `~/.npm` keyed by `package-lock.json` hash. First run ~30s, subsequent runs ~5s.
- `npm ci` — install exactly what's in the lockfile (never modifies it, unlike `npm install`).
- `npm test --if-present` — run tests if defined; skip cleanly if not.

### Try breaking it on purpose
Make a bad commit (e.g., syntax error in `server.js`), push, watch the check turn red. Fix it, watch it turn green. That's your feedback loop.

---

## Step 2 — Add Docker build + push to GHCR on merge

Create `.github/workflows/build.yml`:

```yaml
name: Build & Push

on:
  push:
    branches: [main]

permissions:
  contents: read
  packages: write        # required for ghcr.io push

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}/k8s-demo-backend    # lowercase, /-separated

jobs:
  build:
    runs-on: ubuntu-latest
    outputs:
      image: ${{ steps.meta.outputs.tags }}
      digest: ${{ steps.push.outputs.digest }}
    steps:
      - uses: actions/checkout@v4

      - uses: docker/setup-buildx-action@v3

      - uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Compute tags
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
          tags: |
            type=sha,prefix=,format=short   # short commit SHA
            type=ref,event=branch            # main
            type=raw,value=latest,enable={{is_default_branch}}

      - name: Build and push
        id: push
        uses: docker/build-push-action@v5
        with:
          context: K8S-demo-concept-wise-project/kubernetes-pods/backend
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

After merging a PR to `main`:
- Actions run creates a Docker image.
- Image lands in `ghcr.io/<owner>/<repo>/k8s-demo-backend:<short-sha>`.
- Visible at `github.com/<owner>/<repo>/pkgs/container/k8s-demo-backend`.

### Key ideas
- `docker/metadata-action` computes tags declaratively — SHA, branch name, `latest` on default branch.
- `docker/build-push-action` handles multi-arch, caching, and push in one step.
- `cache-from/to: type=gha` uses GitHub Actions' native cache — no extra registry setup.
- `permissions.packages: write` is the token grant that makes push work.

### First run — image is private

GHCR packages default to inheriting the repo's visibility, but you may need to set it explicitly:

1. Repo → **Packages** (right sidebar) → click your package.
2. **Package settings** → **Change visibility** → **Public** (or keep Private + configure who can pull).
3. Under **Manage Actions access**, add this repo if it isn't listed automatically.

Without step 2/3, `docker pull` from another workflow can 403.

---

## Step 3 — Deploy to Kubernetes with manual approval

Create the **Environment** first: repo Settings → **Environments** → **New environment** → name it `production` → add a **Required reviewer** (yourself) → Save.

Add `KUBE_CONFIG_B64` as an **environment secret** (base64-encoded kubeconfig):
```bash
cat ~/.kube/config | base64 | pbcopy      # macOS
# then paste in the Environment secret dialog
```

> Colima/k3s note: the kubeconfig has a `server: https://127.0.0.1:56922` — that's local to your Mac. For real deploys you'd point it at a real cluster (EKS/GKE/AKS). This step demonstrates the pattern; use it against a cluster reachable from the runner.

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy

on:
  workflow_run:
    workflows: [Build & Push]
    types: [completed]
    branches: [main]
  workflow_dispatch:              # allow manual runs
    inputs:
      image:
        description: 'Image tag to deploy (short SHA)'
        required: true

permissions:
  contents: read

jobs:
  deploy:
    if: ${{ github.event_name == 'workflow_dispatch' || github.event.workflow_run.conclusion == 'success' }}
    runs-on: ubuntu-latest
    environment: production        # gates behind reviewer approval
    steps:
      - uses: actions/checkout@v4

      - name: Set kubeconfig
        env:
          KUBE_CONFIG_B64: ${{ secrets.KUBE_CONFIG_B64 }}
        run: |
          mkdir -p ~/.kube
          echo "$KUBE_CONFIG_B64" | base64 -d > ~/.kube/config
          chmod 600 ~/.kube/config

      - name: Compute image tag
        id: img
        run: |
          if [ "${{ github.event_name }}" = "workflow_dispatch" ]; then
            echo "tag=${{ inputs.image }}" >> $GITHUB_OUTPUT
          else
            # workflow_run doesn't give us the SHA directly; use head_sha
            SHORT=$(git rev-parse --short ${{ github.event.workflow_run.head_sha }})
            echo "tag=$SHORT" >> $GITHUB_OUTPUT
          fi

      - name: Deploy
        run: |
          set -euxo pipefail
          IMAGE=ghcr.io/${{ github.repository }}/k8s-demo-backend:${{ steps.img.outputs.tag }}
          kubectl set image deployment/backend backend="$IMAGE" --record
          kubectl rollout status deployment/backend --timeout=180s
          kubectl get pods -l app=backend
```

### Flow
1. PR merged to main → **Build & Push** runs → new image in GHCR.
2. **Deploy** triggers automatically → job pauses at the environment approval gate.
3. You (as reviewer) click **Approve** in the Actions UI.
4. Deploy proceeds — kubeconfig loaded, `kubectl set image` rolls out, `rollout status` verifies.

### Why `workflow_run` and not `push`?
Chaining lets you keep the deploy trigger tied to a **successful** build. Without it, the deploy could race the build.

---

## Step 4 — Verify (post-deploy assertions)

Add these to the end of `deploy.yml`'s deploy job so you never say "green ✓ but nothing actually deployed":

```yaml
      - name: Verify running version
        run: |
          set -euo pipefail
          for i in {1..10}; do
            OUT=$(kubectl exec deployment/backend -- wget -qO- http://localhost:3000/ 2>/dev/null || true)
            if echo "$OUT" | grep -q "${{ steps.img.outputs.tag }}"; then
              echo "verified: response contains expected tag"
              exit 0
            fi
            echo "attempt $i: not yet — got $OUT"
            sleep 3
          done
          echo "ERROR: version verification failed after 30s" >&2
          exit 1
```

This is the guardrail that catches the classic "rollout succeeded but old Pods are still serving because readiness probes are broken" bug.

---

## Step 5 — Reduce noise with concurrency

Add to the top of `deploy.yml`:

```yaml
concurrency:
  group: deploy-${{ github.ref }}
  cancel-in-progress: false     # queue, don't cancel a running deploy
```

If two merges happen close together, the second deploy waits for the first to finish instead of racing it. Set `cancel-in-progress: true` for build/test workflows where the newer commit's result is what matters.

---

## Step 6 — Add badges to your README

Show live CI status at the top of your repo README:

```markdown
![CI](https://github.com/<owner>/<repo>/actions/workflows/ci.yml/badge.svg)
![Build](https://github.com/<owner>/<repo>/actions/workflows/build.yml/badge.svg)
```

Instant "is main green right now" visual.

---

## Step 7 — Iterate faster with `act`

Instead of push → wait → check, run workflows locally:

```bash
brew install act               # macOS
act -j test                    # run only the "test" job from ci.yml
act pull_request               # simulate a PR event
act -s GITHUB_TOKEN=$(gh auth token)   # forward a real token
```

`act` uses Docker to emulate the runner. Not 100% accurate — service containers, some outputs, and GH-only actions can behave differently — but great for the 90% loop.

---

## Step 8 — Common enhancements to bolt on

- **Slack / Discord notifications** on failure — [rtCamp/action-slack-notify](https://github.com/rtCamp/action-slack-notify) or a curl to a webhook.
- **PR previews** — deploy each PR to a namespace like `preview-pr-123`, tear down when the PR closes.
- **Security scanning** — [aquasecurity/trivy-action](https://github.com/aquasecurity/trivy-action) scans your Docker image for CVEs; fail the build on HIGH/CRITICAL.
- **Semantic release** — [semantic-release/semantic-release](https://github.com/semantic-release/semantic-release) reads commit messages and auto-tags versions.
- **OIDC to AWS/GCP/Azure** — replace `KUBE_CONFIG_B64` with short-lived tokens. See [aws-actions/configure-aws-credentials](https://github.com/aws-actions/configure-aws-credentials) with `role-to-assume`.
- **Matrix testing** — run tests on Node 18, 20, 22 in parallel:
  ```yaml
  strategy:
    matrix:
      node: [18, 20, 22]
  steps:
    - uses: actions/setup-node@v4
      with:
        node-version: ${{ matrix.node }}
  ```

---

## Complete file structure after this walkthrough

```
your-repo/
├── .github/
│   └── workflows/
│       ├── ci.yml          # test on every PR / push to main
│       ├── build.yml       # build + push image on merge to main
│       └── deploy.yml      # deploy on successful build, with approval
├── K8S-demo-concept-wise-project/
│   └── kubernetes-pods/
│       └── backend/
│           ├── Dockerfile
│           ├── package.json
│           └── server.js
└── README.md               # with status badges
```

---

## Recap — what you now have

- **CI** on every push and PR, keeping main green.
- **Automated image builds** that produce immutable, tagged, signed-in-the-open Docker images.
- **Gated production deploys** with approval, audit log, and post-deploy verification.
- **All in YAML in the same repo as the code** — one PR changes the app, the pipeline, and the deploy config together. That's the GitOps-adjacent workflow that made GitHub Actions eat the CI/CD world.

Next stops:
- [INTERVIEW.md](INTERVIEW.md) — sharpen the concepts.
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — what you'll hit when you push this to a real project.
- [examples/](examples/) — copy-ready YAMLs for other scenarios (matrix, reusable, cron, security scan).
