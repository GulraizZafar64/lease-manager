#!/usr/bin/env bash
# For servers without internet access: build on a connected machine, carry the .tar to the server.
#   On the connected machine:  scripts/make-offline-bundle.sh
#   On the server:             docker load -i lease-manager-bundle.tar   then follow INSTALL.md step 4 onwards
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
docker build -t lease-manager:$VERSION .
docker pull postgres:16.4-bookworm && docker pull caddy:2.8.4
docker save -o lease-manager-bundle.tar lease-manager:$VERSION postgres:16.4-bookworm caddy:2.8.4
sha256sum lease-manager-bundle.tar > lease-manager-bundle.tar.sha256
echo "Bundle ready: lease-manager-bundle.tar ($VERSION)"
