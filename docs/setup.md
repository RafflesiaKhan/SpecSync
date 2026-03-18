# SpecSync Agent — Setup Guide

## Quick Start (5 Steps)

### Step 1 — Add the workflow file

Create `.github/workflows/specsync.yml` in your repository:

```yaml
name: SpecSync Agent

on:
  push:
    branches-ignore: [main, develop, staging]
  pull_request:
    types: [opened, synchronize, reopened, closed]
  repository_dispatch:
    types: [wiki-spec-updated]

jobs:
  specsync:
    name: SpecSync — Alignment Check
    if: "!contains(github.event.head_commit.message, '[specsync]')"
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: write
      pull-requests: write
      checks: write

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Run SpecSync Agent
        uses: specsync/specsync-agent@v1
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          spec-directory: '.specsync/specs'

  cleanup:
    if: |
      github.event_name == 'pull_request' &&
      github.event.action == 'closed' &&
      github.event.pull_request.merged == true
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.base.ref }}
      - name: Remove feature-alignment folder
        run: |
          if [ -d "feature-alignment" ]; then
            git config user.name "SpecSync Agent"
            git config user.email "specsync-bot@github.com"
            git rm -rf feature-alignment/
            git commit -m "[specsync] cleanup: remove alignment analysis post-merge"
            git push
          fi
```

### Step 2 — Add your Anthropic API key

Go to your repository **Settings → Secrets and variables → Actions** and add:

| Secret Name | Value |
|------------|-------|
| `ANTHROPIC_API_KEY` | Your Anthropic API key from [console.anthropic.com](https://console.anthropic.com) |

### Step 3 — Create your spec directory

```
mkdir -p .specsync/specs
```

Create a spec file using the [wiki-template.md](./wiki-template.md) format.

### Step 4 — Deploy the Wiki relay (for automatic re-evaluation)

The relay enables SpecSync to re-evaluate blocked PRs automatically when an architect updates a spec.

1. Create a [Cloudflare Workers](https://workers.cloudflare.com) account (free tier is enough)
2. Deploy `relay/cloudflare-worker.js` as a new Worker
3. Set these environment variables in the Worker:

| Variable | Value |
|---------|-------|
| `REPO_OWNER` | Your GitHub username or organization |
| `REPO_NAME` | Your repository name |
| `GITHUB_TOKEN` | A PAT with `repo` scope |
| `WEBHOOK_SECRET` | A random secret string (save it) |

4. Get the Worker URL (e.g. `https://specsync-relay.yourname.workers.dev`)

### Step 5 — Configure the Wiki webhook

1. Go to your repository **Settings → Webhooks → Add webhook**
2. Set **Payload URL** to your Cloudflare Worker URL
3. Set **Content type** to `application/json`
4. Set **Secret** to the `WEBHOOK_SECRET` you chose above
5. Select **Let me select individual events** → choose **Wiki**
6. Click **Add webhook**

---

## Configuration Options

| Input | Default | Description |
|-------|---------|-------------|
| `anthropic-api-key` | *required* | Your Anthropic API key |
| `github-token` | `${{ github.token }}` | GitHub token (auto-provided) |
| `spec-file` | *(none)* | Path to a single spec file |
| `spec-directory` | `.specsync/specs` | Directory containing spec files |
| `test-framework` | `jest` | `jest`, `vitest`, `pytest`, `mocha` |
| `test-language` | `typescript` | `typescript`, `javascript`, `python` |
| `fail-on-misalignment` | `true` | Block PR on misalignment |
| `confidence-threshold` | `70` | Minimum confidence to act (0–100) |

---

## How It Works

### On Push (no PR)

1. SpecSync parses the git diff
2. Reads the spec file(s) for the changed areas
3. Calls Claude to check alignment
4. **Aligned**: generates tests, commits to `/tests/`, posts commit comment ✅
5. **Misaligned**: writes analysis report to `/feature-alignment/`, posts commit comment ❌

### On Pull Request

Same as above, but:
- Posts a PR review comment instead of a commit comment
- Sets a PR check status (pass/fail) on the PR
- Overwrites previous analysis files on each new push

### On Wiki Spec Update

1. Architect edits a spec page in the GitHub Wiki
2. Wiki webhook fires → Cloudflare relay → `repository_dispatch`
3. SpecSync finds all open PRs that were blocked on the updated spec
4. Re-evaluates each blocked PR against the new spec
5. PRs that now pass get tests committed; PRs that still fail get updated analysis

### On PR Merge

The `/feature-alignment/` folder is automatically deleted from the base branch so main/develop stays clean.

---

## File Structure After SpecSync Runs

### Aligned Commit
```
/tests/
  unit/
    feature-name.test.ts    ← committed by SpecSync
  integration/
    feature-name.integ.ts   ← if impact radius requires it
  contract/
    feature-api.contract.ts ← if API endpoints were modified
```

### Misaligned Commit
```
/feature-alignment/
  pr-123-analysis.md        ← overwritten on each cycle
  commit-abc1234-analysis.md ← for push events without PR
```

---

## Spec File Format

See [wiki-template.md](./wiki-template.md) for the full template.

Minimum required spec:

```markdown
# Feature: Your Feature Name

## Acceptance Criteria
1. First requirement
2. Second requirement
3. Third requirement
```

---

## Access Control

See [access-control.md](./access-control.md) for the recommended access control model.
