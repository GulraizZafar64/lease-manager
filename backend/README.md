# IFRS 16 Lease Manager: on-premises server

Lease accounting under IFRS 16 for lessees and lessors, installed on your own servers.

**Status:** the API, database, security model and calculation engine are complete and tested. One installation serves many companies (SaaS). The web app in [`../frontend`](../frontend) uses this server for the platform console, company sign-in, users, roles and permissions, settings, leases with their approvals, changes and payments, bank reconciliation, payment batches, ERP export records, AI-drafted disclosures, the audit view, and company backups and restore, and has a one-time tool to bring a company's data over from the browser-only app (see that folder's README).

| | |
|---|---|
| Runtime | Node.js 20 LTS, PostgreSQL 16 |
| Install | Docker Compose (recommended) or native Linux service |
| Tests | 79 automated tests (sign-in, two-step sign-in switched off and on, companies, users, roles, leases and approvals, bank reconciliation, payment batches, ERP files, AI drafts, company export and restore, bringing browser data over, audit and retention), plus the 14 IFRS 16 reference examples checked at every start |

- **[INSTALL.md](INSTALL.md)**: install, first sign-in, backups, upgrades.
- **[ARCHITECTURE.md](ARCHITECTURE.md)**: design, data model, API, roadmap.
- **[SECURITY.md](SECURITY.md)**: security controls, and what your IT team must do.

## Developer quick start
```bash
npm ci
cp .env.example .env            # set DATABASE_URL and MASTER_KEY
npm run cli -- create-platform-owner owner@example.com "Your Name"   # then add companies at /platform in the web app
# or, without the web app:
npm run cli -- create-company aml "Allied Marketing (Pvt) Ltd" PKR
npm run cli -- create-superadmin aml you@company.com "Your Name"
npm run cli -- create-entity aml AML "Allied Marketing (Pvt) Ltd" PKR
npm start                       # http://localhost:8080/api/health
TEST_DATABASE_URL=postgres://... npm test   # uses a throwaway database
```

### Local development without Docker
`npm run db:dev` starts a project-local PostgreSQL 16 (embedded-postgres, data in `.pgdata`, port 5433,
localhost only) with a `leasedb` and a `leasedb_test` database. Put their URLs in `.env` (DATABASE_URL and
TEST_DATABASE_URL), then use `npm run dev` (API with auto-restart), `npm run test:local` and `npm run cli:local -- <command>`.
Set `PORT=8090`, `HOST=127.0.0.1` and `COOKIE_SECURE=false` in `.env` for local use: the web app's dev server forwards `/api`
to `http://127.0.0.1:8090` by default, and cookies marked Secure are not sent over plain http. The web app's README has the
full walk-through (platform owner, first company, first sign-in).
