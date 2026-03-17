# SpecSync — Access Control Model

## Principle

The spec is the architect's domain. Developers can read it but cannot change it.
SpecSync enforces this by operating at the boundary between code and spec.

## Role Matrix

| Role | Code Repo | GitHub Wiki | SpecSync Output |
|------|-----------|-------------|-----------------|
| **Architect** | Read + Write (all branches) + Merge to main | Read + Write | Receives misalignment notifications |
| **Product Manager** | Read only | Read + Write | — |
| **QA Lead** | Read only | Read + Write | Acceptance criteria → test cases |
| **Developer** | Read + Write (feature branches only) | Read only | Receives inline feedback on PRs |
| **SpecSync Bot** | Write to feature branches only (tests + analysis) | Read always | — |

## GitHub Wiki Configuration

To enforce architect-only write access to the wiki:

1. Go to **Repository Settings → Wikis**
2. Ensure **"Allow contributors to edit pages"** is **disabled**
3. Add architects, PMs, and QA leads as repository **Collaborators** with **Write** access
4. Developers get **Read** access (or no collaborator role on private repos)

Effect:
- Collaborators with Write access can edit wiki pages directly in the UI
- Developers and external contributors can read the wiki but cannot edit

## SpecSync Bot Permissions

SpecSync uses the built-in `GITHUB_TOKEN` which is scoped to the running workflow.

The token receives these permissions (configured in the workflow file):

```yaml
permissions:
  contents: write        # write test files + analysis files to feature branches
  pull-requests: write   # post PR comments and reviews
  checks: write          # set check run pass/fail status
```

**SpecSync cannot push to `main` or `develop`** because the workflow is only triggered on feature branches.

## Option B — Wiki Update via PR

When a developer believes the spec is wrong or outdated, they should NOT edit the wiki directly.

Instead, the process is:

1. Developer raises the issue with the architect or PM
2. Architect/PM updates the wiki spec page directly, OR
3. Developer opens a spec change request (tracked as a GitHub Issue), OR
4. SpecSync (future feature) can open a PR against the wiki's git repo with a suggested spec update

The wiki is the architect's source of truth. Changes to it go through human review — not automatic overwrites.

## Bot Identity

For production use, replace `GITHUB_TOKEN` with a dedicated **GitHub App** token:

1. Create a GitHub App with minimum permissions:
   - Repository: Contents (Read + Write)
   - Pull Requests (Read + Write)
   - Checks (Write)
   - Issues (Read + Write)

2. Install the app on your repository
3. Store the app's private key as `SPECSYNC_APP_PRIVATE_KEY` in GitHub Secrets
4. Use the `actions/create-github-app-token` action to generate a per-run token

This gives SpecSync its own identity in the git history and PR comments, making its activity clearly attributable and auditable.
