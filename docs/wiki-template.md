# Feature: [Feature Name]
**Status:** active
**Version:** 1.0
**Owner:** @architect-username
**Last Updated:** YYYY-MM-DD

## Objective
[One or two sentences describing what this feature does and why it exists.]

## Acceptance Criteria
1. [First acceptance criterion — what the feature must do]
2. [Second acceptance criterion]
3. [Third acceptance criterion]
4. [Add as many as needed]

## Out of Scope
- [Thing that is explicitly NOT part of this feature]
- [Another out-of-scope item — prevents scope creep]

## Edge Cases
- [Edge case 1 — unusual input or state the feature must handle]
- [Edge case 2]
- [Edge case 3]

## Integrations
- Called by: ServiceA, ServiceB, ComponentC
- Calls: RepositoryX, ServiceY, ExternalAPIZ
- Exposes: POST /api/endpoint, GET /api/resource

## API Contract
### POST /api/endpoint
Input:  { field1: string, field2: number }
Output: { result: string, id: string }
Errors:
  400 — invalid input
  401 — not authenticated
  404 — resource not found
  422 — business rule violation

### GET /api/resource/:id
Input:  path param: id (string)
Output: { id: string, data: object, createdAt: string }
Errors:
  401 — not authenticated
  404 — not found
