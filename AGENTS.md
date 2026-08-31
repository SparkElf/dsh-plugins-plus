# AGENTS.md

## Managed DataOps Authorization

- Prefer security mechanisms to defensive orchestration: identify the real trust boundary and one authoritative mechanism, validate once at that boundary, let internal code rely on it, and add another mechanism only for a distinct attacker, trust domain, authority, or revocation contract.
- DataOps-managed DSH belongs to the DataOps trust domain and receives the current DataOps JWT as its single identity and authorization credential. JWT expiry may reject a new DataOps request but never cancels an accepted Agent turn, closes its observation stream, or restarts/removes its container.
- The JWT identifies the current DataOps user and session. DataOps AuthGuard, PermissionGuard, and resource services resolve and enforce current roles and grants; plugins, browser gateways, sidecars, and companion processes must not replicate that policy.
- Standalone DataOps integration crosses a distinct trust boundary and may use OAuth 2.0/OIDC with a narrower credential. Do not apply standalone authentication machinery to managed profiles.
- Prefer deleting redundant credential and lifecycle code. Add a derived credential only when an approved threat model establishes a separate trust domain.
