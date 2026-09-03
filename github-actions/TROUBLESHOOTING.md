# Troubleshooting, debugging, speed and cost

---

## Errors you will hit

### "no such file or directory" on your first `run:`

You forgot `actions/checkout@v4`. The runner starts **empty** — your code is
not on it until you check it out.

```yaml
steps:
  - uses: actions/checkout@v4      # ALWAYS first
  - run: ls -la
```

### The workflow doesn't run at all

In order of likelihood:

1. File isn't in **`.github/workflows/`** exactly.
2. **YAML is invalid** — GitHub silently ignores an unparseable workflow.
   Check the Actions tab for a syntax error banner.
3. The `on:` doesn't match. Pushing to `feature/x` won't trigger
   `branches: [main]`.
4. `schedule` only runs from the **default branch**.
5. Actions are **disabled** for the repo (Settings → Actions).
6. Scheduled workflow **auto-disabled after 60 days** of repo inactivity.
7. The event was caused by `GITHUB_TOKEN` — those don't trigger new workflows.

### YAML: "mapping values are not allowed here"

Almost always an **unquoted colon** in a `run:`:

```yaml
- run: echo "Title: hello"        # INVALID — the `: ` splits the key
```

YAML sees `run: echo "Title` then hits `: ` and expects a new key. Fix with a
block scalar:

```yaml
- run: |
    echo "Title: hello"
```

Use `run: |` by default and this class of bug disappears.

### `${{ }}` inside `{ }` breaks parsing

```yaml
outputs:
  artifact: { value: ${{ jobs.build.outputs.name }} }   # INVALID
```

YAML reads `{` as a flow mapping and the nested braces confuse it. Use block
style:

```yaml
outputs:
  artifact:
    value: ${{ jobs.build.outputs.name }}
```

### "Resource not accessible by integration"

`GITHUB_TOKEN` lacks a permission. Add exactly what's needed:

```yaml
permissions:
  contents: read
  pull-requests: write       # e.g. to comment on a PR
```

### "Error: Credentials could not be loaded" with OIDC

Missing `id-token: write`:

```yaml
permissions:
  id-token: write
  contents: read
```

If that's present, the IAM trust policy `sub` doesn't match. Print the claim
you're actually sending:

```yaml
- run: |
    echo "sub should be: repo:${{ github.repository }}:ref:${{ github.ref }}"
```

### A secret is empty

- The workflow is a **fork PR** — secrets are intentionally unavailable.
- It's an **environment** secret and the job has no `environment:`.
- Name typo. `secrets.MY_KEY` vs `secrets.MY_key` — names are case-sensitive
  in practice; use `UPPER_SNAKE_CASE` consistently.

### Steps after a failure don't run

That's the default. Steps only run if everything before succeeded:

```yaml
- name: Always upload logs
  if: always()
  uses: actions/upload-artifact@v4
  with: { name: logs, path: logs/ }
```

### `needs:` job is skipped

If a dependency fails, dependants are skipped by design:

```yaml
if: ${{ !cancelled() && needs.build.result == 'success' }}
```

### The `if:` condition is always true

Context values are **strings**. `if: needs.x.outputs.flag` is truthy even for
`'false'`. Compare explicitly:

```yaml
if: needs.x.outputs.flag == 'true'
```

### The cache never hits

- Caches are **immutable** — an existing key is never overwritten. Include a
  hash: `key: ${{ runner.os }}-${{ hashFiles('**/lock') }}`.
- Caches are **scoped by branch**. A feature branch can read `main`'s cache,
  but not the other way round, and not across unrelated branches.
- 10 GB per repo, evicted least-recently-used, and after 7 days unused.

### The job hangs until it's killed

Default timeout is **6 hours** — enormously expensive on private repos.
Always set one:

```yaml
jobs:
  build:
    timeout-minutes: 15
```

Common causes: a command waiting for input (add `-y`/`--yes`), a service
container with no health check, or a process that never exits.

### Docker build works locally, fails in CI

- Local Docker has a warm layer cache; CI starts cold. Use `cache-from: type=gha`.
- `.dockerignore` matters more — CI sends the full context.
- Architecture: runners are `x86_64`; an image built on an M-series Mac may be
  `arm64`. Use `docker/setup-qemu-action` for multi-arch.

---

## Debugging technique

### 1. Turn on debug logging

Add these **repository secrets**:

| Secret | Value | Effect |
|---|---|---|
| `ACTIONS_STEP_DEBUG` | `true` | verbose per-step output |
| `ACTIONS_RUNNER_DEBUG` | `true` | runner diagnostics |

### 2. Dump the context

```yaml
- name: Dump context
  run: |
    echo '${{ toJSON(github) }}'
    echo '${{ toJSON(needs) }}'
    echo '${{ toJSON(steps) }}'
```

### 3. Inspect the machine

```yaml
- run: |
    echo "== env ==";     env | sort
    echo "== pwd ==";     pwd && ls -la
    echo "== disk ==";    df -h
    echo "== tools ==";   node -v; python3 -V; docker -v
```

### 4. Get an interactive shell

```yaml
- name: Debug session
  if: failure()
  uses: mxschmitt/action-tmate@v3
  timeout-minutes: 15
```

Gives you SSH into the runner. **Never on a public repo** — anyone watching
the log can connect.

### 5. Run it locally with `act`

```bash
brew install act
act -l                          # list workflows
act push                        # simulate a push
act -j test                     # run one job
act --secret-file .secrets
```

Not a perfect emulation (different images, no real GitHub API) but it catches
YAML and logic errors in seconds instead of a push-wait-read cycle.

### 6. Lint before pushing

```bash
# actionlint catches expression errors, bad contexts, shellcheck issues
brew install actionlint
actionlint

# or validate the YAML parses at all
python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml'))"
```

`actionlint` is the highest-value tool here — it understands Actions
semantics, not just YAML, and runs shellcheck over your `run:` blocks.

---

## Making it faster

| Technique | Typical saving |
|---|---|
| Cache dependencies (`cache: npm` in setup-node) | 30–120s per job |
| Docker layer cache (`type=gha`) | 1–5 min per build |
| `concurrency` + `cancel-in-progress` | cancels wasted runs |
| `paths:` filters | skips irrelevant runs entirely |
| Parallel jobs instead of one long job | wall-clock, not total minutes |
| `fetch-depth: 1` (the default) | seconds on big repos |
| Skip the matrix on draft PRs | big on multi-version matrices |
| Bigger runners | linear speed, linear cost |

```yaml
# only run when relevant files changed
on:
  push:
    paths:
      - 'src/**'
      - 'package*.json'
      - '.github/workflows/ci.yml'

# stop superseded runs
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

# skip heavy work on drafts
jobs:
  e2e:
    if: github.event.pull_request.draft == false
```

---

## Cost

**Public repositories: free, unlimited.**

Private repos get a monthly free allowance (2,000 min on Free, 3,000 on Team,
50,000 on Enterprise), then per-minute billing. Multipliers:

| Runner | Multiplier |
|---|---|
| Linux | ×1 |
| Windows | ×2 |
| **macOS** | **×10** |

A 10-minute macOS job costs the same as 100 minutes of Linux. Storage for
artifacts and caches is billed separately.

**Where the money actually goes:**
- No `timeout-minutes`, so a hung job burns the 6-hour default
- Matrix jobs multiply — `3 versions × 3 OSes = 9 jobs` per push
- No `concurrency`, so five pushes run five full pipelines
- macOS runners used when Linux would do
- No `paths:` filter, so doc-only commits run the whole suite

Check usage in Settings → Billing → Actions, and per-run in the run summary.

---

## Quick reference

```bash
# GitHub CLI
gh workflow list
gh workflow run deploy.yml -f environment=staging
gh run list --workflow=ci.yml --limit 10
gh run view <run-id> --log
gh run view <run-id> --log-failed        # only the failing step
gh run watch <run-id>
gh run rerun <run-id> --failed           # re-run only failed jobs
gh run cancel <run-id>
```

| Symptom | First thing to check |
|---|---|
| Workflow didn't run | path, YAML validity, `on:` filters |
| File not found | missing `actions/checkout` |
| Permission denied on the API | `permissions:` block |
| Secret is empty | fork PR, or environment scoping |
| OIDC fails | `id-token: write`, then the trust policy `sub` |
| Step skipped | a previous step failed — add `if: always()` |
| Cache miss | key has no hash, or wrong branch scope |
| Job hangs | missing `timeout-minutes`, waiting on input |
| Condition always true | comparing a string — use `== 'true'` |
