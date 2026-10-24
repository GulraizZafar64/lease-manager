# Installation (on-premises)

## 1. Server
| | Minimum | Recommended (up to ~5,000 leases, 50 users) |
|---|---|---|
| CPU / RAM | 2 vCPU, 4 GB | 4 vCPU, 16 GB |
| Disk | 40 GB SSD | 100 GB SSD, plus separate backup storage |
| OS | Ubuntu 22.04/24.04 LTS or RHEL 9 with Docker Engine 24+ and the Compose plugin | same |

Windows Server: use a Linux VM (Hyper-V), or the native install in section 7 with the Windows builds of Node.js 20 and PostgreSQL 16, running the app as a service (for example with NSSM).

Network: users reach the server on port 443 only. The server needs no internet access after installation (see 3b).

## 2. Get the software
Copy the release folder to `/opt/lease-manager`.

## 3a. Build (server with internet access)
```bash
cd /opt/lease-manager
docker compose -f deploy/docker-compose.yml build
```
## 3b. Air-gapped server
On a connected machine run `scripts/make-offline-bundle.sh`, copy `lease-manager-bundle.tar` and its `.sha256` to the server, then:
```bash
sha256sum -c lease-manager-bundle.tar.sha256 && docker load -i lease-manager-bundle.tar
```

## 4. Configure
```bash
cp .env.example .env && chmod 600 .env
openssl rand -base64 32                      # put this in MASTER_KEY
openssl rand -base64 24 > deploy/secrets/db_password.txt && chmod 600 deploy/secrets/db_password.txt
```
Set `DATABASE_URL=postgres://lease:<password from db_password.txt>@db:5432/leasedb`. Store `MASTER_KEY` and the database password in your password vault.

**TLS:** put your certificate and key (from your internal certificate authority) in `deploy/certs/server.crt` and `server.key`, and set the server name in `deploy/Caddyfile`. Add a DNS record for that name.

## 5. Start
```bash
docker compose -f deploy/docker-compose.yml up -d
docker compose -f deploy/docker-compose.yml logs app | tail     # "migration applied", then "Server listening"
curl -k https://leases.company.local/api/health                  # {"status":"ok","engineValidation":"14/14"}
```
The app refuses to start if the calculation engine fails its reference examples, which protects you from a broken upgrade.

## 6. First administrator and entities
**Running the service for several companies (SaaS):** create your own platform owner account, then add each company and its super administrators from the platform console (`/platform` in the web app):
```bash
docker compose -f deploy/docker-compose.yml exec app node src/cli.js create-platform-owner you@yourcompany.com "Your Name"
```
**A single company, or without the web app:**
```bash
docker compose -f deploy/docker-compose.yml exec app node src/cli.js create-company aml "Allied Marketing (Pvt) Ltd" PKR
docker compose -f deploy/docker-compose.yml exec app node src/cli.js create-superadmin aml ali@company.com "Ali Hassan"
docker compose -f deploy/docker-compose.yml exec app node src/cli.js create-entity aml AML "Allied Marketing (Pvt) Ltd" PKR
```
The temporary password is shown once. At first sign-in you scan a QR code with an authenticator app (Microsoft or Google Authenticator), then set a new password. Super administrators then add people on the web app's **Users** screen (or through the API); each new person's temporary password is shown once.

The Docker set-up serves the API only. The web app (`../frontend`) is built with `npm run build`; serve its `dist/` folder from the same site as `/api`, with unknown paths answered by `index.html`. The cloud set-up in the repository's top-level `deploy/` folder does this (web app, API and database on one server with HTTPS).

## 7. Native install (no Docker)
Install Node.js 20 LTS and PostgreSQL 16. Create the database and user, copy the app to `/opt/lease-manager`, run `npm ci --omit=dev`, put the settings in `/etc/lease-manager/env`, install `deploy/lease-manager.service` into systemd, and put a reverse proxy with TLS (Caddy, nginx or IIS) in front of port 8080. Set `TRUST_PROXY=true`.

## 8. Backups and disaster recovery
```bash
sudo install -d -m 700 /etc/lease-manager && openssl rand -base64 32 | sudo tee /etc/lease-manager/backup.pass >/dev/null && sudo chmod 600 /etc/lease-manager/backup.pass
sudo crontab -e      # 30 1 * * *  /opt/lease-manager/scripts/backup.sh
```
Backups are encrypted, checksummed and test-read after writing; 35 days are kept by default. **Copy them off the server** (second site or offline media) and keep the passphrase in your vault. Restore with `scripts/restore.sh <file>`, which then verifies the audit chain. Practise a restore on a test server every quarter.

## 9. Upgrades
Back up, replace the release folder, rebuild (or `docker load` a new bundle), `up -d`. Database migrations run automatically and in a transaction; a failed migration leaves the database unchanged and the app stops with the reason in the log.

## 10. Day-to-day administration
| Task | Command |
|---|---|
| User locked out | Users screen › ⋯ › Unlock, or `node src/cli.js unlock user@company.com [company-code]` |
| Turn two-step sign-in off or on | `REQUIRE_MFA=false` or `true` in `.env`, then restart the server. Off: password only, for everyone. Keys people set up are kept, so turning it on again asks them for codes from the same app; sessions started while it was off last until they end |
| Lost phone (MFA) | Users screen › ⋯ › Reset two-step sign-in, or `node src/cli.js reset-mfa user@company.com [company-code]` |
| Forgotten password | Users screen › ⋯ › Reset password (a new temporary password is shown once) |
| Company stops paying | Platform console › Deactivate: its people cannot sign in and open sessions stop at once; data is kept |
| Check audit log integrity | `node src/cli.js verify-audit` |
