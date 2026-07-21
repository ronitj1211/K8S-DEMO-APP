# Interview Questions — GitHub Actions

---

## Basic

### Q1. What is GitHub Actions?
A CI/CD platform native to GitHub. You define workflows in YAML under `.github/workflows/`, GitHub schedules them on runners (VMs or containers), and results appear on commits and PRs. Same auth, secrets, and permission model as your repo.

### Q2. Workflow vs Job vs Step vs Action?
- **Workflow** — a YAML file. One file = one workflow.
- **Job** — a group of steps that runs on **one** runner. Multiple jobs run in parallel by default.
- **Step** — a single unit inside a job. Either a shell command (`run:`) or a call to an action (`uses:`).
- **Action** — a reusable unit — from the marketplace, another repo, or a Docker image.

### Q3. What events can trigger a workflow?
Common: `push`, `pull_request`, `pull_request_target`, `schedule` (cron), `workflow_dispatch` (manual), `workflow_call` (called by another workflow), `release`, `issues`, `issue_comment`, `label`, `repository_dispatch` (external API trigger).

### Q4. GitHub-hosted vs self-hosted runners?
- **GitHub-hosted** — Ubuntu/macOS/Windows VMs GitHub manages. Fresh each run. Free for public repos, metered for private.
- **Self-hosted** — your infra (VM, K8s Pod, bare metal). Needed for private-network access. **Never expose self-hosted runners to public repos** — anyone's PR can execute code on them.

### Q5. What's `actions/checkout` and why do you need it?
Your workflow runs on a bare runner — the repo isn't cloned by default. `actions/checkout@v4` fetches the repo so subsequent steps can see your files. Almost every workflow starts with it.

### Q6. Secrets vs variables?
- **Secrets** (`${{ secrets.X }}`) — encrypted at rest, auto-masked in logs, meant for tokens/passwords/certs.
- **Variables** (`${{ vars.X }}`) — plain-text config (image tags, cluster names, feature flags).

### Q7. How do you pass data between jobs?
Via **outputs**:
```yaml
jobs:
  build:
    outputs:
      image: ${{ steps.build.outputs.tag }}
    steps:
      - id: build
        run: echo "tag=v1.2.3" >> $GITHUB_OUTPUT
  deploy:
    needs: build
    steps:
      - run: echo "deploying ${{ needs.build.outputs.image }}"
```
For files/binaries, use `actions/upload-artifact` in one job and `actions/download-artifact` in the next.

### Q8. How do you run jobs in parallel or sequentially?
- **Parallel by default** — every job in a workflow starts simultaneously if runners are available.
- **Sequential** — `needs: <other-job>` makes this job wait.

### Q9. What's `GITHUB_TOKEN`?
An automatically-created secret with permissions scoped to the workflow's needs. Used for API calls back to the repo — commenting on PRs, creating releases, pushing to `ghcr.io`. Configure its permissions via `permissions:` at workflow or job level.

### Q10. What's a runner and how does it get the job?
A **runner** is a machine executing a small agent (github-actions runner) that long-polls GitHub for work. When your workflow triggers, GitHub queues a job → the runner picks it up → runs the steps → reports back. GitHub-hosted runners are ephemeral; self-hosted persist between jobs (which is a security concern if not managed).

---

## Intermediate

### Q11. What's a matrix strategy?
Run the same job across many configurations:
```yaml
strategy:
  matrix:
    node: [18, 20, 22]
    os: [ubuntu-latest, macos-latest]
```
That's 6 parallel runs. Use `strategy.fail-fast: false` to keep running even if one fails. `strategy.include:` adds one-off entries; `strategy.exclude:` removes combos.

### Q12. What's a reusable workflow?
A workflow with `on: workflow_call:`. Other workflows call it via `uses: ./.github/workflows/other.yml` or `uses: owner/repo/.github/workflows/other.yml@main`. Great for a shared "deploy to K8s" pipeline that many repos call with different inputs.

### Q13. What's a composite action?
A custom action defined by a folder with `action.yml` that bundles multiple steps. Reusable across workflows and repos. Think of it as a "step" wrapper for reusability. Different from reusable workflows (which are whole workflows).

### Q14. How do you handle concurrency to prevent race conditions?
```yaml
concurrency:
  group: deploy-${{ github.ref }}
  cancel-in-progress: true
```
Only one run in the group runs at a time. If a new push comes in, the old run is cancelled. Common groups:
- `deploy-${{ github.ref }}` — per-branch deploy lock.
- `${{ github.workflow }}-${{ github.event.pull_request.number }}` — one run per PR.

### Q15. What's caching and how do you use it?
`actions/cache` stores directories between runs — speeds up dependency installs:
```yaml
- uses: actions/cache@v4
  with:
    path: ~/.npm
    key: npm-${{ hashFiles('package-lock.json') }}
    restore-keys: |
      npm-
```
`key` is unique per lockfile hash — same lockfile = cache hit. `restore-keys` are fallbacks. Cache eviction is per-branch, LRU, ~10 GB per repo.

### Q16. How do OIDC and cloud auth work?
Instead of storing static AWS/GCP keys as secrets, use OIDC:
```yaml
permissions:
  id-token: write
  contents: read
- uses: aws-actions/configure-aws-credentials@v4
  with:
    role-to-assume: arn:aws:iam::123456789012:role/gh-deploy
    aws-region: us-east-1
```
GitHub mints a short-lived JWT → the cloud (AWS/GCP/Azure) validates it → hands back short-lived credentials. **No long-lived secrets in GitHub**.

### Q17. What's an Environment?
A named deployment target with:
- Its own **secrets** (e.g., `PROD_DB_URL`).
- **Protection rules** — required reviewers, wait timers, branch restrictions.
- A **deploy log** in the UI.

Reference in a job: `environment: production`. The job pauses at the approval gate until a reviewer clicks approve.

### Q18. Difference between `pull_request` and `pull_request_target`?
- `pull_request` — runs against the **PR fork's HEAD**. Secrets are NOT available (security). Read-only `GITHUB_TOKEN`.
- `pull_request_target` — runs against the **base branch's HEAD** but has PR context. **Has access to secrets**. Dangerous: never checkout the PR's code + run it here (leaks secrets to attacker).

Use `pull_request` for CI. Use `pull_request_target` only for automation like labeling / commenting on PRs.

### Q19. What are step outputs and how do they differ from env?
- **Step outputs**: written via `echo "key=value" >> $GITHUB_OUTPUT`. Accessed as `${{ steps.<id>.outputs.key }}`. Passed to other steps or jobs.
- **`GITHUB_ENV`**: `echo "KEY=value" >> $GITHUB_ENV`. Sets an env var visible to all subsequent steps *in the same job*.

Outputs cross job boundaries via `jobs.<job>.outputs`. Env doesn't.

### Q20. How do you debug a failing action?
- Re-run with **debug logging**: set repo secrets `ACTIONS_STEP_DEBUG=true` and `ACTIONS_RUNNER_DEBUG=true`.
- **`tmate` action** — `mxschmitt/action-tmate` opens an SSH session into the runner mid-workflow.
- Add `- run: env | sort` and `- run: echo "${{ toJSON(github) }}"` to inspect state.
- **`act`** (nektos/act) — runs workflows locally in Docker for faster iteration.

### Q21. What are artifacts and how long do they live?
Files produced by a job that another job or a human can download. `actions/upload-artifact@v4` → `actions/download-artifact@v4`. Default retention is 90 days (configurable via `retention-days:`). Not for source code — that's what checkout is for.

### Q22. What's `if:` and how do you use it?
Conditional execution. Evaluated per step or per job.
```yaml
- if: github.event_name == 'push' && github.ref == 'refs/heads/main'
  run: ./deploy.sh
```
Useful patterns:
- `if: failure()` — only if a previous step failed. Good for cleanup / notify.
- `if: always()` — always run, even on cancel. Good for reporting.
- `if: success()` — default.
- `if: ${{ !cancelled() }}` — skip only on cancel.

### Q23. When would you use a Docker container action vs a JavaScript action vs a composite action?
- **JavaScript action** — fastest (no container startup), cross-platform. Use for anything that doesn't need OS-level tools.
- **Docker container action** — Linux only, but any language, isolated deps. Slower startup.
- **Composite action** — pure YAML — just packages a sequence of `run:`/`uses:` steps. Simplest, no code.

---

## Scenario-based

### S1. Your workflow runs on every commit, and you're burning through minutes. How do you cut it down?
- **Path filters**: `on.push.paths: ['src/**']` — skip when only docs change.
- **`paths-ignore`**: opposite.
- **Concurrency + cancel-in-progress**: kill outdated runs the moment a new commit arrives.
- **Matrix reduction**: only test min + max Node versions on every push; full matrix on nightly cron.
- **Cache dependencies**: turn a 3-min install into a 20-sec restore.
- **Split**: fast tests on push, slow integration tests only on PR merge or nightly.

### S2. A step needs a Docker image from ghcr.io in a private repo. Login fails.
```yaml
- uses: docker/login-action@v3
  with:
    registry: ghcr.io
    username: ${{ github.actor }}
    password: ${{ secrets.GITHUB_TOKEN }}
```
Common failures:
- Missing `permissions.packages: write` at workflow or job level.
- The package's "Package settings → Actions access" doesn't include this repo.
- Using a fine-grained PAT instead of `GITHUB_TOKEN` — that PAT lacks scope.

### S3. Your workflow needs to deploy to production only after manual approval.
Use an **Environment** with protection rules:
```yaml
jobs:
  deploy:
    environment: production
    ...
```
In repo Settings → Environments → production → add required reviewers. When the job hits, it pauses; a reviewer clicks approve; the job resumes. Deploy audit is preserved in the Environment history.

### S4. Your workflow succeeded in CI but fails on a self-hosted runner.
Investigate:
- **Runner label mismatch**: `runs-on: [self-hosted, linux, x64]` — verify labels via `gh workflow list-runners`.
- **Runner has stale state** — previous job left files/env vars. Solution: use ephemeral runners (spin fresh per job — actions-runner-controller does this on K8s).
- **Missing tools** — GitHub runners come pre-installed with docker/node/etc. Self-hosted usually don't. Install what you need in a `setup-*` step or preload the runner image.
- **Network / DNS** — self-hosted runners have your VPC's DNS; things reachable to GH-hosted (public internet) may not be for private ones and vice versa.

### S5. Two developers push to main simultaneously; both trigger a deploy. Chaos.
- **Concurrency group**: `group: deploy-main`, `cancel-in-progress: true` — but this cancels the older run mid-deploy which can leave things half-done.
- **Better**: `cancel-in-progress: false` + `queue` behavior — later runs wait for the earlier to complete cleanly.
- **Best (with Environments)**: production environment allows only 1 concurrent job. Provides both queuing and audit trail.

### S6. You want the workflow to fail if a specific test fails, but continue to run the rest and report all failures.
- Use `continue-on-error: true` on individual steps to keep the job green but see the step marked "with warning".
- For a matrix, `strategy.fail-fast: false` runs all combinations even if one fails.
- To collect all failures, wire tests to produce JUnit XML → upload as artifact → use `dorny/test-reporter` action to render results in the PR check.

### S7. `${{ secrets.MY_KEY }}` is empty in a fork PR.
Fork PRs don't get secrets — this is a security feature. Options:
- Split the workflow: read-only checks run on `pull_request`; deploys / secret-using jobs run only on `push` to main after merge.
- Use `pull_request_target` for label/comment automation ONLY (never check out the PR code — that would run untrusted code with your secrets).

### S8. Your workflow YAML is 500 lines and copy-pasted across 5 repos. How to fix?
- **Composite action**: extract steps into `actions/foo/action.yml` in a central repo.
- **Reusable workflow**: entire jobs go into a workflow with `on: workflow_call` — called from each repo with different inputs.
- **Central config repo**: a `.github` repo (special — the org's default workflows live here). Repos without their own workflows inherit from this one.

### S9. Cron schedule doesn't fire.
- Cron in GitHub Actions is best-effort — during high load runs can be delayed 15+ minutes.
- Fork's cron doesn't fire in **inactive repos** (60+ days). Push a dummy commit to reactivate.
- Timezone is **UTC only**. `0 2 * * *` = 02:00 UTC.
- Only workflows on the **default branch** are scheduled.

### S10. Workflow logs are massive — you can't find the error.
- `set -x` in a bash step prints every command. Useful during dev, remove for prod.
- Group logs: `echo "::group::My section"` … `echo "::endgroup::"`. Collapsible in the UI.
- Extract only what's needed to `$GITHUB_STEP_SUMMARY` — renders as markdown at the top of the run.
- Increase runner storage / rotate secret masks (`::add-mask::${{ secrets.FOO }}` explicitly masks values).

### S11. You need to run integration tests against a real database.
Two patterns:
- **Service containers** — GitHub Actions native:
  ```yaml
  jobs:
    test:
      runs-on: ubuntu-latest
      services:
        postgres:
          image: postgres:16
          env: { POSTGRES_PASSWORD: pw }
          ports: [5432:5432]
          options: >-
            --health-cmd "pg_isready" --health-interval 10s
  ```
  Runs alongside your job as containers. Great for Postgres/Redis/RabbitMQ.
- **Docker Compose** — `docker compose up -d` in a step. More control, more moving parts.

### S12. You accidentally committed a secret to a workflow file.
Immediate:
1. **Rotate** the credential at source (AWS key, DB password, etc.).
2. Remove the value from the file, replace with `${{ secrets.NAME }}` reference.
3. `git push` — GitHub's secret-scanning may flag it retroactively; that's fine.
4. **Assume it's compromised** — secret-scraping bots watch public commits.

Do NOT rely on `git filter-repo` — the leaked value was already visible in the run's logs API. Rotation is the only real fix.

### S13. Your matrix job creates a Docker image; you only want to push once (not once per matrix combo).
Split: one job runs the matrix build/test; a separate job (with `needs:`) builds and pushes the final image once. Or gate the push step: `if: matrix.node == '20' && matrix.os == 'ubuntu-latest'`.

### S14. Manual workflow with inputs that pick an environment.
```yaml
on:
  workflow_dispatch:
    inputs:
      environment:
        type: choice
        options: [staging, prod]
        default: staging
jobs:
  deploy:
    environment: ${{ inputs.environment }}
    ...
```
Manual dropdown in the Actions UI. Great for on-demand deploys, DR tests, one-off migrations.

### S15. Workflow succeeded but the deploy didn't actually happen.
Classic false-positive:
- `continue-on-error: true` swallowed the real failure.
- Deploy script had `|| true` at the end.
- The tool ran but exited 0 without actually doing anything (empty diff, no-op).
- Deploy targeted the wrong environment because `${{ inputs.environment }}` was blank.

Add explicit assertions:
```yaml
- run: kubectl rollout status deployment/foo --timeout=120s
- run: curl -f https://prod.example.com/version | grep ${{ github.sha }}
```
"Rollout succeeded" + "expected version is live" = actually deployed.
