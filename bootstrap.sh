#!/bin/bash

# Setup version target
isHaveNode="26"
target_docker_version="27.0.3"
isHaveNodebool=false
isHavepm2bool=false
isHaveDockerbool=false

GH_OWNER="kadi1m"
GH_REPO="rivo-keel-worker"
TARGET_DIR="/opt/rivo-keel-worker"
SERVICE_NAME="rivo-keel-worker"
USERNAME="ubuntu"
GROUP="ubuntu"

if [ -z "$1" ]; then
    echo "Usage: curl ... | sudo bash -s -- <CONTROL_PLANE_TOKEN>"
    exit 1
fi
CP_TOKEN="$1"

if [ "$EUID" -ne 0 ]; then
  echo "❌ This setup script must be run with administrative privileges. Please use 'sudo bash'."
  exit 1
fi

# 1. Check if the docker command exists
if command -v docker &> /dev/null; then
    # Extracts the version number cleanly (e.g., converts 'Docker version 27.0.3, build 7d4adc3' into '27.0.3')
    current_docker_version=$(docker -v | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1)
    echo "Current Docker version: $current_docker_version"
else
    current_docker_version="none"
    echo "Docker is not installed."
fi

# 2. Check if version matches or needs installation
if [[ "$current_docker_version" != "$target_docker_version" ]]; then
    echo "Docker $target_docker_version not found. Installing Docker Engine & Plugins..."
    
    # Standard production installation steps for Debian/Ubuntu systems
    apt-get update -y
    apt-get install -y ca-certificates curl gnupg
    
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -y --yes -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg

    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | tee /etc/apt/sources.list.p/docker.list > /dev/null
    
    apt-get update -y
    
    # This installs core docker, the buildx plugin, and the compose plugin together
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    
    isHaveDockerbool=true
else
    echo "Docker version matches perfectly."
    isHaveDockerbool=true
fi

# 3. Double check that the Docker Compose plugin specifically is working
if ! docker compose version &> /dev/null; then
    echo "Warning: Docker Compose plugin is missing. Attempting stand-alone fix..."
    apt-get install -y docker-compose-plugin
fi

# 1. Check if node command exists, and get its major version number
if command -v node &> /dev/null; then
    current_node_version=$(node -v 2>&1 | grep -oE '[0-9]+' | head -n 1)
else
    current_node_version="0"
fi

# 2. Verify major version matches 26
if [[ "$current_node_version" != "$isHaveNode" ]]; then
    echo "Node.js version 26 is required. Installing..."
    # Note: NodeSource uses setup_26.x for major versions
    curl -fsSL https://deb.nodesource.com/setup_26.x | bash -
    apt-get install -y nodejs
    isHaveNodebool=true
else
    isHaveNodebool=true
fi

# 3. Check for PM2
if ! command -v pm2 &> /dev/null; then
    echo "Installing PM2..."
    npm install -g pm2
    isHavepm2bool=true
else
    isHavepm2bool=true
fi

# 4. Final dependency verification
if [[ "$isHaveNodebool" = "true" && "$isHavepm2bool" = "true" ]]; then
    echo "all deps installed"
fi

# ALL DEPS INSTALLED -> START PM2 WORKER

echo "🧹 HARD RESET: Cleaning up any old installations..."
systemctl stop ${SERVICE_NAME}.timer || true
systemctl disable ${SERVICE_NAME}.timer || true
rm -rf "$TARGET_DIR"

mkdir -p "$TARGET_DIR"

curl -sL -o "$TARGET_DIR/deploy-worker.sh" "https://raw.githubusercontent.com/$GH_OWNER/$GH_REPO/main/deploy-worker.sh"
chmod +x "$TARGET_DIR/deploy-worker.sh"
chown -R $USERNAME:$GROUP "$TARGET_DIR"

cat <<EOF > /etc/systemd/system/${SERVICE_NAME}.service
[Unit]
Description=Pull Latest Worker Repo and Deploy
After=network.target

[Service]
Type=oneshot
User=ubuntu
Group=ubuntu
WorkingDirectory=$TARGET_DIR
ExecStart=/bin/bash $TARGET_DIR/deploy-worker.sh "$CP_TOKEN"
KillMode=process

[Install]
WantedBy=multi-user.target
EOF

cat <<EOF > /etc/systemd/system/${SERVICE_NAME}.timer
[Unit]
Description=Run worker auto-update interval timer

[Timer]
OnBootSec=1min
OnUnitActiveSec=5min
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now ${SERVICE_NAME}.timer

systemctl start ${SERVICE_NAME}.service


echo "Active provisioning complete!"