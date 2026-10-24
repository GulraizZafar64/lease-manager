# Security

## Controls in the software (all enforced on the server, covered by tests)
| Area | Control |
|---|---|
| Passwords | scrypt hashing (salted, memory-hard); 12+ characters, no common words or own name; forced change of temporary passwords; other sessions signed out on change |
| Multi-factor authentication | Time-based one-time codes (RFC 6238, authenticator apps); required by default (`REQUIRE_MFA=true`; `false` switches the code step off for everyone, company users and the platform owner, keeping the keys already set up so switching it back on asks for codes from the same apps; do not run production with it off); each code usable once; secrets encrypted with AES-256-GCM using `MASTER_KEY` |
| Brute force | Lock after 5 failures (password or code) for 15 minutes; identical message for unknown user, wrong password and locked account; constant-time checks |
| Sessions | Random 256-bit tokens, only their SHA-256 stored; HttpOnly, Secure, SameSite=Strict cookies; 10-hour limit and 30-minute idle timeout; "keep me signed in" off gives a cookie that ends with the browser; a disabled user's or deactivated company's sessions stop at once (and are not revived on re-enabling); a new role or email, a password reset or an MFA reset signs the person out; the client is told why a session ended |
| Request forgery | Custom header required on every change; strict content security policy; no cross-origin access |
| Access control | 7 built-in roles plus custom roles per company, 18 permissions, extra permissions per user; checked on every route against the company's current role definitions; only super administrators change roles, and the super administrator role always has every permission; entity restrictions (other entities' records answer "not found"); only super administrators manage super administrators; the last one cannot be removed; nobody can change their own role or permissions |
| Companies (SaaS) | Every row carries its company; every query is limited to the signed-in user's company; other companies' records answer "not found"; the platform owner has separate accounts, sessions and cookie, and a company session cannot open the platform console |
| Maker-checker | Approval tiers by amount in base currency; distinct approvers; the submitter cannot approve; approval limits per user; approved leases cannot be edited, only remeasured or modified through approved events. Payment batches and AI-drafted disclosures follow the same rules; batches go for approval only when every payee has valid bank details, and each bank file release is logged. A restore from a backup never brings approvals back: approved batches and final drafts need approving again, and restored released batches cannot produce a bank file |
| Period close | Locked periods block back-dated changes and payments; overrides need a permission and are logged |
| Audit | Every sign-in, change, approval, setting, user and role change, and platform action is logged with user, role, IP and before/after values; the database rejects edits and deletes, except retention purges of entries older than the company's retention period, which are themselves logged; a hash chain detects tampering even by a database administrator. The web app can add only the few actions the server cannot see (report exports, AI requests, screen locks); everything else is recorded by the server itself |
| Data export | The company export (backups) needs the data permission, is logged, and contains no password hashes or sign-in secrets; encrypted backups are encrypted in the browser with the person's passphrase, which is never sent |
| Data integrity | Full version history of every lease; optimistic locking prevents lost updates; transactions throughout |
| Errors | No internal details returned to users; secrets and passwords redacted from logs |

## What your IT team must do
1. Restrict server access (SSH/RDP) to administrators; patch the OS monthly.
2. Use a certificate from your internal CA; allow port 443 only.
3. Keep `MASTER_KEY`, the database password and the backup passphrase in a password vault, separately from backups.
4. Run backups, copy them off-site, and test restores quarterly.
5. Forward application logs to your monitoring (SIEM) if you have one.
6. Commission an independent penetration test before go-live.

## Planned hardening (next releases)
Separate database roles for migrations and runtime; single sign-on (Microsoft Entra ID / OpenID Connect); configurable password expiry; per-IP rate limiting at the proxy; signed release bundles.

## Reporting a vulnerability
Contact the system owner. Do not test against production without written permission.
