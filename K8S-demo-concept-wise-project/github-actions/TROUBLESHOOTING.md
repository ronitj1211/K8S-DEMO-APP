# Troubleshooting — Issues You'll Hit While Developing GitHub Actions Pipelines

Organized by symptom. Each entry: **what you see**, **root cause**, **fix**.

Debug toggles you'll want on the whole time:
```
Repo → Settings → Secrets and variables → Actions → New repository secret
  ACTIONS_STEP_DEBUG   = true
  ACTIONS_RUNNER_DEBUG = true
```
These reveal verbose step lifecycle and runner internals in re-runs.

---

## 1. Workflow doesn't trigger at all

### Symptoms
Push a commit, no run appears in the Actions tab.

### Causes & fixes
- **File not in `.github/workflows/`** — must be exactly there, at the repo root.
- **YAML syntax error** — GitHub silently skips invalid files. Validate:
  - Paste into [actionlint online](https://rhysd.github.io/actionlint/), or install `actionlint` locally.
  - VS Code + "GitHub Actions" extension underlines errors as you type.
- **`on:` doesn't match your event** — e.g. `on: push: branches: [main]` but you pushed to `feature/x`.
- **`paths:` filter excludes your changed files** — check the filter's globs.
- **Workflow is on a non-default branch and uses `schedule`** — cron only fires from the default branch.
- **Actions disabled** — repo Settings → Actions → General → make sure "Allow all actions" or your policy allows it.
- **First workflow in a fork of another repo** — GitHub requires the fork owner to explicitly enable Actions.

Diagnose fast: **Actions tab → left sidebar shows all workflows**. If yours isn't listed at all → parse error or wrong path. If it's listed but greyed with "0 runs" → the `on:` never matched.

---

## 2. `Permission denied` or 403 from the API

### Symptoms
```
Error: Resource not accessible by integration
```
or `Error: The requested URL returned error: 403`.

### Causes & fixes
- **`GITHUB_TOKEN` doesn't have write permission** for that resource. Default token is read-only. Grant it explicitly:
  ```yaml
  permissions:
    contents: write        # for pushing tags / creating releases
    packages: write        # for ghcr.io push
    pull-requests: write   # for commenting on PRs
    id-token: write        # for OIDC
  ```
  Put it at workflow or job level.
- **Repo settings restrict GITHUB_TOKEN** globally — Settings → Actions → General → Workflow permissions → "Read and write permissions" (or per-workflow with the block above).
- **Fork PR** — `GITHUB_TOKEN` is read-only for security. See [S7 in INTERVIEW.md](INTERVIEW.md#s7-secrets.my_key--is-empty-in-a-fork-pr).
- **Wrong token** — some APIs require a PAT (personal access token) with broader scope than `GITHUB_TOKEN`. Store it as a secret; use `${{ secrets.PAT }}` instead.

---

## 3. Secret is empty / masked / not resolving

### Symptoms
- `${{ secrets.MY_SECRET }}` prints as `***` or empty.
- Downstream tool complains it received an empty value.

### Causes & fixes
- **`***` in logs is normal** — GitHub auto-masks secrets. The value IS there; it's only masked when printed. Verify with `- run: echo "${#MY_SECRET}"` (prints length).
- **Fork PR** — secrets aren't exposed. Restructure to run secret-using jobs only on `push` to main.
- **Environment secret not accessible** — jobs must declare `environment: <name>` to see that environment's secrets. Adding it also enables protection rules.
- **Case-sensitive name mismatch** — `secrets.API_KEY` ≠ `secrets.api_key`. Case matters.
- **Reusable workflow doesn't inherit secrets** — you must pass them explicitly:
  ```yaml
  uses: ./.github/workflows/deploy.yml
  secrets:
    KUBE_TOKEN: ${{ secrets.KUBE_TOKEN }}
    # or: secrets: inherit (all secrets forwarded)
  ```

---

## 4. Action not found / version pinning issue

### Symptoms
```
Error: Unable to resolve action `actions/checkout@main`, unable to find version `main`
```
or `Error: 404`.

### Causes & fixes
- **Typo in `uses:`** — `actions/checkout` (with s), not `action/checkout`.
- **Version doesn't exist** — `@v5` where the latest is `v4`. Check the action's repo README.
- **Third-party action deleted** or renamed — pin by commit SHA to avoid future breakage:
  ```yaml
  uses: some/action@a5ac7e51b41094c92402da3b24376905380afc29  # v3.1.0
  ```
- **Private action** — the workflow needs a token that can read the action's repo (usually a PAT stored as `secrets.CI_TOKEN` and used via `actions/checkout` for a specific path).

---

## 5. Docker build fails with "no space left on device"

### Symptoms
```
ERROR: failed to solve: failed to prepare ...: no space left on device
```

### Causes & fixes
- **Runner has ~14 GB free by default** — big Docker builds run out.
- **Free up space** before the build:
  ```yaml
  - name: Free disk space
    uses: jlumbroso/free-disk-space@main
    with:
      android: true; dotnet: true; haskell: true; large-packages: true; docker-images: true; swap-storage: true
  ```
  Reclaims ~20 GB by removing pre-installed toolchains you don't need.
- **BuildKit cache growing** — mount as remote cache (registry / GHA cache) instead of local:
  ```yaml
  - uses: docker/build-push-action@v5
    with:
      cache-from: type=gha
      cache-to: type=gha,mode=max
  ```
- **Larger runner** — pay for the 16-core / 32 GB SKU when needed.

---

## 6. Docker `login` succeeds but `push` fails with 403

### Symptoms
```
denied: permission_denied: The token provided does not match ...
```

### Causes & fixes
- **`permissions.packages: write` missing** — set it on the job.
- **Package doesn't grant this repo access** — GitHub → Package settings → Manage Actions access → add this repo.
- **Wrong registry** — you logged in to `docker.io` but tagged for `ghcr.io` (or vice versa).
- **Image name doesn't match owner** — `ghcr.io/OWNER/name`. `OWNER` must be your user or org, lowercase. `github.repository` gives `owner/repo`; use `github.repository_owner` alone if you want just the owner.

---

## 7. `kubectl apply` fails from CI

### Symptoms
- `error: You must be logged in to the server (Unauthorized)`
- `Unable to connect to the server: dial tcp: lookup foo.bar: no such host`

### Causes & fixes
- **kubeconfig missing** — you didn't set `KUBECONFIG` env or write the file. Common pattern:
  ```yaml
  - run: |
      mkdir -p ~/.kube
      echo "$KUBE_CONFIG" | base64 -d > ~/.kube/config
    env:
      KUBE_CONFIG: ${{ secrets.KUBE_CONFIG_B64 }}
  ```
  Or use `azure/k8s-set-context`, `aws-actions/eks-configure-credentials`.
- **Runner can't reach the K8s API** — private cluster / VPC. Solution: self-hosted runner inside the VPC, or a bastion / VPN, or expose the API publicly (bad).
- **Cert expired** in the kubeconfig — rotate.
- **Missing RBAC on the token/user** — hit `kubectl auth can-i --list` in a debug step to check.

---

## 8. Pipeline works locally with `act`, fails on GitHub

### Causes & fixes
- **`act` doesn't emulate everything** — service containers, some outputs, `GITHUB_TOKEN` scopes differ.
- **Environment vars** — `act` reads `.env`; GitHub uses secrets/vars. Different.
- **Docker-in-Docker** — GitHub runners have Docker; `act` uses Docker on the host. Behaviors differ under load.
- **Runner OS mismatch** — `act` defaults to `catthehacker/ubuntu:act-latest` — smaller than GitHub-hosted. Some tools aren't there.

Use `act` for **iteration speed**, not final validation. Always push a branch and let GitHub actually run it.

---

## 9. Cache hits are inconsistent

### Symptoms
Same lockfile, same commit — sometimes cache hits, sometimes misses.

### Causes & fixes
- **`key` includes something volatile** — e.g. `${{ github.run_id }}` (unique per run) means always miss. Use file hashes: `${{ hashFiles('package-lock.json') }}`.
- **10 GB per-repo cache limit** — LRU eviction; older caches get purged silently.
- **Cache scope is per-branch** — main branch's cache is shared with descendants, but not cross-branch. Fork PRs can't read the base's cache.
- **`restore-keys:` order matters** — put most specific first, fallbacks later.

Verify cache save/restore in the log — the cache step prints "Cache saved with key X" or "Cache restored from key X".

---

## 10. Matrix job runs sequentially instead of parallel

### Symptoms
6 matrix combinations, but only 1 runs at a time.

### Causes & fixes
- **Concurrency group limits it** — `cancel-in-progress: true` on a broad group serializes everything. Narrow the group or remove it.
- **GitHub-hosted runner quota reached** — orgs on lower plans have concurrent-job limits. Upgrade or use self-hosted.
- **Self-hosted runner labels only match one runner** — you have 6 jobs but only 1 machine with the required label.
- **`strategy.max-parallel: 1`** — someone set it. Remove or bump.

---

## 11. Steps you added don't appear / old steps still run

### Symptoms
Push a change to the workflow YAML; the actual run uses an older version.

### Causes & fixes
- **`pull_request` uses the PR's checkout of the workflow file** — not the base's. So editing `.github/workflows/x.yml` in a PR does affect the PR's CI. But **`workflow_dispatch`** always uses the version from the branch you selected in the dropdown.
- **Cache-of-worklflow-YAML is fine** — GitHub reads the file fresh every trigger. If steps are wrong, it's your file or `if:` gates.
- **Wrong workflow file** — you have two files with the same `name:`. Add distinguishing prefixes in the file names.

---

## 12. Test framework "passes" but exits 0 despite failures

### Symptoms
Log shows red X marks; step is green.

### Causes & fixes
- **`continue-on-error: true`** on that step swallows failures. Remove unless intentional.
- **`|| true`** at the end of a pipe swallows the exit code. Remove.
- **Shell doesn't propagate pipe failures** — `set -o pipefail` at the top of a bash step:
  ```yaml
  - run: |
      set -euxo pipefail
      npm test | tee test.log
  ```
- **Test runner is misconfigured** — some CLIs exit 0 even on failures (looking at you, older `pytest` invocations). Use `pytest --exitfirst` / `jest --forceExit` variants that fail loud.

---

## 13. Timeouts

### Symptoms
`Error: The operation was canceled` after exactly 360 minutes (default job timeout).

### Causes & fixes
- **Default job timeout is 6 hours.** Override: `jobs.<job>.timeout-minutes: 30`.
- **Default step timeout is unlimited.** Set per step: `- run: ...; timeout-minutes: 5`.
- **A step is hanging** — usually waiting on `stdin`, or a health check that never becomes true. Add explicit timeouts on curl/wget/etc.: `curl --max-time 30`.

---

## 14. Environment variables not visible in later steps

### Symptoms
```yaml
- run: export FOO=bar
- run: echo $FOO       # empty
```

### Cause & fix
Each `run:` is a new shell. `export` doesn't persist. Use `$GITHUB_ENV`:
```yaml
- run: echo "FOO=bar" >> $GITHUB_ENV
- run: echo $FOO       # "bar"
```
For step outputs (which cross both step and job boundaries):
```yaml
- id: mystep
  run: echo "foo=bar" >> $GITHUB_OUTPUT
- run: echo "${{ steps.mystep.outputs.foo }}"
```

---

## 15. YAML `!` reserved character / expressions not evaluating

### Symptoms
- `Error: while scanning for the next token found character '!' that cannot start any token`
- `${{ github.foo.bar }}` shows up literally in logs.

### Causes & fixes
- YAML reserves `!` (tags), `@`, `%`, `&`, `*`, `?`, `|`, `>`, plus some in specific positions. Quote strings containing them:
  ```yaml
  # bad
  run: !important
  # good
  run: '!important'
  ```
- Expression not evaluating — the outer context is a **string context**, and you used a bare token. Wrap in `${{ }}`:
  ```yaml
  # bad
  if: github.ref == 'refs/heads/main'
  # good (both valid, but the second is unambiguous)
  if: ${{ github.ref == 'refs/heads/main' }}
  ```

---

## 16. Self-hosted runner offline / not picking jobs

### Symptoms
Job queued, no runner starts working. `gh workflow list-runners` shows offline.

### Causes & fixes
- **Runner service crashed** — SSH to the machine; `sudo systemctl status actions.runner.<repo>.<name>` or run `./run.sh` in the runner directory.
- **Network** — runner needs outbound HTTPS to `github.com`, `api.github.com`, `codeload.github.com`. Proxy config missing.
- **Labels don't match** — `runs-on: [self-hosted, gpu]` but no runner has the `gpu` label. Add via runner settings or re-register.
- **Runner token expired** — re-register: `./config.sh remove` then `./config.sh --url ... --token ...`.
- **Runner version out of date** — GitHub deprecates versions after ~1 year. Auto-update or manually upgrade.

---

## 17. Reusable workflow / composite action fails to load

### Symptoms
```
Error: Unable to resolve action `./.github/workflows/deploy.yml`, unable to find version
```

### Causes & fixes
- **Reusable workflow needs `on: workflow_call:`** — a top-level trigger. Without it, the file can't be called.
- **Path** — `uses: ./.github/workflows/deploy.yml` (relative) works only for workflows in the same repo. Cross-repo: `uses: owner/repo/.github/workflows/deploy.yml@main`.
- **Composite action** needs `action.yml` in a directory; `uses: ./actions/foo` looks for `./actions/foo/action.yml`.
- **Version pin** — you referenced `@v1` but no tag / release / branch exists at that name.

---

## 18. Workflow triggers itself in an infinite loop

### Symptoms
Your workflow commits a file (`git commit && git push`) → the push re-triggers the workflow → …

### Causes & fixes
- **Use a bot user token / GITHUB_TOKEN** — pushes made by `GITHUB_TOKEN` do NOT trigger further workflows by default. Good side effect: prevents loops.
- **If you must trigger downstream workflows**, use a PAT with `workflow` scope explicitly.
- **Exclude by actor** in the workflow itself:
  ```yaml
  if: github.actor != 'github-actions[bot]'
  ```

---

## 19. `docker/build-push-action` builds twice / cache doesn't work

### Symptoms
Every push rebuilds the same layers.

### Causes & fixes
- **No cache configured**. Default is no cache. Add:
  ```yaml
  cache-from: type=gha
  cache-to: type=gha,mode=max
  ```
  Uses GitHub's built-in cache. `mode=max` includes intermediate layers.
- **Multi-arch builds** — `platforms: linux/amd64,linux/arm64` builds each independently. Multiplies work. Only enable arm64 if you actually need it.
- **`no-cache: true`** — forces rebuild. Remove.
- **BuildKit not enabled** — the `docker/setup-buildx-action` sets it up. Include it.

---

## 20. `actions/checkout` checks out the wrong ref

### Symptoms
- `pull_request` event checks out a merge commit that doesn't match your PR branch's HEAD.
- Your `git log` shows a commit that isn't in either branch.

### Causes & fixes
- **This is normal** — `pull_request` checks out `refs/pull/N/merge`, a synthetic merge of PR head into base. That's what tests should run against.
- To check out the PR's actual HEAD: `ref: ${{ github.event.pull_request.head.sha }}`.
- **`workflow_dispatch`** checks out the branch you selected in the dropdown.
- **Push to tag** — checks out the tag ref, not a branch. If you need branch context (unusual), you'll have to look it up via API.

---

## 21. Secret rotation broke old runs / how to redo

### Situation
You rotated a token; old workflow runs now can't be re-run with the same value.

### Fix
Just re-run in the UI — GitHub reads the current secret at execution time (not stored with the historical run). If your run failed BECAUSE of the old secret, rotate again and re-run.

If you need to reproduce with the exact old value (forensics): you can't. Design workflows to be idempotent — same run, re-executed with fresh secrets, produces the same result.

---

## 22. Storage / artifacts / logs are missing

### Symptoms
- Download artifact link says "expired".
- Logs of an old run are gone.

### Causes & fixes
- **Artifacts default 90-day retention** — override with `retention-days: N` (max 400 for public repos).
- **Logs retention: 90 days** for private repos (organizational setting can be higher).
- **Repo storage quota exceeded** — Settings → Storage. Delete old artifacts or bump the plan.

---

## 23. GHCR image `docker pull` fails with `unauthorized`

### Symptoms
```
Error response from daemon: Head "https://ghcr.io/v2/...": unauthorized
```

### Causes & fixes
- **Public image, unauthenticated pull needs the correct manifest media type** — usually fine, but some client versions of Docker have bugs. Upgrade Docker.
- **Private image** — you need `docker login ghcr.io` with a PAT that has `read:packages`.
- **Package visibility** — Package settings → Change visibility to Public if that's your intent.

---

## Quick reference — commands / tricks

| Situation | Command / trick |
|---|---|
| Local dry-run a workflow | `act -j <job-name>` (needs Docker) |
| Validate syntax | `actionlint .github/workflows/*.yml` |
| SSH into a runner mid-run | `- uses: mxschmitt/action-tmate@v3` (add before failing step) |
| See all context values | `- run: echo "${{ toJSON(github) }}"` |
| Print env safely | `- run: printenv \| grep -v -i secret \| sort` |
| Force cache miss | Change any character in `key:` |
| Cancel current workflow | Actions UI → Cancel workflow (top-right of run) |
| List runners | `gh workflow list-runners` |
| Re-run failed jobs only | Actions UI → Re-run failed jobs |
| Debug logs | Set repo secret `ACTIONS_STEP_DEBUG=true` + re-run |
| Mask a computed value | `echo "::add-mask::$MY_TOKEN"` |
| Group log output | `echo "::group::title"` … `echo "::endgroup::"` |
| Fail a step manually | `echo "::error file=x.js,line=10::something broke"` + `exit 1` |
| Write to summary | `echo "# my report" >> $GITHUB_STEP_SUMMARY` |
