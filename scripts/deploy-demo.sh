#!/usr/bin/env bash
# Deploy the public demo (demo.pleatkit.com, docs/demo-hosting.md) to the VPS:
#   1. builds the packages, the demo app and the release folder (apps/demo-crm/scripts/build-public-demo.mjs)
#   2. uploads it to $DEMO_REMOTE_DIR/releases/<stamp> (rsync when installed, tar over ssh otherwise)
#   3. on the server, as root: creates the pleatkit-demo user, installs the release's npm packages, creates
#      /etc/pleatkit-demo/demo.env from env.example once (never overwritten), installs the systemd unit, points
#      $DEMO_REMOTE_DIR/app at the new release, restarts, checks /demo/api/health and rolls back on failure
#   4. leaves the nginx vhosts in $DEMO_REMOTE_DIR/nginx/ for you to copy into /etc/nginx by hand
# It never touches /etc/nginx, DNS or other sites.
#
# Settings (environment, or a git-ignored .env.demo-deploy at the repo root):
#   DEMO_SSH_HOST     user@host of the VPS, e.g. root@<vps>        (required)
#   DEMO_SSH_KEY      private key for ssh                          (default ~/.ssh/id_ed25519)
#   DEMO_REMOTE_DIR   install folder on the VPS                    (default /var/www/pleatkit-demo)
#   DEMO_RELEASE_DIR  local build folder                           (default D:/pleatkit-tmp/demo-release or $TMPDIR)
#   DEMO_INSTALL_NODE=1  install Node.js 22 from NodeSource when the server has no Node >= 22
# Flags: --build-only (build the release, upload nothing), --skip-build (upload the last build).
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
if [ -f "$repo/.env.demo-deploy" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$repo/.env.demo-deploy"
  set +a
fi

build=1
upload=1
for arg in "$@"; do
  case "$arg" in
    --build-only) upload=0 ;;
    --skip-build) build=0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

remote_dir="${DEMO_REMOTE_DIR:-/var/www/pleatkit-demo}"
if [ -d /d ] || [ -d "D:/" ]; then default_release="D:/pleatkit-tmp/demo-release"; else default_release="${TMPDIR:-/tmp}/pleatkit-demo-release"; fi
release="${DEMO_RELEASE_DIR:-$default_release}"
stamp="$(date -u +%Y%m%d-%H%M%S)"
commit="$(git -C "$repo" rev-parse --short HEAD 2>/dev/null || echo unknown)"

if [ "$build" = 1 ]; then
  echo "== build ($commit)"
  (cd "$repo" && pnpm build:packages)
  (cd "$repo" && pnpm --filter @pleatkit/demo-crm build)
  (cd "$repo/apps/demo-crm" && DEMO_BUILD_COMMIT="$commit" node scripts/build-public-demo.mjs "$release")
fi
[ -f "$release/server.mjs" ] || { echo "no release in $release: run without --skip-build" >&2; exit 1; }
if [ "$upload" = 0 ]; then
  echo "release ready in $release (nothing uploaded)"
  exit 0
fi

: "${DEMO_SSH_HOST:?set DEMO_SSH_HOST=root@<vps> (environment or .env.demo-deploy)}"
key="${DEMO_SSH_KEY:-$HOME/.ssh/id_ed25519}"
key="${key/#\~/$HOME}"
ssh_opts=(-i "$key" -o IdentitiesOnly=yes -o ServerAliveInterval=30)
target="$remote_dir/releases/$stamp"

echo "== upload to $DEMO_SSH_HOST:$target"
ssh "${ssh_opts[@]}" "$DEMO_SSH_HOST" "mkdir -p '$target'"
if command -v rsync >/dev/null 2>&1; then
  rsync -az --delete -e "ssh ${ssh_opts[*]}" --exclude node_modules "$release/" "$DEMO_SSH_HOST:$target/"
else
  tar -C "$release" --exclude=node_modules -czf - . | ssh "${ssh_opts[@]}" "$DEMO_SSH_HOST" "tar -C '$target' -xzf -"
fi

echo "== install on the server"
ssh "${ssh_opts[@]}" "$DEMO_SSH_HOST" "REMOTE_DIR='$remote_dir' TARGET='$target' INSTALL_NODE='${DEMO_INSTALL_NODE:-0}' bash -s" <<'REMOTE'
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "the remote part needs root (it creates a user and a systemd unit)" >&2; exit 1; }

node_major="$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || true)"
if [ -z "$node_major" ] || [ "$node_major" -lt 22 ]; then
  if [ "$INSTALL_NODE" = 1 ]; then
    echo "-- installing Node.js 22 (NodeSource)"
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  else
    echo "Node.js >= 22 is required on the server (found: ${node_major:-none}). Re-run with DEMO_INSTALL_NODE=1, or install it yourself." >&2
    exit 1
  fi
fi

id pleatkit-demo >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin pleatkit-demo

echo "-- npm packages of the release"
cd "$TARGET"
npm install --omit=dev --no-audit --no-fund --cache /tmp/pleatkit-demo-npm-cache >/dev/null
rm -rf /tmp/pleatkit-demo-npm-cache
chown -R root:pleatkit-demo "$TARGET"
chmod -R u=rwX,g=rX,o= "$TARGET"
chmod 755 "$REMOTE_DIR" "$REMOTE_DIR/releases"

mkdir -p /etc/pleatkit-demo
if [ ! -f /etc/pleatkit-demo/demo.env ]; then
  cp "$TARGET/deploy/env.example" /etc/pleatkit-demo/demo.env
  echo "-- created /etc/pleatkit-demo/demo.env (SCRIPTED mode); edit it to change the mode or add the key"
fi
chown root:pleatkit-demo /etc/pleatkit-demo /etc/pleatkit-demo/demo.env
chmod 750 /etc/pleatkit-demo
chmod 640 /etc/pleatkit-demo/demo.env

install -m 644 "$TARGET/deploy/pleatkit-demo.service" /etc/systemd/system/pleatkit-demo.service
systemctl daemon-reload
systemctl enable pleatkit-demo.service >/dev/null

mkdir -p "$REMOTE_DIR/nginx"
cp "$TARGET/deploy/demo.pleatkit.com.conf" "$TARGET/deploy/demo.pleatkit.com.bootstrap.conf" "$REMOTE_DIR/nginx/"

previous="$(readlink -f "$REMOTE_DIR/app" 2>/dev/null || true)"
ln -sfn "$TARGET" "$REMOTE_DIR/app.next"
mv -T "$REMOTE_DIR/app.next" "$REMOTE_DIR/app"
systemctl restart pleatkit-demo.service

ok=0
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8710/demo/api/health >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
if [ "$ok" != 1 ]; then
  echo "!! the new release did not answer /demo/api/health; last log lines:" >&2
  journalctl -u pleatkit-demo.service -n 30 --no-pager >&2 || true
  if [ -n "$previous" ] && [ -d "$previous" ]; then
    echo "!! rolling back to $previous" >&2
    ln -sfn "$previous" "$REMOTE_DIR/app.next"
    mv -T "$REMOTE_DIR/app.next" "$REMOTE_DIR/app"
    systemctl restart pleatkit-demo.service
  fi
  exit 1
fi
curl -fsS http://127.0.0.1:8710/demo/api/health; echo

# keep the last three releases
ls -1dt "$REMOTE_DIR"/releases/*/ | tail -n +4 | xargs -r rm -rf
echo "-- live: $(readlink -f "$REMOTE_DIR/app")"
REMOTE

cat <<EOF

Deployed $commit. The service answers on 127.0.0.1:8710 on the server.
nginx is untouched; the vhosts are in $remote_dir/nginx/ (first time: docs/demo-hosting.md, "First deploy").
Logs: ssh ... journalctl -u pleatkit-demo -f    Data: scripts/demo-pull.sh
EOF
