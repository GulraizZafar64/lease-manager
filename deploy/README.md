# Deploy for free on Oracle Cloud

One small server runs everything: the database, the API, and Caddy, which serves the web app and the API on one
HTTPS address with a free Let's Encrypt certificate. Oracle Cloud's **Always Free** resources cost nothing; Oracle
asks for a card once to verify your identity.

You need about 30 minutes. Steps 1 to 4 happen in your browser, step 5 on the server.

## 1. Create an Oracle Cloud account
Sign up at **cloud.oracle.com** (Free Tier). Choose a home region close to your users; Always Free servers can only
be created in the home region.

## 2. Create the server
Console › **Compute › Instances › Create instance**:

| Setting | Choose |
|---|---|
| Image | **Canonical Ubuntu 24.04** (Oracle Linux 9, the console's default, also works) |
| Shape | **Ampere VM.Standard.A1.Flex**, 2 OCPU and 12 GB memory (Always Free covers up to 4 OCPU and 24 GB in total). If it says "out of capacity", try another availability domain or try again later; **VM.Standard.E2.1.Micro** (AMD, 1 GB) also works, more slowly |
| SSH keys | **Generate a key pair** and download the private key (or paste your own public key) |

Create it, then copy its **Public IP address** from the instance page.

## 3. Open the web ports
On the instance page, open the **Subnet** › **Default Security List** › **Add Ingress Rules**, twice:

| Source CIDR | IP protocol | Destination port |
|---|---|---|
| `0.0.0.0/0` | TCP | `80` |
| `0.0.0.0/0` | TCP | `443` |

(The server's own firewall is opened by the install script.)

## 4. Get a free web address
Sign in at **duckdns.org**, add a subdomain (for example `northwind-leases`) and set its IP to the server's public IP.
Your address is then `northwind-leases.duckdns.org`. Without an account, `<IP with dashes>.sslip.io` (for example `203-0-113-7.sslip.io`) points at the IP by itself. A domain you own works the same way: add an A record for the
server's IP.

## 5. Install
Connect to the server (on Windows use PowerShell; the user is `ubuntu` on Ubuntu and `opc` on Oracle Linux):
```bash
chmod 600 ~/Downloads/ssh-key.key
ssh -i ~/Downloads/ssh-key.key ubuntu@<public IP>
```
On Oracle Linux, first install git (`sudo dnf install -y git`). On the 1 GB **E2.1.Micro** shape running Oracle Linux, also
give the 448 MB that the image reserves for crash dumps back to the system, then reconnect:
```bash
sudo systemctl disable --now kdump && sudo grubby --update-kernel=ALL --remove-args=crashkernel && sudo reboot
```
Then:
```bash
git clone https://github.com/GulraizZafar64/lease-manager.git
cd lease-manager
bash deploy/install.sh
```
The script asks for the web address and your email, installs Docker, opens the server's firewall, generates the
secrets (into `deploy/.env`), builds and starts everything, waits until `https://<your address>` answers, creates your
platform owner account and offers nightly encrypted backups. The first build takes several minutes.

If the repository is private, `git clone` asks for your GitHub username and a personal access token as the password.

## 6. First sign-in
Open `https://<your address>/platform` and sign in with your email and the **temporary password the script showed**.
You set up an authenticator app, then choose a new password. Add your company and its super administrator there;
company users sign in at `https://<your address>`.

## Day to day
| Task | Command, in the `lease-manager` folder on the server |
|---|---|
| Install an update | `git pull && bash deploy/install.sh` |
| Logs | `sudo docker compose -f deploy/docker-compose.yml logs --tail 50 app` |
| Restart | `sudo docker compose -f deploy/docker-compose.yml restart` |
| Back up now | `sudo COMPOSE="docker compose -f $PWD/deploy/docker-compose.yml" bash backend/scripts/backup.sh` |
| Restore a backup | `sudo COMPOSE="docker compose -f $PWD/deploy/docker-compose.yml" bash backend/scripts/restore.sh <file>` |
| Unlock a user, reset two-step sign-in | `sudo docker compose -f deploy/docker-compose.yml exec app node src/cli.js unlock <email>` (or `reset-mfa <email>`) |

## AI features (optional)
The advisor, contract reading, change suggestions and report narratives use Claude through your own Anthropic API
key, held on the server only. Create a key at console.anthropic.com, then add it to `deploy/.env` and run
`bash deploy/install.sh`:
```
ANTHROPIC_API_KEY=sk-ant-...
AI_MONTHLY_LIMIT_USD=5
AI_TOTAL_MONTHLY_LIMIT_USD=5
```
- Monthly allowances in US$ (both 5 unless set): `AI_MONTHLY_LIMIT_USD` for each company, and
  `AI_TOTAL_MONTHLY_LIMIT_USD` for all companies together. When either is used up, AI stops until the 1st.
  For production, raise them here and run `bash deploy/install.sh`. **Administration → System monitor** shows the
  company's spending for the month.
- Routine work (contract reading, change suggestions, summaries) uses Claude Haiku 5.5; the advisor and report
  narratives use Claude Sonnet 5.5. Change them with `AI_MODEL_DEFAULT` and `AI_MODEL_COMPLEX`.
- Also set a monthly spend limit in the Anthropic Console, so the bill has a ceiling whatever happens.
- Lease details in a request (terms, counterparties, amounts) are sent to Anthropic's API to answer it.

## Keep in mind
- **Secrets:** copy `deploy/.env` (it holds `MASTER_KEY` and the database password) and `/etc/lease-manager/backup.pass`
  into your password vault. Without `MASTER_KEY` nobody's authenticator codes can be checked.
- **Backups** are written to `/var/backups/lease-manager` on the same server. Copy them somewhere else regularly
  (for example `scp` to your computer); a backup on the only server does not survive losing that server.
- **Idle servers:** Oracle may reclaim an Always Free server that stays almost idle for 7 days. Upgrading the account to
  Pay As You Go removes this; Always Free resources stay free.
- **Two-step sign-in** is on (`REQUIRE_MFA=true` in `deploy/.env`). Change it there and run `bash deploy/install.sh`
  to apply.
- The on-premises set-up for a company's own servers is separate: see `backend/INSTALL.md`.
