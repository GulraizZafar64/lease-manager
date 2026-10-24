#!/usr/bin/env bash
# Restore a backup into the running database. DESTRUCTIVE: replaces current data.
# Usage: scripts/restore.sh /var/backups/lease-manager/leasedb-YYYYMMDD-HHMMSS.dump.enc
set -euo pipefail
FILE=$1; BACKUP_PASSFILE=${BACKUP_PASSFILE:-/etc/lease-manager/backup.pass}
COMPOSE="docker compose -f $(dirname "$0")/../deploy/docker-compose.yml"
sha256sum -c "$FILE.sha256"
read -r -p "This replaces all current lease data. Type RESTORE to continue: " ok; [ "$ok" = "RESTORE" ] || exit 1
$COMPOSE stop app
openssl enc -d -aes-256-cbc -pbkdf2 -iter 250000 -pass "file:$BACKUP_PASSFILE" -in "$FILE" \
  | $COMPOSE exec -T db pg_restore -U lease -d leasedb --clean --if-exists --no-owner
$COMPOSE start app
$COMPOSE exec app node src/cli.js verify-audit
