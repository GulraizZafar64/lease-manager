# IFRS 16 Lease Manager: web app

React + TypeScript (Vite) version of the original single-file `IFRS 16 Lease Manager Final (1).html`. The original page is not part of this repository. The server is in [`../backend`](../backend).

## Two ways to run it
| Mode | `VITE_USE_API` | Who signs in | Where data is kept |
|---|---|---|---|
| Interface preview | `false` (default) | Anyone, by picking a user; passwords are not checked | This browser only (localStorage, per company) |
| With the server | `true` | Real accounts: password, authenticator code, lockout | See [What is on the server](#what-is-on-the-server) |

Set it in `.env.local` (copy `.env.example`; it is git-ignored), then restart the dev server. `VITE_API_TARGET` is where `/api` is forwarded (default `http://127.0.0.1:8090`).

## Scripts
```bash
npm ci
npm run dev        # http://localhost:5173 (or --port 5199 if 5173 is taken)
npm run build      # typecheck, then production build in dist/
npm run lint
npm run preview    # serve dist/, also forwarding /api
```

## Running with the server (development)
1. In `../backend`: `npm ci`, create `.env` as described in its README (section "Local development without Docker"), then in two terminals `npm run db:dev` and `npm run dev`. Check `curl http://127.0.0.1:8090/api/health`.
2. Create the platform owner (you, the operator of the service):
   ```bash
   npm run cli:local -- create-platform-owner owner@example.com "Platform Owner"
   ```
   It prints a temporary password once.
3. Here: `VITE_USE_API=true npm run dev -- --port 5198` (or set it in `.env.local`).
4. Open `/platform`, sign in with the temporary password, scan the QR code with an authenticator app, and choose a password.
5. **Add company**: name, code, currency and one or more super administrators. Each super administrator's temporary password is shown once; send it to them securely.
6. A super administrator signs in at `/login` (the same steps: code set-up, new password), then adds people on **Users** and adjusts **Roles and permissions**.

## Pages
| Address | What |
|---|---|
| `/platform` | Platform console: companies, their super administrators, activate and deactivate |
| `/login` | Company sign-in; asks for the company when one password opens several |
| `/` and the rest | The lease workspace (overview, register, payments, approvals, reports, users, roles, settings…) |

## What is on the server
With `VITE_USE_API=true`:

| On the server | Still in this browser |
|---|---|
| Platform owner sign-in and the company list; activating and deactivating companies | Your theme (per person, as before) |
| Company sign-in: passwords, authenticator codes, lockout, "keep me signed in", session timeout, switch company | |
| Who you are, your company, your role and permissions (checked again on each server call) | |
| Users: add (temporary password shown once), edit, disable, delete, unlock, reset password, reset two-step sign-in, entity access, approval limits, extra permissions | |
| Leases: register, add and edit (drafts may be incomplete), submit, approve and reject with the server's rules, details of live leases (description, documents, payee bank details), remeasurements and modifications with their approvals, recording payments, history written by the server, sample portfolio | |
| Roles: changes to built-in roles and custom roles, applied to everyone straight away | |
| Settings (Settings page and Administration: approval policy and period lock, entities, currencies and dated rates, bank accounts, ERP options, retention) | |
| Bank reconciliation: imported statements (lines seen before are marked as duplicates by the server), auto-matching and accepted suggestions, manual matches, unmatching, lines marked as not lease-related; each match records the payment on the lease | |
| Payment batches: create, submit (payee bank details checked), approve or reject with the approval policy, bank file releases | |
| ERP export files and their posted or failed status (used to leave out entries already sent) | |
| AI-drafted disclosures: saved, edited (approvals needed again) and approved on the server; the drafting itself runs only inside Claude, as before | |
| The Administration audit view: the server's log, with the few actions only the browser sees (report exports, AI requests, screen locks, switching company, role previews) added to it; retention purges past the saved retention period | |
| Backups (Administration › Security and data): the server's export of the whole company, plain or encrypted in the browser with your passphrase. Restore: settings (entities and rates added), leases (same IDs replaced), then statements, batches, ERP files and drafts (added when new; approvals are given again) | |

Statement files are read and matches scored in the browser, as before; the server records each match, or refuses it with the reason (period lock, a line already matched, an instalment that does not exist), and a refused match is not counted. The original page has no way to change or remove a recorded payment, so neither does this one; late charges are worked out from the lease's rules and the recorded payments, as before.

Settings are read from the server when the app opens; saving sends only what changed, so two people saving different sections do not undo each other. A refused change (for example a duplicate entity code) is explained and the screen goes back to the server's values. Each company's browser data is stored under its own keys, so companies never mix.

When a session ends, the login page says why: signed out, timed out, account disabled, or company deactivated. Open tabs notice within about a minute while in use, or straight away when you return to the tab. Other people's changes to leases, bank statements, batches, ERP files and drafts show when you return to the tab (at most every 30 seconds) or reload.

## Moving a company from the browser app
A company that used the browser-only app (or the original single page) brings its data over once, from **Administration › Security and data › Bring data from the browser app** (super administrators):

1. Choose the data: what is saved in this browser (found when the server app runs at the address the browser app used), or a backup file downloaded from it (plain or encrypted).
2. **Check.** The server checks every lease and nothing changes yet. The preview shows the entities and custom roles to add, each person (matched to an account here by email, or to be added with a temporary password), leases that are new, already here (keep or replace) or have a problem (left behind, with the reason), and the records and audit entries to bring.
3. **Bring over.** In order: custom roles, settings (entities and dated rates added, approval policy pointed at the roles here), people, leases with their changes, payments and history, bank statements, batches, ERP files and drafts (approvals are given again), and the browser's audit log, kept as an archive and shown in the audit log marked "(browser app)". Temporary passwords are shown once at the end.

Running it again adds only what is not there yet. The browser copy is left as it was.

## Not set up yet
- **Production hosting of this app.** The server's Docker set-up (`../backend/deploy`) serves the API only. To publish the web app, build it (`npm run build`) and serve `dist/` from the same site as `/api` (for example from the Caddy proxy, with every unknown path answered by `index.html`), so the session cookie and anti-forgery check keep working.
- **Automated browser tests.** The server has automated tests (`npm run test:local` in `../backend`); this app is checked with `npm run typecheck`, `npm run lint` and by hand in the browser.

## Code layout
| Folder | Contents |
|---|---|
| `src/domain` | Calculation engine, leases, approvals, reports, settings, navigation; browser storage |
| `src/api` | Server client (`client.ts`) and the signed-in identity (`auth.ts`) |
| `src/pages`, `src/components` | Screens and shared components (`components/users/source.ts` and `roleSource.ts` pick server or browser) |
| `src/platform` | Platform console |
| `src/styles` | Styles carried over from the original page, plus `enhancements.css`, `login.css`, `users.css`, `platform.css` |
