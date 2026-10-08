#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT
mkdir -p "$TEMP/bin" "$TEMP/env"

cat > "$TEMP/bin/gcloud" <<'SH'
#!/usr/bin/env bash
case "$*" in
  *noelle-postgres-app-password*) printf '%s' 'db-password' ;;
  *noelle-worker-hmac-secret*) printf '%s' 'hmac-secret' ;;
  *noelle-worker-ai-gateway-api-key*) printf '%s' 'vck_testgateway' ;;
  *) exit 1 ;;
esac
SH
cat > "$TEMP/bin/install" <<'SH'
#!/usr/bin/env bash
src="${@: -2:1}"
dest="${@: -1}"
case "$dest" in "$TEST_EXPECT_DEST_PREFIX"/*) ;; *) exit 42 ;; esac
cp "$src" "$dest"
chmod 600 "$dest"
SH
chmod +x "$TEMP/bin/gcloud" "$TEMP/bin/install"

PATH="$TEMP/bin:$PATH" TEST_EXPECT_DEST_PREFIX="$TEMP/env" PROJECT=fixture-project DB_HOST=127.0.0.1 DB_DEST="$TEMP/env/db.env" WORKER_DEST="$TEMP/env/worker.env" \
  bash "$ROOT/scripts/pull-secrets.sh" > "$TEMP/output"

grep -qx 'AI_GATEWAY_API_KEY=vck_testgateway' "$TEMP/env/worker.env"
if grep -q 'vck_testgateway' "$TEMP/output"; then
  echo 'Gateway key appeared in command output' >&2
  exit 1
fi
echo 'pull-secrets: Gateway key projection passed'

printf '%s\n' 'GCP_PROJECT=fixture-project' > "$TEMP/env/api-vm.env"
env -u PROJECT -u NOELLE_GCP_PROJECT -u DB_HOST \
  PATH="$TEMP/bin:$PATH" TEST_EXPECT_DEST_PREFIX="$TEMP/env" \
  NOELLE_CONFIG_ENV_FILE="$TEMP/env/api-vm.env" DB_DEST="$TEMP/env/db.env" WORKER_DEST="$TEMP/env/worker.env" \
  bash "$ROOT/scripts/pull-secrets.sh" > "$TEMP/output"
grep -q '@127.0.0.1:' "$TEMP/env/db.env"
echo 'pull-secrets: Saved installation configuration preserved'
