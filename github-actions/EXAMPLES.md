# Example workflows

Copy into `.github/workflows/`. Every block here is **parse-validated YAML**.

> These are not active in this repo — there is no `.github/workflows/`
> directory, so nothing runs and no Actions minutes are used.

---

## 1. Node.js CI — the everyday one

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    strategy:
      fail-fast: false
      matrix:
        node: [18, 20, 22]
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: npm

      - run: npm ci
      - run: npm run lint
      - run: npm test -- --coverage

      - name: Upload coverage
        if: matrix.node == 20
        uses: actions/upload-artifact@v4
        with:
          name: coverage
          path: coverage/
```

`fail-fast: false` so you see failures on *all* Node versions, not just the
first. `cache: npm` in `setup-node` handles caching without a separate
`actions/cache` step.

---

## 2. Docker build and push to GHCR

```yaml
name: Docker

on:
  push:
    branches: [main]
    tags: ['v*']

permissions:
  contents: read
  packages: write          # required to push to ghcr.io

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: docker/setup-buildx-action@v3

      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}    # no PAT needed

      - name: Derive tags and labels
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/${{ github.repository }}
          tags: |
            type=ref,event=branch
            type=semver,pattern={{version}}
            type=sha,format=short

      - uses: docker/build-push-action@v6
        with:
          context: .
          push: ${{ github.event_name != 'pull_request' }}
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

`cache-from/to: type=gha` reuses Docker layers across runs — often the single
biggest speed win in a Docker pipeline. `metadata-action` produces sensible
tags automatically instead of hand-rolled `${{ github.sha }}` strings.

---

## 3. Terraform plan on PR, apply on merge

Matches [../terraform-ec2/](../terraform-ec2/).

```yaml
name: Terraform

on:
  pull_request:
    paths: ['terraform-ec2/**']
  push:
    branches: [main]
    paths: ['terraform-ec2/**']

permissions:
  contents: read
  id-token: write          # OIDC
  pull-requests: write     # to comment the plan

defaults:
  run:
    working-directory: terraform-ec2

jobs:
  terraform:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: 1.5.7

      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
          aws-region: ap-south-1

      - name: Format check
        run: terraform fmt -recursive -check -diff

      - run: terraform init

      - run: terraform validate

      - name: Plan
        id: plan
        run: terraform plan -no-color -input=false -out=tfplan

      - name: Comment plan on the PR
        if: github.event_name == 'pull_request'
        uses: actions/github-script@v7
        env:
          PLAN: ${{ steps.plan.outputs.stdout }}
        with:
          script: |
            const body = `#### Terraform Plan 📖\n\n<details><summary>Show</summary>\n\n\`\`\`\n${process.env.PLAN}\n\`\`\`\n\n</details>`;
            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: body
            });

      - name: Apply
        if: github.ref == 'refs/heads/main' && github.event_name == 'push'
        run: terraform apply -auto-approve -input=false tfplan
```

Note the plan output is passed via `env:` and read as `process.env.PLAN`,
**not** interpolated into the script — plan output can contain
attacker-influenced strings.

---

## 4. Deploy to Kubernetes

```yaml
name: Deploy to EKS

on:
  push:
    branches: [main]

permissions:
  contents: read
  id-token: write

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production      # gate with required reviewers
    steps:
      - uses: actions/checkout@v4

      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
          aws-region: ap-south-1

      - name: Update kubeconfig
        run: aws eks update-kubeconfig --name my-cluster --region ap-south-1

      - name: Deploy
        run: |
          kubectl set image deployment/my-app \
            my-app=ghcr.io/${{ github.repository }}:${{ github.sha }} \
            -n production
          kubectl rollout status deployment/my-app -n production --timeout=5m

      - name: Roll back on failure
        if: failure()
        run: kubectl rollout undo deployment/my-app -n production
```

`rollout status --timeout` is what turns "we applied a manifest" into "we
verified it actually came up", and `if: failure()` gives you an automatic
rollback.

---

## 5. Scheduled job

```yaml
name: Nightly

on:
  schedule:
    - cron: '17 3 * * *'      # 03:17 UTC — off the hour, less contention
  workflow_dispatch:           # always add this so you can test it manually

permissions:
  contents: read

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm audit --audit-level=high
```

Cron is **always UTC**. Add `workflow_dispatch` to every scheduled workflow —
otherwise you wait until tomorrow to find out it's broken. Note scheduled
workflows are **disabled after 60 days** of repository inactivity.

---

## 6. Manual deploy with inputs

```yaml
name: Manual deploy

on:
  workflow_dispatch:
    inputs:
      environment:
        description: Target environment
        required: true
        type: choice
        options: [staging, production]
      version:
        description: Version tag to deploy
        required: true
        type: string
      dry_run:
        type: boolean
        default: true

permissions:
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: ${{ inputs.environment }}
    steps:
      - uses: actions/checkout@v4
      - name: Show what we would do
        run: |
          echo "env=${{ inputs.environment }} version=${{ inputs.version }}"
      - name: Deploy for real
        if: ${{ !inputs.dry_run }}
        run: ./deploy.sh "${{ inputs.version }}"
```

---

## 7. Reusable workflow

```yaml
# .github/workflows/reusable-node-ci.yml
name: Reusable Node CI

on:
  workflow_call:
    inputs:
      node-version:
        type: string
        default: '20'
    secrets:
      npm-token:
        required: false

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ inputs.node-version }}
          cache: npm
      - run: npm ci
        env:
          NODE_AUTH_TOKEN: ${{ secrets.npm-token }}
      - run: npm test
```

```yaml
# the caller
name: CI
on: [push]
jobs:
  ci:
    uses: ./.github/workflows/reusable-node-ci.yml
    with:
      node-version: '22'
    secrets:
      npm-token: ${{ secrets.NPM_TOKEN }}
```

---

## 8. Composite action

```yaml
# .github/actions/setup-node-app/action.yml
name: Setup Node app
description: Checkout, install Node, restore cache, install deps
inputs:
  node-version:
    description: Node version to install
    required: false
    default: '20'
runs:
  using: composite
  steps:
    - uses: actions/setup-node@v4
      with:
        node-version: ${{ inputs.node-version }}
        cache: npm
    - run: npm ci
      shell: bash          # MANDATORY in composite actions
```

```yaml
# using it
steps:
  - uses: actions/checkout@v4
  - uses: ./.github/actions/setup-node-app
    with:
      node-version: '22'
  - run: npm test
```

---

## 9. Caching beyond the language helpers

```yaml
- uses: actions/cache@v4
  id: cache
  with:
    path: |
      ~/.cache/pip
      ~/.local/share/virtualenvs
    key: ${{ runner.os }}-py-${{ hashFiles('**/requirements.txt') }}
    restore-keys: |
      ${{ runner.os }}-py-

- name: Install only on a cache miss
  if: steps.cache.outputs.cache-hit != 'true'
  run: pip install -r requirements.txt
```

`key` is exact; `restore-keys` are prefixes tried on a miss, so you get a
*partial* cache instead of nothing. **Caches are immutable** — a key that
already exists is never overwritten, which is why the key must include a hash
of the dependency file.

---

## 10. Dynamic matrix from a previous job

```yaml
jobs:
  discover:
    runs-on: ubuntu-latest
    outputs:
      dirs: ${{ steps.find.outputs.dirs }}
    steps:
      - uses: actions/checkout@v4
      - id: find
        run: |
          DIRS=$(ls -d services/*/ | jq -R -s -c 'split("\n")[:-1]')
          echo "dirs=$DIRS" >> "$GITHUB_OUTPUT"

  build:
    needs: discover
    runs-on: ubuntu-latest
    strategy:
      matrix:
        dir: ${{ fromJSON(needs.discover.outputs.dirs) }}
    steps:
      - uses: actions/checkout@v4
      - run: echo "building ${{ matrix.dir }}"
```

The pattern for monorepos: discover what changed, then fan out over it.

---

## 11. PR comment with a job summary

```yaml
- name: Write a summary
  run: |
    {
      echo "## Build report"
      echo ""
      echo "| Item | Value |"
      echo "|---|---|"
      echo "| Commit | \`${GITHUB_SHA:0:7}\` |"
      echo "| Branch | \`${GITHUB_REF_NAME}\` |"
      echo "| Runner | ${RUNNER_OS} |"
    } >> "$GITHUB_STEP_SUMMARY"
```

Renders as Markdown on the run page — much nicer than digging through logs.
