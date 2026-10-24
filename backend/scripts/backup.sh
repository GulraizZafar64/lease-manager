#!/usr/bin/env bash
# Encrypted nightly backup. Schedule with cron, e.g.  30 1 * * *  /opt/lease-manager/scripts/backup.sh
# Needs: BACKUP_DIR, BACKUP_PASSFILE (file holding the encryption passphrase), KEEP_DAYS.
set -euo pipefail
BACKUP_DIR=${BACKUP_DIR:-/var/backups/lease-manager}
BACKUP_PASSFILE=${BACKUP_PASSFILE:-/etc/lease-manager/backup.pass}
KEEP_DAYS=${KEEP_DAYS:-35}
COMPOSE=${COMPOSE:-"docker compose -f $(dirname "$0")/../deploy/docker-compose.yml"}   # the cloud set-up passes its own
mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"
STAMP=$(date +%Y%m%d-%H%M%S)
OUT="$BACKUP_DIR/leasedb-$STAMP.dump.enc"
# Custom-format dump (restorable table by table), encrypted AES-256 with PBKDF2
$COMPOSE exec -T db pg_dump -U lease -d leasedb -Fc \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 250000 -salt -pass "file:$BACKUP_PASSFILE" -out "$OUT"
sha256sum "$OUT" > "$OUT.sha256"
# Prove the backup is readable before deleting old ones
#   (head stops reading after 5 bytes, so openssl's write error is expected and ignored)
MAGIC=$(openssl enc -d -aes-256-cbc -pbkdf2 -iter 250000 -pass "file:$BACKUP_PASSFILE" -in "$OUT" 2>/dev/null | head -c 5 || true)
[ "$MAGIC" = PGDMP ] || { echo "Backup check failed: $OUT is not a readable dump" >&2; exit 1; }
find "$BACKUP_DIR" -name 'leasedb-*.dump.enc*' -mtime +"$KEEP_DAYS" -delete
echo "Backup written: $OUT"
# Copy $BACKUP_DIR to a second location (another server or offline media) as part of disaster recovery.
