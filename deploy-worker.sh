GH_OWNER="kadi1m"
GH_REPO="rivo-keel-worker"
CONTROL_PLANE_URL="http://192.168.1.222:3001"
TARGET_DIR="/opt/rivo-keel-worker"


if [ -f "/tmp/worker_processing.lock" ]; then
    echo "⚠️ Worker is currently processing a job. Skipping auto-update to avoid interrupting the build."
    exit 0
fi

if [ -z "$1" ]; then
    echo "❌ Error: Control Plane registration token is required."
    exit 1
fi
CP_TOKEN="$1"

NODE_ID=$(hostname)

rm -rf "$TARGET_DIR/app"
mkdir -p "$TARGET_DIR/app"

tar -xzf /tmp/source.tar.gz -C "$TARGET_DIR/app" --strip-components=1
rm /tmp/source.tar.gz


echo "🛠️ Installing dependencies..."
npm install --omit=dev

if npx pm2 describe worker-node &> /dev/null; then
  CONTROL_PLANE_HOST="$CONTROL_PLANE_URL" npx pm2 restart worker-node --update-env
else
  CONTROL_PLANE_HOST="$CONTROL_PLANE_URL" npx pm2 start "$TARGET_DIR/app/index.js" \
    --name worker-node \
    --env production
  npx pm2 save
fi

curl -X POST "$CONTROL_PLANE_URL/register" \
  -H "Authorization: Bearer $CP_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"node_id\": \"$NODE_ID\", \"status\": \"active\"}"

echo "✅ Node sync and clean rebuild complete."