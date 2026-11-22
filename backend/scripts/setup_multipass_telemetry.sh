#!/usr/bin/env bash
# Install a VEGA collector for a disposable Multipass guest's ubuntu shell.
set -euo pipefail
if [[ $# -lt 1 || $# -gt 2 || ! $1 =~ ^vm-[a-z0-9-]+$ ]]; then
    echo 'Usage: bash scripts/setup_multipass_telemetry.sh vm-NAME [http://host:port]' >&2
    exit 2
fi
node=$1
ingest=${2:-http://10.97.0.1:8001}
if [[ ! $ingest =~ ^https?://[a-zA-Z0-9.-]+:[0-9]+$ ]]; then
    echo 'Expected an ingest base URL with an explicit port.' >&2
    exit 2
fi
backend=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
stage=$(multipass exec "$node" -- mktemp -d /tmp/vega-collector-install.XXXXXXXX)
trap 'multipass exec "$node" -- rm -rf -- "$stage" >/dev/null' EXIT
multipass transfer "$backend/vega/producers/vm_collector.py" "$node:$stage/vm_collector.py"
multipass exec "$node" -- bash -s -- "$stage" "$node" "$ingest" <<'VM'
set -euo pipefail
stage=$1 node=$2 ingest=$3
curl -fsS --max-time 5 "$ingest/health" >/dev/null
if [[ ! -e $HOME/.bash_history ]]; then
    (umask 077; touch "$HOME/.bash_history")
fi
if ! grep -qF 'history -a' "$HOME/.bashrc"; then
    cat >> "$HOME/.bashrc" <<'BASHRC'

# VEGA demo: flush new interactive Bash history after each prompt.
if [[ $- == *i* ]]; then
    PROMPT_COMMAND+=("history -a")
fi
BASHRC
fi
sudo -n install -d -o root -g root -m 0755 /opt/vega-telemetry
sudo -n install -o root -g root -m 0644 "$stage/vm_collector.py" /opt/vega-telemetry/vm_collector.py
sudo -n tee /etc/systemd/system/vega-telemetry.service >/dev/null <<UNIT
[Unit]
Description=VEGA Multipass telemetry collector
After=network-online.target

[Service]
User=ubuntu
Group=ubuntu
ExecStart=/usr/bin/python3 -u /opt/vega-telemetry/vm_collector.py --ingest-url $ingest --source-id $node --run-id multipass-live --secrets-dir /srv/secrets/prod-keys --tmp-dir /tmp --history-file /home/ubuntu/.bash_history
Restart=on-failure
RestartSec=2
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNIT
sudo -n systemctl daemon-reload
sudo -n systemctl enable vega-telemetry.service
sudo -n systemctl restart vega-telemetry.service
systemctl is-active vega-telemetry.service
# Retire the old smoke collector once its replacement is up.
for pid in $(pgrep -u "$(id -u)" -f '^/usr/bin/python3 -u /home/ubuntu/vega-collector-smoke/vm_collector[.]py ' || true); do
    kill "$pid" 2>/dev/null || true
done
VM
