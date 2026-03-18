# SpecSync Spec Directory

This directory contains feature specification files used by SpecSync Agent to validate code alignment.

## Adding a New Spec

1. Copy `docs/wiki-template.md` to `.specsync/specs/feature-<name>.md`
2. Fill in the feature details following the template structure
3. Commit the spec file before (or alongside) the feature implementation

## File Naming Convention

`feature-<feature-name>.md` — e.g.:
- `feature-auth.md`
- `feature-payments.md`
- `feature-dashboard.md`

## Spec Matching

SpecSync matches spec files to changed code files by looking for common keywords in file paths and spec titles.

For example, `feature-auth.md` will be matched to changes in:
- `src/auth/login.service.ts`
- `src/controllers/auth.controller.ts`
- `tests/auth.test.ts`

## Access

Only architects, PMs, and QA leads should modify files in this directory.
Developers should read specs but raise change requests through the architect rather than editing directly.
