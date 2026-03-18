# Feature: User Authentication
**Status:** active
**Version:** 2.1
**Owner:** @arch-sarah
**Last Updated:** 2026-03-10

## Objective
Allow users to authenticate securely with email and password.
Sessions are managed via JWT with refresh token rotation.

## Acceptance Criteria
1. User can log in with a valid email and password
2. Failed login after 5 attempts locks account for 15 minutes
3. Locked accounts return HTTP 423 with Retry-After header
4. JWT access token expires after 24 hours
5. Refresh token is valid for 30 days and rotates on use
6. Logout invalidates the refresh token immediately

## Out of Scope
- OAuth / social login → tracked in Feature-Social-Auth
- Biometric authentication → not in current roadmap
- SSO / SAML → Enterprise tier only

## Edge Cases
- Login attempt with empty password field
- Email with subaddressing (user+tag@domain.com)
- Concurrent login from two different devices
- Login attempt on a deleted account

## Integrations
- Called by: AuthController, DashboardService, AdminPanel
- Calls: UserRepository, TokenService, AuditLogger, EmailService
- Exposes: POST /auth/login, POST /auth/refresh, DELETE /auth/logout

## API Contract
### POST /auth/login
Input:  { email: string, password: string }
Output: { accessToken: string, refreshToken: string, expiresIn: number }
Errors:
  401 — invalid credentials
  423 — account locked (includes Retry-After header)
  429 — rate limited

### POST /auth/refresh
Input:  { refreshToken: string }
Output: { accessToken: string, refreshToken: string, expiresIn: number }
Errors:
  401 — refresh token invalid or expired
  403 — refresh token already used (rotation violation)

### DELETE /auth/logout
Input:  Authorization header (Bearer token)
Output: 204 No Content
Errors:
  401 — not authenticated
