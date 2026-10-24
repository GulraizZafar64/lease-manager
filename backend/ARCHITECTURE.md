# Architecture

## Overview
```
 Users (browser, later offline app)
        │ HTTPS 443
   ┌────▼─────┐      ┌───────────────────────────┐      ┌──────────────┐
   │  Caddy   │─────▶│ Application (Node.js)      │─────▶│ PostgreSQL 16│
   │  TLS     │      │ API, auth, RBAC, approvals │      │ data, audit  │
   └──────────┘      │ IFRS 16 engine             │      └──────────────┘
                     └───────────────────────────┘
```
One installation serves any number of companies (SaaS), each with any number of legal entities. Companies share one database; every company row carries a `company_id`, every query is limited to the signed-in user's company, and composite keys stop rows from mixing companies. Only the proxy is reachable from the network.

## Design decisions
| Decision | Reason |
|---|---|
| Node.js, plain JavaScript (ES modules) | Shares the IFRS 16 engine unchanged with the browser and offline app; no build step for on-premises installs |
| PostgreSQL | Transactions, row locking for approvals, JSONB for evolving lease terms, mature backup tooling |
| Engine recalculates from terms and approved events | Balances are always derived, never stored, so they cannot drift; any date's position can be reproduced |
| Leases editable only before approval | After commencement IFRS 16 requires remeasurement or modification (16.39-46), each with its own rate rule |
| Few dependencies (Fastify, pg, zod, cookie, helmet) | Smaller attack surface; easier security review |
| Engine validation gate at start-up | A broken engine cannot serve figures |

## Data model
| Table | Holds |
|---|---|
| `companies` | Customer companies: code, name, base currency, active/inactive |
| `platform_admins`, `platform_sessions` | The SaaS operator's own accounts (platform console) |
| `entities` | Legal entities, functional currency, parent |
| `users`, `user_entities`, `sessions` | Accounts (email unique per company among users not deleted; the same person may belong to several companies), job title, extra permissions on top of the role, last sign-in, deletion date; entity access; sessions |
| `leases`, `lease_versions` | Current lease (terms in JSONB), every saved version |
| `lease_events` | Remeasurements, modifications, terminations, impairments with status |
| `approvals` | Each approval decision, role and amount |
| `payments` | Scheduled and variable payments, bank references, the bank line a payment was matched to |
| `bank_statements`, `bank_lines` | Imported statements; each line with its fingerprint (lines seen in an earlier statement are marked as duplicates), status (unmatched, suggested, matched, not lease-related) and match |
| `payment_batches` | Batches of lease payments: currency, value date, paying account, lines, total, status (draft, awaiting approval, approved, released, rejected); their approvals are in `approvals`. Batches restored from a backup are marked and cannot produce a bank file |
| `erp_exports` | ERP journal files generated: target system, period, entry keys (for leaving out entries already sent), status (awaiting confirmation, posted, failed) and notes |
| `ai_drafts` | AI-drafted disclosures with a version; their approvals are in `approvals` by version, so an edit needs approving again |
| `roles` | Per company: built-in roles whose permissions were changed, and custom roles (no row: the built-in default; the super administrator always has every permission) |
| `fx_rates` | Dated rates to the base currency |
| `settings` | Approval policy (approvers: any of the company's roles with the approve permission), period lock, base currency, rate convention, segregation; everything else the web app saves (accounts, display, thresholds, bank accounts, ERP options, retention, current rates) under `workspace` |
| `browser_audit` | Audit entries a company recorded in the browser-only app, kept as an archive when its data was brought over (outside the hash chain; each batch brought in is fingerprinted in it) |
| `audit_log` | Append-only, hash-chained activity log: one chain per company, plus one for the platform |

## API (all under /api, JSON)
| Area | Endpoints |
|---|---|
| Sign-in | `POST auth/login` (optional `companyId`; `remember: false` gives a browser-session cookie), `auth/mfa/setup`, `auth/mfa/verify`, `auth/password`, `auth/logout`, `GET auth/me` (user, company, permissions), `GET auth/companies` (the person's other companies, for Switch company) |
| Users | `GET/POST users` (name, email, title, role, entities, approval limit, extra permissions; a new user's temporary password is returned once), `PATCH users/:id`, `DELETE users/:id` (keeps the row for history; the email can be reused), `POST users/:id/reset-password`, `users/:id/reset-mfa`, `users/:id/unlock` |
| Roles | `GET roles` (everyone signed in), `POST roles` (custom role), `PUT roles/:id` (permissions; name and description of a custom role), `POST roles/:id/reset` (built-in back to its default), `DELETE roles/:id` (custom, unused); changes need a super administrator and apply on the next request |
| Organisation | `GET/POST entities`, `PATCH/DELETE entities/:id` (no loops; delete only when unused), `GET/PATCH company-settings` (every company-wide setting the web app uses; only the fields sent change; most need admin.settings, ERP options gl.export, retention admin.data), `GET settings`, `PUT settings/:key`, `GET/POST fx-rates`, `POST fx-rates/remove` |
| Leases | `GET/POST leases` (`?full=1`: each lease with its changes, payments, approvals and history, as the web app uses it), `GET/PUT/DELETE leases/:id`, `PATCH leases/:id/details` (descriptive fields at any stage), `GET leases/:id/schedule`, `leases/:id/history`, `POST leases/:id/submit` (activates at once when the company does not require approval), `/approve`, `/reject`, `POST leases/import` (sample portfolio, backups, browser data: leases as they are; data managers only; `check: true` reports each lease as new, already here or its problem, and changes nothing). Drafts may be incomplete; submitting checks them |
| Changes | `POST leases/:id/events` (a separate-lease modification is recorded at once), `POST events/:id/approve`, `events/:id/reject` |
| Payments | `POST leases/:id/payments` |
| Bank reconciliation | `GET/POST bank/statements` (lines fingerprinted on the server), `DELETE bank/statements/:id` (recorded payments stay), `PATCH bank/statements/:id/lines` (suggestions, not lease-related), `POST bank/match` (one or many lines; each records the payment, or links the line to one already recorded, and is accepted or refused on its own), `POST bank/lines/:id/unmatch` (the payment stays) |
| Payment batches | `GET/POST batches` (one batch per payment and currency), `DELETE batches/:id` (drafts), `POST batches/:id/submit` (every payee needs valid bank details), `/approve` (approval tiers, limits and segregation as for leases, sized in the base currency on the value date), `/reject`, `/release` (each bank file download is recorded) |
| ERP files | `GET/POST erp-exports`, `POST erp-exports/:id/mark` (posted or failed, once) |
| AI drafts | `GET/POST ai-drafts`, `PUT ai-drafts/:id` (text; approvals needed again), `POST ai-drafts/:id/approve` (no TO CONFIRM items left; not by the last editor), `DELETE ai-drafts/:id` |
| Company data | `GET company-export` (everything as the web app holds it, plus users without secrets and the audit log; data managers only), `POST company-restore` (bank statements, batches, ERP files and drafts from a backup, added when new; approvals are not carried over) |
| Audit | `GET audit`, `GET audit/verify`, `POST audit/client` (the few actions only the browser sees: report exports, AI requests, screen locks, switching company, role previews, access requests), `POST audit/purge` (entries older than the company's retention period; the purge is logged and the rest still verifies), `GET/POST audit/archive` (the browser app's audit log, kept once per entry, with a SHA-256 of each batch in the hash chain), `GET health` |

A request without a usable session gets 401 with a code saying why, so the web app can tell the person: `unauthenticated` (no session), `session_expired` (timed out or ended), `account_disabled`, `company_inactive`. A disabled user's or inactive company's sessions stop working at once and are removed when the user or company is enabled again, so none comes back.

## Roadmap
| Part | Scope |
|---|---|
| **1a (done)** | Server, database, security, users and entities, leases, approvals, events, payments, period lock, audit, packaging, backups, tests; multiple companies with a platform console |
| **1b (in progress)** | Web interface on this API (`../frontend`). Done: platform console, company sign-in, users, roles and permissions. Settings, entities and exchange rates; leases with their approvals, changes and payments; bank statements and matching; payment batches; ERP files, AI drafts, the audit view, company export and restore; the tool that brings a company's browser data over done. Next: hosting the web app in `deploy/`, browser tests in the repository, a check with about 5,000 leases. Then the offline app: installable, works without network for viewing, drafting and recording payments, syncs when reconnected; approvals stay online-only |
| 1c | Journals and ERP exports, reports and disclosures, IAS 21 revaluation, bank statement import and reconciliation, payment batches, contract import |
| 1d | Single sign-on, separate database roles, licence keys for distribution, optional AI (server-side with your own API key, or switched off for air-gapped sites) |
