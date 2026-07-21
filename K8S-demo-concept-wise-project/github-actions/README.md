# GitHub Actions

CI/CD built into GitHub. This folder collects everything you need to speak fluently about GitHub Actions in an interview or debug real pipelines.

## What's in this folder

| File | Purpose |
|---|---|
| [README.md](README.md) | Concepts — what/why/how it works |
| [INTERVIEW.md](INTERVIEW.md) | Interview Q&A: basic / intermediate / scenario-based |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Common issues while developing pipelines + fixes |
| [SAMPLE-PIPELINE.md](SAMPLE-PIPELINE.md) | Step-by-step: build your first pipeline from scratch |
| [examples/](examples/) | Ready-to-copy workflow YAMLs (CI, Docker+K8s deploy, matrix, reusable) |

---

## What is GitHub Actions?

**GitHub Actions is a CI/CD platform** built into GitHub. You describe *when* to run and *what* to run in YAML files under `.github/workflows/`, and GitHub schedules that work on a **runner** (a VM or container). Common uses:

- Run tests on every push / pull request.
- Build container images and push to a registry.
- Deploy to Kubernetes / AWS / GCP / Azure on merge to main.
- Publish npm / PyPI / Docker packages on release.
- Schedule cron jobs (backups, sync, cleanup).
- Automate issues, PR labels, releases.

### Why does it exist?

Before: you glued together Jenkins / CircleCI / Travis + webhooks + secret management + notifications. Each stack was custom.

GitHub Actions bundles all of that into one product living in the same repo as the code:

- **Same auth model** as the repo (no separate CI login).
- **Same secrets store** (Repository / Organization / Environment secrets).
- **Same permissions** (branch protection, required checks, environment approvals).
- **Marketplace of reusable actions** — you rarely start from a blank slate.

---

## Key concepts

| Term | What it is |
|---|---|
| **Workflow** | A YAML file at `.github/workflows/<name>.yml`. Defines events, jobs, steps. |
| **Event** | What triggers a workflow: `push`, `pull_request`, `schedule`, `workflow_dispatch` (manual), `release`, and dozens more. |
| **Job** | A group of steps that run on **one runner**. Jobs in the same workflow run in parallel by default; use `needs:` for dependencies. |
| **Step** | A single unit inside a job. Either a shell command (`run:`) or an action (`uses:`). |
| **Action** | A reusable unit of code you `uses:` — either from the marketplace (`actions/checkout@v4`), your own repo, or a Docker image. |
| **Runner** | The machine that executes a job. **GitHub-hosted** (`ubuntu-latest`, `macos-latest`, `windows-latest`) or **self-hosted** (your infra). |
| **Secret** | Encrypted variable — accessed as `${{ secrets.FOO }}`. Never printed in logs (auto-masked). |
| **Variable** | Non-sensitive config — `${{ vars.FOO }}` for repo-level, or env-level `${{ env.FOO }}`. |
| **Artifact** | Files produced by one job that another job (or a human) can download. |
| **Cache** | Persistent storage between runs — usually for dependencies (`~/.npm`, `~/.cache/pip`). |
| **Environment** | Named deployment target (`staging`, `prod`) with its own secrets, protection rules, and approvers. |
| **Concurrency** | Group runs so newer ones cancel older ones — prevents deploy race conditions. |

---

## How it works

```
┌──────────────────┐
│ You push a commit│
└────────┬─────────┘
         ▼
┌──────────────────────────────────────────────────────┐
│ GitHub receives the push event                       │
│  - Reads .github/workflows/*.yml                     │
│  - Matches workflows whose `on:` includes this event │
└────────┬─────────────────────────────────────────────┘
         ▼
┌──────────────────────────────────────────────────────┐
│ For each matched workflow:                           │
│   Queue one run per matching workflow                │
│   Allocate runners (GitHub-hosted or self-hosted)    │
└────────┬─────────────────────────────────────────────┘
         ▼
┌──────────────────────────────────────────────────────┐
│ On each runner:                                      │
│   1. Boot fresh VM/container                         │
│   2. Clone the repo (via actions/checkout)           │
│   3. Execute the job's steps in order                │
│   4. Upload artifacts / cache / logs                 │
│   5. Report status back to the commit / PR           │
└──────────────────────────────────────────────────────┘
```

### Minimal example

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
      - run: npm test
```

Four concepts in ten lines:
- `on:` — event triggers.
- `jobs.test` — a single job named `test`.
- `runs-on:` — GitHub-hosted Ubuntu runner.
- `steps:` — checkout, install Node, install deps, run tests.

Push this file to `.github/workflows/ci.yml` → next commit runs it.

---

## Anatomy of a workflow file

```yaml
name: Deploy                              # display name in the UI

on:                                       # triggers
  push:
    branches: [main]
    paths: ['src/**', 'Dockerfile']       # only run when these files change
  pull_request:
    branches: [main]
  workflow_dispatch:                       # allow manual runs
    inputs:
      environment:
        type: choice
        options: [staging, prod]
  schedule:
    - cron: '0 2 * * *'                    # nightly at 02:00 UTC

concurrency:                               # cancel outdated runs
  group: deploy-${{ github.ref }}
  cancel-in-progress: true

permissions:                               # what the GITHUB_TOKEN can do
  contents: read
  packages: write                          # push to GitHub Packages
  id-token: write                          # for OIDC to cloud

env:                                       # workflow-wide env vars
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}

jobs:
  build:
    runs-on: ubuntu-latest
    outputs:                               # pass data to downstream jobs
      image-tag: ${{ steps.meta.outputs.tag }}
    steps:
      - uses: actions/checkout@v4
      - id: meta
        run: echo "tag=$(git rev-parse --short HEAD)" >> $GITHUB_OUTPUT
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v5
        with:
          push: true
          tags: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:${{ steps.meta.outputs.tag }}

  deploy:
    needs: build                           # wait for build
    runs-on: ubuntu-latest
    environment: production                # gates + secrets from this env
    steps:
      - run: echo "deploying image ${{ needs.build.outputs.image-tag }}"
```

Every real workflow is variations on this.

---

## Runners

### GitHub-hosted

- Free (with limits) for public repos, metered minutes for private ones.
- Fresh VM each run — clean state.
- Pre-installed tools: Docker, Node, Python, Java, gh CLI, cloud CLIs.
- No secrets from other runs — good isolation.
- **Limitation**: can't reach your private network. For that, use self-hosted.

### Self-hosted

- Your own machine (VM, K8s Pod via [actions-runner-controller](https://github.com/actions/actions-runner-controller), bare metal).
- Reaches your private VPC / on-prem systems.
- **Warning**: don't use on public repos without extra care — anyone can PR a workflow that runs on your infra. Restrict via `permissions: pull-request-target` rules and `if:` gates.

### Larger runners

- Paid GitHub-hosted VMs with more CPU/RAM/GPU/ARM. Configured in org settings.

---

## Marketplace actions vs run steps

You'll mix both. Rule of thumb:

- **Use an action** (`uses:`) when someone else already solved the problem well and it's a common task: checkout, setup-node, docker/build-push, aws-configure-credentials, etc. Look on [github.com/marketplace](https://github.com/marketplace).
- **Use `run:`** for anything project-specific: shell scripts, custom build commands, one-off logic.

Pin actions to a **major version** (`actions/checkout@v4`) or a **commit SHA** (`actions/checkout@a5ac7e51b41094c92402da3b24376905380afc29`) — never `@main`, which changes under you.

---

## Secrets vs Variables vs Env

| | Where set | Encrypted? | Auto-masked? | Access syntax |
|---|---|---|---|---|
| **Secret** | Repo / Org / Environment settings | Yes | Yes | `${{ secrets.NAME }}` |
| **Variable** | Repo / Org / Environment settings | No | No | `${{ vars.NAME }}` |
| **Env** | In the workflow YAML | No | No (unless from a secret) | `${{ env.NAME }}` or `$NAME` in bash |

- Never put a secret value in `env:` from plain text or `vars:` — it won't be masked in logs.
- **Environment secrets** apply only to jobs that declare `environment: <name>`. Great for prod-only credentials.

---

## Contexts you'll reference constantly

- `github.*` — event data: `github.event_name`, `github.ref`, `github.sha`, `github.actor`, `github.repository`.
- `env.*` — env vars set in the workflow.
- `secrets.*` — encrypted secrets.
- `vars.*` — non-sensitive variables.
- `steps.<id>.outputs.*` — outputs from a previous step in the same job.
- `needs.<job>.outputs.*` — outputs from a previous job.
- `runner.*` — runner info: `runner.os`, `runner.temp`, `runner.arch`.
- `matrix.*` — current matrix combination in a matrix job.

Debug them once: `- run: echo "${{ toJSON(github) }}"`. Prints everything.

---

## Common patterns

- **Matrix builds** — one workflow, many combinations (Node 18/20/22, OS ubuntu/mac/windows). Uses `strategy.matrix`.
- **Reusable workflows** — one workflow calls another with `uses: ./.github/workflows/other.yml`. Reduces copy-paste.
- **Composite actions** — bundle multiple steps into one action, shared across workflows.
- **Path filters** — `on.push.paths` runs the workflow only when relevant files change (saves minutes).
- **Concurrency groups** — auto-cancel outdated runs (`concurrency.cancel-in-progress: true`).
- **OIDC to cloud** — get short-lived credentials for AWS / GCP / Azure without storing static keys.
- **Environments** — `environment: prod` gates a job behind human approval, restricts secrets, and shows a deploy log in the UI.

---

## Where to go next

- **First real pipeline?** → [SAMPLE-PIPELINE.md](SAMPLE-PIPELINE.md)
- **Interview prep?** → [INTERVIEW.md](INTERVIEW.md)
- **Something's broken?** → [TROUBLESHOOTING.md](TROUBLESHOOTING.md)
- **Copy-paste YAMLs?** → [examples/](examples/)

External:
- [Official docs](https://docs.github.com/actions)
- [Marketplace](https://github.com/marketplace?type=actions)
- [Workflow syntax reference](https://docs.github.com/actions/using-workflows/workflow-syntax-for-github-actions)
