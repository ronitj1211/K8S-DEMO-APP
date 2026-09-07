# GitHub Actions — complete primer

Everything you need to understand GitHub Actions, in learning order:
**what it is → the vocabulary → how it works → how to write one → where files go.**

| Doc | Read it for |
|---|---|
| **README.md** (this file) | The whole picture — concepts, terms, execution model, your first workflow |
| [WORKFLOW-SYNTAX.md](WORKFLOW-SYNTAX.md) | Every key you can write in a workflow file, with what it does |
| [CONTEXTS-EXPRESSIONS.md](CONTEXTS-EXPRESSIONS.md) | `${{ }}`, all contexts, functions, `if:` conditions |
| [SECURITY.md](SECURITY.md) | Secrets, OIDC, permissions, script injection, pinning actions |
| [EXAMPLES.md](EXAMPLES.md) | Copy-paste workflows: Node CI, Docker, Terraform, Kubernetes, matrix, reusable |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Errors you will hit, debugging, speed and cost |
| **[INTERVIEW.md](INTERVIEW.md)** | **60 interview questions with answers** — concept first, then a real scenario for each. Covers every section above |

> **Nothing here runs.** These are docs only — there is no `.github/workflows/`
> directory in this repo, so no Actions minutes are consumed. Copy an example
> into `.github/workflows/` when you want it live.

---

# PART 1 — What it is

**GitHub Actions is a CI/CD platform built into GitHub.** It runs your
automation on GitHub-hosted machines in response to events in your repository.

The core loop is simple:

> **Something happens in the repo → GitHub runs the commands you defined.**

"Something happens" is a **push**, a **pull request**, a **schedule**, a
**manual click**, a released tag, an opened issue, or an API call. "The
commands you defined" live in a YAML file inside your repository.

## Why it exists

Before CI, you built and deployed from your laptop. That means:

- "works on my machine" — your laptop has tools and versions the server doesn't
- nobody knows if `main` is broken until someone tries to deploy it
- tests get skipped when you're in a hurry
- deployment steps live in someone's head or a stale wiki page

CI/CD fixes this by running **the same steps, on a clean machine, every
time**, automatically. GitHub Actions' specific advantage is that it's *in*
GitHub — no separate Jenkins server to run, patch and secure, and it can read
the repo, PRs and releases natively.

## How it compares

| | GitHub Actions | Jenkins | GitLab CI |
|---|---|---|---|
| Hosting | Managed by GitHub | **You run and patch the server** | Managed or self-hosted |
| Config | `.github/workflows/*.yml` | Jenkinsfile (Groovy) | `.gitlab-ci.yml` |
| Reuse | Marketplace actions | Plugins | Templates / includes |
| Cost | Free for public repos; minutes for private | Free software, you pay for servers + ops | Similar to Actions |
| Best when | Your code is already on GitHub | You need deep customisation / on-prem | Your code is on GitLab |

---

# PART 2 — The terms

You cannot read a workflow file until you know these seven words.

**Workflow** — one YAML file in `.github/workflows/`. It defines *when* to run
and *what* to run. A repo can have many, and they run independently.

**Event (trigger)** — what starts a workflow: `push`, `pull_request`,
`schedule`, `workflow_dispatch` (manual button), `release`, and ~35 others.
Declared under `on:`.

**Job** — a named group of steps that runs on **one machine**. Jobs run **in
parallel by default**; `needs:` makes one wait for another.

**Runner** — the machine a job runs on. **GitHub-hosted** (a fresh, clean VM
per job — `ubuntu-latest`, `windows-latest`, `macos-latest`) or
**self-hosted** (your own machine, for private-network access or special
hardware).

**Step** — one thing inside a job. Either a shell command (`run:`) or a
reusable action (`uses:`). Steps run **in order**, and share the same machine
and filesystem.

**Action** — a packaged, reusable unit you pull in with `uses:` — e.g.
`actions/checkout@v4` clones your repo. They come from the **Marketplace**,
another repo, or a local folder.

**Artifact** — files a job uploads so you can download them later, or so
another job can use them. Jobs run on *different machines*, so this is how
they pass files.

Two more you'll meet quickly:

**Context** — data available at runtime via `${{ }}`: `github.sha`,
`secrets.MY_TOKEN`, `matrix.version`. See [CONTEXTS-EXPRESSIONS.md](CONTEXTS-EXPRESSIONS.md).

**Expression** — anything inside `${{ }}`, evaluated by GitHub before the step
runs.

## How they nest

```
Repository
└── .github/workflows/ci.yml          ← a WORKFLOW
    ├── on: [push, pull_request]      ← the EVENTS that trigger it
    └── jobs:
        ├── test:                     ← a JOB (own machine)
        │   runs-on: ubuntu-latest    ← the RUNNER
        │   steps:
        │     - uses: actions/checkout@v4   ← a STEP using an ACTION
        │     - run: npm ci                 ← a STEP running a command
        │     - run: npm test
        └── build:                     ← another JOB (different machine)
            needs: test                ← waits for `test` to pass
            steps: ...
```

---

# PART 3 — How it works

## The execution model

```
 1. You push a commit
          │
          ▼
 2. GitHub reads every file in .github/workflows/
          │
          ▼
 3. For each workflow, does its `on:` match this event?
          │  no ──▶ skipped, nothing runs
          │  yes
          ▼
 4. Workflow run is created (you see it in the Actions tab)
          │
          ▼
 5. Jobs with no `needs:` start IMMEDIATELY, in PARALLEL
          │
          ▼
 6. For each job, GitHub allocates a RUNNER
       • GitHub-hosted: a brand-new clean VM, ~2 CPU / 7 GB / 14 GB disk
       • the VM has git, docker, node, python, and many tools preinstalled
          │
          ▼
 7. Steps run IN ORDER on that machine, sharing its filesystem
       • a step fails (non-zero exit) ──▶ remaining steps are SKIPPED
         (unless they say `if: always()`)
          │
          ▼
 8. Job ends. THE VM IS DESTROYED — everything on disk is gone
       • anything you need later must be an ARTIFACT or a cache
          │
          ▼
 9. Jobs that `needs:` this one now start (if it succeeded)
          │
          ▼
10. All jobs done ──▶ workflow run is green or red; the commit gets a ✓ or ✗
```

**The two facts that explain most confusion:**

1. **Each job gets a fresh, isolated machine.** Files written in job A do not
   exist in job B. Steps *within* one job do share a filesystem.
2. **The machine is destroyed afterwards.** Nothing persists between runs
   except what you explicitly upload as an artifact or store in a cache.

## Jobs are parallel, steps are sequential

```
   push
     │
     ├──────────────┬──────────────┐         jobs with no `needs:`
     ▼              ▼              ▼         all start at once
 ┌────────┐    ┌────────┐    ┌────────┐
 │  lint  │    │  test  │    │  build │      each on its OWN machine
 │        │    │        │    │        │
 │ step 1 │    │ step 1 │    │ step 1 │      steps run TOP TO BOTTOM
 │ step 2 │    │ step 2 │    │ step 2 │      on ONE machine, shared disk
 │ step 3 │    │ step 3 │    │ step 3 │
 └───┬────┘    └───┬────┘    └───┬────┘
     └──────────────┴──────────────┘
                    │ all three succeeded
                    ▼
              ┌──────────┐
              │  deploy  │   needs: [lint, test, build]
              └──────────┘
```

If any of `lint`/`test`/`build` fails, `deploy` **never runs**.

## Where the files go

```
your-repo/
└── .github/
    └── workflows/            ← MUST be exactly this path
        ├── ci.yml            ← filename is yours to choose
        ├── deploy.yml
        └── nightly.yml
```

- The directory is **`.github/workflows/`** — not `.github/`, not `workflows/`.
  A workflow anywhere else is simply ignored, with no error.
- One workflow per file. Extension `.yml` or `.yaml`.
- Workflows must be on the **default branch** for `schedule` and most
  non-push events to fire.
- Editing a workflow is a normal commit — it takes effect on the next
  matching event.

---

# PART 4 — Your first workflow, line by line

```yaml
# .github/workflows/ci.yml

name: CI                          # shown in the Actions tab

on:                               # WHEN to run
  push:
    branches: [main]              # only pushes to main
  pull_request:                   # and every PR

jobs:                             # WHAT to run
  test:                           # job id (used by `needs:`)
    name: Run tests               # pretty name in the UI
    runs-on: ubuntu-latest        # which runner

    steps:
      - name: Check out the code
        uses: actions/checkout@v4 # WITHOUT this the repo is NOT there

      - name: Set up Node
        uses: actions/setup-node@v4
        with:                     # inputs to the action
          node-version: '20'
          cache: 'npm'            # cache ~/.npm between runs

      - name: Install dependencies
        run: npm ci               # a shell command

      - name: Run tests
        run: npm test
```

**Five things worth internalising from those 25 lines:**

1. **`actions/checkout@v4` is not optional.** The runner starts as an empty
   machine — your code is *not* on it until you check it out. Forgetting this
   is the single most common beginner error, and the symptom is
   `no such file or directory` on your very first `run:`.
2. **`uses:` vs `run:`** — `uses:` pulls in someone else's packaged action;
   `run:` executes a shell command. A step is one or the other, never both.
3. **`with:`** supplies inputs to a `uses:` action. It does nothing for `run:`.
4. **`@v4` is a version.** Always pin it. `actions/checkout` with no version is
   invalid; `@main` means your build changes when they change.
5. **`npm ci`, not `npm install`.** `ci` installs exactly what's in the
   lockfile and fails if it's out of sync — which is what you want on a build
   machine.

---

# PART 5 — The concepts you'll need next

Each is covered fully in the linked doc; this is the orientation.

### Passing data between steps and jobs

Steps share a filesystem, so within a job you can just write a file. To pass
**values**, write to `$GITHUB_OUTPUT`:

```yaml
- id: vars
  run: echo "tag=v1.2.3" >> "$GITHUB_OUTPUT"
- run: echo "The tag is ${{ steps.vars.outputs.tag }}"
```

Between **jobs** (different machines) you need `outputs:` or an artifact — see
[WORKFLOW-SYNTAX.md](WORKFLOW-SYNTAX.md).

### Matrix builds — same job, many combinations

```yaml
strategy:
  matrix:
    node: [18, 20, 22]
    os: [ubuntu-latest, windows-latest]
```

That runs **6 jobs in parallel**, one per combination.

### Conditions

```yaml
- run: ./deploy.sh
  if: github.ref == 'refs/heads/main' && github.event_name == 'push'
```

Note: **no `${{ }}` needed** inside `if:` — it's already an expression context.

### Secrets

Never put a token in the YAML. Store it in
**Settings → Secrets and variables → Actions**, then:

```yaml
env:
  TOKEN: ${{ secrets.MY_TOKEN }}
```

Secrets are masked in logs. For cloud auth, prefer **OIDC** over stored keys —
see [SECURITY.md](SECURITY.md).

### Caching vs artifacts — different jobs

| | Cache | Artifact |
|---|---|---|
| Purpose | Speed up repeat runs (dependencies) | Keep build output / share between jobs |
| Lifetime | Evicted after 7 days unused | Retained 90 days (configurable) |
| Correctness | Must be safe to lose | You depend on it |

### Permissions

The automatic `GITHUB_TOKEN` should be least-privilege:

```yaml
permissions:
  contents: read        # start here, add only what you need
```

---

# PART 6 — What to learn in what order

1. **Write a CI workflow** that checks out code and runs tests on push. Watch
   it in the Actions tab. Break it deliberately and read the red log.
2. **Add a second job** with `needs:` so you can see sequencing.
3. **Add a matrix** across two language versions.
4. **Add a secret** and use it in an env var.
5. **Cache dependencies** and compare run times.
6. **Build and push a Docker image** on tags only.
7. **Deploy** using OIDC instead of long-lived cloud keys.
8. **Factor out** a reusable workflow or composite action once you've
   copy-pasted the same steps three times.

Steps 1–5 cover the vast majority of real usage.

---

## Quick reference

```yaml
name: Example
on:                                    # WHEN
  push: { branches: [main] }
  pull_request:
  schedule: [{ cron: '0 3 * * *' }]    # UTC, 5-field cron
  workflow_dispatch:                   # manual run button

permissions:
  contents: read                       # least privilege

concurrency:                           # cancel superseded runs
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

env:
  GLOBAL_VAR: value                    # available to every job

jobs:
  build:                               # WHAT
    runs-on: ubuntu-latest
    timeout-minutes: 15                # kill runaway jobs
    outputs:
      image: ${{ steps.meta.outputs.tag }}
    steps:
      - uses: actions/checkout@v4
      - id: meta
        run: echo "tag=$GITHUB_SHA" >> "$GITHUB_OUTPUT"
      - run: echo "building ${{ steps.meta.outputs.tag }}"

  deploy:
    needs: build                       # wait for build
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    environment: production            # can require manual approval
    steps:
      - run: echo "deploying ${{ needs.build.outputs.image }}"
```

**Terms in one line each:** *workflow* = the file · *event* = what triggers it
· *job* = a group of steps on one machine · *runner* = that machine · *step* =
one command or action · *action* = reusable packaged step · *artifact* = files
that outlive the machine.
