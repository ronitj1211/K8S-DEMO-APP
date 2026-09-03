# Workflow syntax — every key, and what it does

Reference for `.github/workflows/*.yml`. Read [README.md](README.md) first for
the concepts.

---

## The skeleton

```yaml
name:          # workflow name in the UI
run-name:      # dynamic title for each run
on:            # triggers
permissions:   # GITHUB_TOKEN scopes
env:           # workflow-wide env vars
defaults:      # defaults for all run: steps
concurrency:   # limit simultaneous runs
jobs:          # the work
```

---

# `on:` — triggers

## Common events

```yaml
on:
  push:
    branches: [main, 'release/**']     # glob patterns allowed
    branches-ignore: [wip/**]          # use one OR the other, never both
    tags: ['v*']
    paths: ['src/**', '!**.md']        # only run if these files changed
    paths-ignore: ['docs/**']

  pull_request:
    types: [opened, synchronize, reopened]   # default: these three
    branches: [main]

  schedule:
    - cron: '0 3 * * *'                # 03:00 UTC daily. ALWAYS UTC.

  workflow_dispatch:                   # manual "Run workflow" button
    inputs:
      environment:
        description: 'Where to deploy'
        required: true
        default: 'staging'
        type: choice
        options: [staging, production]
      debug:
        type: boolean
        default: false

  release:
    types: [published]

  workflow_call:                       # makes this a REUSABLE workflow
  workflow_run:                        # run after another workflow finishes
    workflows: ['CI']
    types: [completed]
```

## Trigger gotchas that cost people hours

| Gotcha | What happens | Fix |
|---|---|---|
| `schedule` on a non-default branch | Never fires | Merge to the default branch |
| `schedule` accuracy | Can be delayed 5–30+ min at busy times (top of the hour is worst) | Don't rely on exact timing; use `7 * * * *` not `0 * * * *` |
| Scheduled workflows in an inactive repo | **Disabled after 60 days** of no activity | Push something, or re-enable in the UI |
| `pull_request` from a fork | Secrets are **not** available; `GITHUB_TOKEN` is read-only | Use `pull_request_target` **very carefully** — see [SECURITY.md](SECURITY.md) |
| `push` + `pull_request` both defined | Every PR commit runs the workflow **twice** | Use `pull_request` only, or add a `concurrency` group |
| Workflow doesn't trigger another workflow | Actions taken with `GITHUB_TOKEN` don't fire new events (prevents infinite loops) | Use a PAT or `workflow_call` |
| `paths:` filter with a merge commit | Compares against the base, not the previous commit | Verify with a test PR |

## `pull_request` vs `pull_request_target`

| | `pull_request` | `pull_request_target` |
|---|---|---|
| Code checked out | The **PR's** code | The **base branch's** code |
| Secrets available | **No** (for forks) | **Yes** |
| Risk | Low | **High** — running untrusted code with secrets |

**Rule:** never check out and execute PR code in a `pull_request_target`
workflow. That's how repos get their secrets stolen.

---

# `jobs:`

```yaml
jobs:
  my-job:                       # job ID — referenced by needs:
    name: Human readable        # UI label
    runs-on: ubuntu-latest      # the runner
    needs: [other-job]          # dependencies
    if: github.ref == 'refs/heads/main'
    timeout-minutes: 30         # default 360; ALWAYS set something lower
    continue-on-error: false    # true = failure doesn't fail the workflow
    environment: production     # gated env with optional approval
    concurrency: deploy-prod    # only one at a time
    permissions:
      contents: read
    env:
      JOB_VAR: value
    defaults:
      run:
        shell: bash
        working-directory: ./app
    outputs:
      result: ${{ steps.step1.outputs.value }}
    strategy:
      matrix: { node: [18, 20] }
    services:                   # sidecar containers
      postgres:
        image: postgres:16
    container:                  # run steps INSIDE a container
      image: node:20
    steps: []
```

## `runs-on:` — choosing a runner

```yaml
runs-on: ubuntu-latest          # most common; currently Ubuntu 24.04
runs-on: ubuntu-22.04           # pin when you need stability
runs-on: windows-latest
runs-on: macos-latest           # 10x minute cost on private repos
runs-on: [self-hosted, linux, x64]      # your own machine, by labels
runs-on: ${{ matrix.os }}
```

**GitHub-hosted runner specs** (public repos, standard):
~4 CPU, 16 GB RAM, 14 GB SSD, and a *huge* preinstalled toolset (git, docker,
node, python, go, java, aws-cli, kubectl, terraform…). Check what's there:
[actions/runner-images](https://github.com/actions/runner-images).

**Minute multipliers on private repos:** Linux ×1, Windows ×2, **macOS ×10**.
Public repos are free.

---

# `steps:`

```yaml
steps:
  - name: Descriptive name       # optional but do it
    id: my-step                  # needed to reference outputs
    uses: actions/checkout@v4    # EITHER an action...
    with:                        # ...and its inputs
      fetch-depth: 0
    env:
      MY_VAR: value
    if: success()
    continue-on-error: true
    timeout-minutes: 5

  - name: Run a command
    run: |                       # ...OR a shell command
      echo "line one"
      echo "line two"
    shell: bash
    working-directory: ./src
```

## `run:` details

```yaml
- run: echo "single line"

- run: |                         # multi-line, each line is a command
    set -euo pipefail            # ALWAYS do this in bash
    ./configure
    make

- run: echo "one long command that
    continues on the next line"  # `>` folds newlines into spaces
```

**Default shells:** Linux/macOS `bash -e`, Windows `pwsh`. Note plain `bash -e`
does *not* set `-o pipefail`, so `false | true` succeeds. Set it yourself:

```yaml
defaults:
  run:
    shell: bash                  # this DOES add -o pipefail
```

## `uses:` — referencing actions

```yaml
uses: actions/checkout@v4                    # marketplace/public repo, tag
uses: actions/checkout@v4.1.7                # exact version
uses: actions/checkout@8ade135a41bc03ea155e62e844d188df1ea18608   # SHA — safest
uses: ./.github/actions/my-action            # local composite action
uses: docker://alpine:3.19                   # a Docker image directly
uses: org/repo/.github/workflows/ci.yml@main # reusable workflow
```

**Pin third-party actions to a full SHA.** A tag can be moved by the author;
a SHA cannot. See [SECURITY.md](SECURITY.md).

---

# Passing data around

## Between steps — `$GITHUB_OUTPUT`

```yaml
- id: build
  run: |
    echo "version=1.2.3" >> "$GITHUB_OUTPUT"
    echo "sha_short=$(git rev-parse --short HEAD)" >> "$GITHUB_OUTPUT"

- run: echo "Built ${{ steps.build.outputs.version }}"
```

Multi-line values need a delimiter:

```yaml
- id: notes
  run: |
    {
      echo 'body<<DELIM'
      cat release-notes.md
      echo 'DELIM'
    } >> "$GITHUB_OUTPUT"
```

> `::set-output` is **deprecated and disabled**. Use `$GITHUB_OUTPUT`.

## Between jobs — `outputs:`

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    outputs:
      image-tag: ${{ steps.meta.outputs.tag }}
    steps:
      - id: meta
        run: echo "tag=v$(date +%s)" >> "$GITHUB_OUTPUT"

  deploy:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - run: echo "Deploying ${{ needs.build.outputs.image-tag }}"
```

## Environment variables — `$GITHUB_ENV`

```yaml
- run: echo "MY_VAR=hello" >> "$GITHUB_ENV"
- run: echo "$MY_VAR"        # available in LATER steps, not this one
```

## Files between jobs — artifacts

Jobs run on different machines, so files need uploading:

```yaml
- uses: actions/upload-artifact@v4
  with:
    name: build-output
    path: dist/
    retention-days: 7

# in another job:
- uses: actions/download-artifact@v4
  with:
    name: build-output
    path: dist/
```

## Adding to `PATH`

```yaml
- run: echo "$HOME/.local/bin" >> "$GITHUB_PATH"
```

---

# `strategy:` — matrix builds

```yaml
strategy:
  fail-fast: true          # default: one failure cancels the rest
  max-parallel: 3          # limit concurrency
  matrix:
    node: [18, 20, 22]
    os: [ubuntu-latest, macos-latest]

    include:               # add a combination, or add keys to existing ones
      - node: 22
        os: ubuntu-latest
        experimental: true

    exclude:               # remove a combination
      - node: 18
        os: macos-latest

runs-on: ${{ matrix.os }}
```

`3 nodes × 2 os = 6 jobs`, minus 1 excluded = **5 parallel jobs**.

**Set `fail-fast: false`** when you want to see *all* failures rather than
stopping at the first — usually what you want for a test matrix.

---

# `needs:` — job dependencies

```yaml
jobs:
  lint:   { runs-on: ubuntu-latest, steps: [{ run: echo lint }] }
  test:   { runs-on: ubuntu-latest, steps: [{ run: echo test }] }
  build:
    needs: [lint, test]        # waits for BOTH
    runs-on: ubuntu-latest
    steps: [{ run: echo build }]
  deploy:
    needs: build
    if: ${{ !cancelled() && needs.build.result == 'success' }}
    runs-on: ubuntu-latest
    steps: [{ run: echo deploy }]
```

By default a `needs:` job is **skipped** if its dependency fails. Use
`if: always()` or `if: ${{ !cancelled() }}` to run anyway (for cleanup or
notifications).

---

# `services:` — sidecar containers

For integration tests that need a real database:

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: postgres
        ports: ['5432:5432']
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
      redis:
        image: redis:7
        ports: ['6379:6379']
    steps:
      - uses: actions/checkout@v4
      - run: npm test
        env:
          DATABASE_URL: postgres://postgres:postgres@localhost:5432/postgres
```

**Always add health checks** — without them your tests start before Postgres
is accepting connections, and fail intermittently.

Host is `localhost` when steps run directly on the runner, but the **service
name** (`postgres`) when the job uses `container:`.

---

# `concurrency:` — don't run twice

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true       # cancel the older run
```

The classic use: someone pushes three commits quickly; only the newest run
survives. **Don't** use `cancel-in-progress: true` for deploys — you don't
want a half-finished deployment cancelled. Use it for CI, not CD.

---

# `permissions:` — GITHUB_TOKEN scopes

```yaml
permissions:
  contents: read          # read the repo (usually enough)
  # contents: write       # push commits, create releases
  # packages: write       # push to GHCR
  # id-token: write       # REQUIRED for OIDC cloud auth
  # pull-requests: write  # comment on PRs
  # issues: write
  # actions: read
```

Set at workflow level for a default, override per job. Start with
`contents: read` and add only what fails.

---

# `environment:` — deployment gates

```yaml
jobs:
  deploy:
    environment:
      name: production
      url: https://example.com     # shown in the UI
```

Configured in **Settings → Environments**, an environment can require
**manual approval**, restrict which branches may deploy, add a wait timer, and
hold its own secrets. This is how you get an approval step.

---

# Reusable workflows vs composite actions

| | Reusable workflow | Composite action |
|---|---|---|
| Contains | whole **jobs** | a sequence of **steps** |
| Called with | `uses:` at the **job** level | `uses:` at the **step** level |
| Lives in | `.github/workflows/` | any dir with `action.yml` |
| Can set `runs-on` | yes | no (inherits the caller's) |
| Use for | a whole pipeline shared across repos | a repeated group of steps |

**Reusable workflow:**

```yaml
# .github/workflows/reusable-build.yml
on:
  workflow_call:
    inputs:
      node-version:
        required: false
        type: string
        default: '20'
    secrets:
      npm-token:
        required: true
    outputs:
      artifact:
        # NOTE: block style, not `{ value: ... }`. A `${{ }}` expression
        # inside a YAML FLOW mapping breaks the parser, because YAML reads
        # the `{` as flow syntax. Always use block style with expressions.
        value: ${{ jobs.build.outputs.name }}
jobs:
  build:
    runs-on: ubuntu-latest
    outputs:
      name: ${{ steps.b.outputs.name }}
    steps:
      - uses: actions/checkout@v4
      - id: b
        run: echo "name=dist" >> "$GITHUB_OUTPUT"
```

```yaml
# caller
jobs:
  call-build:
    uses: ./.github/workflows/reusable-build.yml
    with:
      node-version: '22'
    secrets:
      npm-token: ${{ secrets.NPM_TOKEN }}
```

**Composite action:**

```yaml
# .github/actions/setup/action.yml
name: Setup
description: Checkout + Node + install
inputs:
  node-version:
    description: Node version
    required: false
    default: '20'
runs:
  using: composite
  steps:
    - uses: actions/setup-node@v4
      with:
        node-version: ${{ inputs.node-version }}
    - run: npm ci
      shell: bash          # REQUIRED on every run: in a composite action
```

```yaml
# caller
- uses: ./.github/actions/setup
  with:
    node-version: '22'
```

> Every `run:` inside a composite action **must** declare `shell:`. Omitting
> it is the most common composite-action error.

---

# Special files and variables

| Variable | Purpose |
|---|---|
| `$GITHUB_OUTPUT` | set step outputs |
| `$GITHUB_ENV` | set env vars for later steps |
| `$GITHUB_PATH` | prepend to PATH |
| `$GITHUB_STEP_SUMMARY` | write **Markdown** to the run summary page |
| `$GITHUB_WORKSPACE` | the checkout directory |
| `$RUNNER_TEMP` | scratch space, auto-cleaned |
| `$GITHUB_SHA`, `$GITHUB_REF`, `$GITHUB_ACTOR` | commit, ref, who triggered it |

Job summaries are underused and genuinely useful:

```yaml
- run: |
    {
      echo "## Test results"
      echo "| Suite | Result |"
      echo "|---|---|"
      echo "| unit | ✅ 142 passed |"
    } >> "$GITHUB_STEP_SUMMARY"
```

---

# Workflow commands

```yaml
- run: |
    echo "::notice title=Build::Build finished"
    echo "::warning file=app.js,line=10::Deprecated call"
    echo "::error::Something broke"
    echo "::group::Verbose logs"
    echo "hidden by default"
    echo "::endgroup::"
    echo "::add-mask::sensitive-value"     # mask it in logs
```

`notice`/`warning`/`error` appear as annotations on the run and on the diff.
