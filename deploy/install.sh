#!/usr/bin/env bash
# Set up and start the Lease Manager on one Ubuntu server (Oracle Cloud Always Free or similar).
# Run it from the repository folder:  bash deploy/install.sh
# Safe to run again: it keeps deploy/.env, the database and the certificate, and rebuilds the app.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
ENV_FILE=deploy/.env
COMPOSE="sudo docker compose -f $ROOT/deploy/docker-compose.yml"
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

if command -v apt-get >/dev/null; then PKG=apt
elif command -v dnf >/dev/null; then PKG=dnf
else echo "This script expects Ubuntu, Debian, or Oracle Linux / RHEL 8 or later."; exit 1; fi

# 1. Docker
if ! command -v docker >/dev/null; then
    say "Installing Docker"
    if [ "$PKG" = apt ]; then
        curl -fsSL https://get.docker.com | sudo sh
    else
        # get.docker.com does not cover Oracle Linux; Docker's RHEL packages do
        sudo dnf install -y -q dnf-plugins-core
        sudo dnf config-manager --add-repo https://download.docker.com/linux/rhel/docker-ce.repo
        sudo dnf install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    fi
    sudo systemctl enable --now docker
fi
sudo docker compose version >/dev/null || { echo "The Docker Compose plugin is missing (install docker-compose-plugin)."; exit 1; }

# 2. Firewall. Oracle's images allow only SSH; open the web ports now and after a restart.
#    (Ports 80 and 443 must also be allowed in the cloud console: see deploy/README.md.)
say "Opening ports 80 and 443"
if systemctl is-active --quiet firewalld; then
    sudo firewall-cmd -q --permanent --add-service=http --add-service=https
    sudo firewall-cmd -q --permanent --add-port=443/udp
    sudo firewall-cmd -q --reload
else
    for rule in "-p tcp --dport 80" "-p tcp --dport 443" "-p udp --dport 443"; do
        # shellcheck disable=SC2086
        sudo iptables -C INPUT $rule -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 1 $rule -j ACCEPT
    done
    RULES=/etc/iptables/rules.v4
    if sudo test -f "$RULES" && ! sudo grep -q -- '--dport 443 -j ACCEPT' "$RULES"; then
        sudo sed -i '/^-A INPUT -j REJECT/i -A INPUT -p tcp -m tcp --dport 80 -j ACCEPT\n-A INPUT -p tcp -m tcp --dport 443 -j ACCEPT\n-A INPUT -p udp -m udp --dport 443 -j ACCEPT' "$RULES"
    fi
fi

# 3. Swap on small machines, so building the web app does not run out of memory
MEM_MB=$(awk '/MemTotal/ {print int($2 / 1024)}' /proc/meminfo)
SWAP_MB=$(awk '/SwapTotal/ {print int($2 / 1024)}' /proc/meminfo)
if [ "$MEM_MB" -lt 2000 ] && [ "$SWAP_MB" -lt 2000 ] && ! grep -q '^/swapfile ' /proc/swaps; then
    say "Adding 2 GB of swap"
    sudo dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none && sudo chmod 600 /swapfile
    command -v chcon >/dev/null && sudo chcon -t swapfile_t /swapfile 2>/dev/null || true
    sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

# 4. Settings, made once. The secrets are random; keep a copy of them in your password vault.
if [ ! -f "$ENV_FILE" ]; then
    say "Settings"
    read -r -p "Web address for the app, without https:// (for example leases.duckdns.org): " DOMAIN
    DOMAIN=${DOMAIN#http://}; DOMAIN=${DOMAIN#https://}; DOMAIN=${DOMAIN%%/*}
    [ -n "$DOMAIN" ] || { echo "A web address is needed."; exit 1; }
    read -r -p "Your email (for the HTTPS certificate and your first sign-in): " EMAIL
    [ -n "$EMAIL" ] || { echo "An email address is needed."; exit 1; }
    ( umask 077; cat > "$ENV_FILE" <<EOF
# Made by deploy/install.sh on $(date -u +%F). Never commit this file.
# Keep MASTER_KEY and DB_PASSWORD in your password vault: without MASTER_KEY no authenticator code can be checked.
DOMAIN=$DOMAIN
ACME_EMAIL=$EMAIL
DB_PASSWORD=$(openssl rand -hex 24)
MASTER_KEY=$(openssl rand -base64 32)
ORG_NAME="Lease Manager"
# Two-step sign-in with an authenticator app, for everyone. false = password only (not recommended on the internet)
REQUIRE_MFA=true
EOF
    )
    echo "Saved $ENV_FILE"
fi
set -a; . "./$ENV_FILE"; set +a

# 5. The web address must point at this server before a certificate can be issued
IP=$(curl -fsS --max-time 10 https://api.ipify.org || true)
POINTS_TO=$(getent ahostsv4 "$DOMAIN" | awk 'NR == 1 {print $1}' || true)
if [ -n "$IP" ] && [ "$IP" != "$POINTS_TO" ]; then
    echo "Warning: $DOMAIN points to ${POINTS_TO:-nothing}, but this server's address is $IP."
    echo "Point the name at $IP first (see deploy/README.md), or the HTTPS certificate cannot be issued."
    read -r -p "Continue anyway? [y/N] " go; [ "$go" = "y" ] || [ "$go" = "Y" ] || exit 1
fi

# 6. Build and start
say "Building and starting (the first time takes several minutes)"
$COMPOSE up -d --build

say "Waiting for https://$DOMAIN"
ok=""
for _ in $(seq 1 60); do
    if curl -fsS --max-time 5 "https://$DOMAIN/api/health" >/dev/null 2>&1; then ok=1; break; fi
    sleep 5
done
if [ -z "$ok" ]; then
    echo "The app did not answer on https://$DOMAIN yet. Recent log lines:"
    $COMPOSE logs --tail 25 web app
    echo "Check that ports 80 and 443 are open in the cloud console and that $DOMAIN points to ${IP:-this server}, then run this script again."
    exit 1
fi
curl -fsS "https://$DOMAIN/api/health"; echo

# 7. The platform owner (you): signs in at /platform and adds companies
OWNERS=$($COMPOSE exec -T db psql -U lease -d leasedb -tAc "SELECT count(*) FROM platform_admins" | tr -d '[:space:]')
if [ "$OWNERS" = "0" ]; then
    say "Your platform owner account"
    read -r -p "Your name: " NAME
    $COMPOSE exec -T app node src/cli.js create-platform-owner "$ACME_EMAIL" "${NAME:-Platform owner}"
fi

# 8. Nightly encrypted backups on this server (copy them elsewhere too)
CRON=/etc/cron.d/lease-manager-backup
if [ ! -f "$CRON" ]; then
    read -r -p "Set up nightly encrypted database backups on this server? [Y/n] " b
    if [ "$b" != "n" ] && [ "$b" != "N" ]; then
        sudo install -d -m 700 /etc/lease-manager
        sudo test -f /etc/lease-manager/backup.pass || openssl rand -base64 32 | sudo tee /etc/lease-manager/backup.pass >/dev/null
        sudo chmod 600 /etc/lease-manager/backup.pass
        echo "30 1 * * * root COMPOSE=\"docker compose -f $ROOT/deploy/docker-compose.yml\" bash $ROOT/backend/scripts/backup.sh >> /var/log/lease-manager-backup.log 2>&1" | sudo tee "$CRON" >/dev/null
        echo "Backups run at 01:30 into /var/backups/lease-manager. Keep /etc/lease-manager/backup.pass in your vault."
    fi
fi

say "Ready: https://$DOMAIN"
echo "Platform console (you): https://$DOMAIN/platform   Company users: https://$DOMAIN"
echo "Update later with:  git pull && bash deploy/install.sh"
