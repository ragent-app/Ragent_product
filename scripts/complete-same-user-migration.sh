#!/bin/sh
# Same-user migration checkpoint command
# This script completes the final systemd checkpoint for same-user runner identity
# It must be run with sudo to modify /etc/systemd/system and restart services

set -eu

SERVICE_USER="${1:-pinggu}"
SERVICE_GROUP=$(getent group "$SERVICE_USER" | cut -d: -f1)
RUNNER_SERVICE="ragent-runner-supervisor"
RUNNER_SOCKET="ragent-runner-supervisor.socket"
DROPIN_DIR="/etc/systemd/system/${RUNNER_SERVICE}.service.d"

# Verify service user exists
if ! getent passwd "$SERVICE_USER" >/dev/null 2>&1; then
    echo "Error: Service user '$SERVICE_USER' does not exist" >&2
    exit 1
fi

# Verify group exists
if ! getent group "$SERVICE_GROUP" >/dev/null 2>&1; then
    echo "Error: Service group '$SERVICE_GROUP' does not exist" >&2
    exit 1
fi

# Create service user binding for future restarts
mkdir -p /etc/ragent
printf '%s\n' "$SERVICE_USER" > /etc/ragent/service-user
chmod 644 /etc/ragent/service-user
chown root:root /etc/ragent/service-user

# Ensure drop-in directory exists
mkdir -p "$DROPIN_DIR"

# Remove old dedicated-runner overrides if they exist
rm -f "${DROPIN_DIR}/20-runner-user.conf"

# Create new same-user configuration
cat > "${DROPIN_DIR}/30-same-user.conf" <<EOF
[Service]
User=$SERVICE_USER
Group=$SERVICE_GROUP
EOF

chmod 644 "${DROPIN_DIR}/30-same-user.conf"

# Update lifecycle broker environment
if [ -f /etc/ragent/ragent.env ]; then
    if ! grep -q '^RAGENT_RUNNER_USER=' /etc/ragent/ragent.env; then
        printf '\nRAGENT_RUNNER_USER=%s\n' "$SERVICE_USER" >> /etc/ragent/ragent.env
    else
        sed -i "s/^RAGENT_RUNNER_USER=.*/RAGENT_RUNNER_USER=$SERVICE_USER/" /etc/ragent/ragent.env
    fi
fi

# Reload systemd and restart services
systemctl daemon-reload
systemctl stop "${RUNNER_SERVICE}"
systemctl disable "${RUNNER_SERVICE}" 2>/dev/null || true
systemctl disable "${RUNNER_SOCKET}" 2>/dev/null || true

# Re-enable with new user context
systemctl enable "${RUNNER_SOCKET}"
systemctl enable "${RUNNER_SERVICE}"
systemctl start "${RUNNER_SOCKET}"
systemctl start "${RUNNER_SERVICE}"

# Verify new configuration
echo "Verifying new configuration..."
sleep 2
systemctl status "${RUNNER_SERVICE}" --no-pager | head -10

# Show process identity
MAIN_PID=$(systemctl show "${RUNNER_SERVICE}" --property=MainPID --value)
if [ -n "$MAIN_PID" ] && [ "$MAIN_PID" != "0" ]; then
    ps -o user,group,command -p "$MAIN_PID"
else
    echo "Service not running yet, will start on next trigger"
fi

echo "Same-user migration to '$SERVICE_USER' completed"
echo "The runner will now execute as the configured service user while preserving all security boundaries"