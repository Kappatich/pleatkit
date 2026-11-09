#!/usr/bin/env bash
# Pull the public demo's research log from the VPS (docs/demo-hosting.md, "What is logged"): events-*.jsonl,
# stats-*.json and leads.jsonl from /var/lib/pleatkit-demo into $DEMO_PULL_DIR (default D:/pleatkit-tmp/demo-data).
# Same settings as scripts/deploy-demo.sh: DEMO_SSH_HOST, DEMO_SSH_KEY (environment or .env.demo-deploy).
# Then: node scripts/demo-report.mjs
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
if [ -f "$repo/.env.demo-deploy" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$repo/.env.demo-deploy"
  set +a
fi
: "${DEMO_SSH_HOST:?set DEMO_SSH_HOST=root@<vps> (environment or .env.demo-deploy)}"
key="${DEMO_SSH_KEY:-$HOME/.ssh/id_ed25519}"
key="${key/#\~/$HOME}"
if [ -d /d ] || [ -d "D:/" ]; then default_dir="D:/pleatkit-tmp/demo-data"; else default_dir="${TMPDIR:-/tmp}/pleatkit-demo-data"; fi
dest="${DEMO_PULL_DIR:-$default_dir}"
remote="${DEMO_REMOTE_DATA_DIR:-/var/lib/pleatkit-demo}"
ssh_opts=(-i "$key" -o IdentitiesOnly=yes)

mkdir -p "$dest"
if command -v rsync >/dev/null 2>&1; then
  rsync -az -e "ssh ${ssh_opts[*]}" --include='events-*.jsonl' --include='stats-*.json' --include='leads.jsonl' --exclude='*' "$DEMO_SSH_HOST:$remote/" "$dest/"
else
  ssh "${ssh_opts[@]}" "$DEMO_SSH_HOST" "cd '$remote' && tar -czf - \$(ls events-*.jsonl stats-*.json leads.jsonl 2>/dev/null)" | tar -C "$dest" -xzf -
fi
echo "pulled into $dest:"
ls -1 "$dest"
