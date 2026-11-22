#!/usr/bin/env bash
# Provision the benign scheduled backup service (svc_backup / vega-backup.service) on vm-c
# for the VEGA false-positive clearance demo.
set -euo pipefail

node=${1:-vm-c}
if [[ ! $node =~ ^vm-[a-z0-9-]+$ ]]; then
    echo "Usage: bash scripts/setup_vm_c_backup.sh [vm-c]" >&2
    exit 2
fi

multipass exec "$node" -- bash -s <<'VM'
set -euo pipefail

if ! id -u svc_backup >/dev/null 2>&1; then
    sudo -n useradd --system --no-create-home --shell /usr/sbin/nologin svc_backup
fi

sudo -n install -d -o svc_backup -g svc_backup -m 0755 /var/tmp/vega-artifacts
sudo -n tee /var/tmp/vega-artifacts/build-manifest.json >/dev/null <<'JSON'
{"service":"eng-core-mirror","artifact":"vega-build-2026.11.22","classification":"non-secret"}
JSON
sudo -n tee /var/tmp/vega-artifacts/artifact-checksums.sha256 >/dev/null <<'TXT'
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  vega-build-2026.11.22.bin
TXT
sudo -n chown -R svc_backup:svc_backup /var/tmp/vega-artifacts

sudo -n touch /var/log/vega-backup.jsonl
sudo -n chown svc_backup:svc_backup /var/log/vega-backup.jsonl
sudo -n chmod 0644 /var/log/vega-backup.jsonl

if ! grep -qE '(^|[[:space:]])backup\.corp\.internal([[:space:]]|$)' /etc/hosts; then
    echo '10.97.0.1 backup.corp.internal' | sudo -n tee -a /etc/hosts >/dev/null
fi
if [[ -f /etc/cloud/templates/hosts.debian.tmpl ]] && ! grep -qE '(^|[[:space:]])backup\.corp\.internal([[:space:]]|$)' /etc/cloud/templates/hosts.debian.tmpl; then
    echo '10.97.0.1 backup.corp.internal' | sudo -n tee -a /etc/cloud/templates/hosts.debian.tmpl >/dev/null
fi

sudo -n tee /usr/local/bin/vega-backup-job >/dev/null <<'JOB'
#!/usr/bin/env bash
set -euo pipefail
umask 022

archive="/tmp/.vega-backup-0200.tgz"
log_file="/var/log/vega-backup.jsonl"
cleanup() {
    rm -f -- "$archive"
}
trap cleanup EXIT

tar_cmd="tar -czf $archive -C /var/tmp vega-artifacts"
tar -czf "$archive" -C /var/tmp vega-artifacts
printf '{"cmd":"%s","user":"svc_backup","unit":"vega-backup.service","source_dir":"/var/tmp/vega-artifacts","archive_path":"%s"}\n' \
    "$tar_cmd" "$archive" >> "$log_file"

upload_cmd="curl --disable --noproxy '*' -fsS --max-time 10 --data-binary @$archive http://backup.corp.internal:8443/upload"
reply=$(curl --disable --noproxy '*' -fsS --max-time 10 --data-binary "@$archive" http://backup.corp.internal:8443/upload)
printf '{"cmd":"%s","user":"svc_backup","unit":"vega-backup.service","dst_ip":"10.24.8.15"}\n' \
    "$upload_cmd" >> "$log_file"

printf 'Backup uploaded to backup.corp.internal: %s\n' "$reply"
sleep 3
JOB
sudo -n chmod 0755 /usr/local/bin/vega-backup-job

sudo -n tee /etc/systemd/system/vega-backup.service >/dev/null <<'UNIT'
[Unit]
Description=VEGA Scheduled Artifact Backup (svc_backup)
After=network-online.target

[Service]
Type=oneshot
User=svc_backup
Group=svc_backup
ExecStart=/usr/local/bin/vega-backup-job
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNIT

sudo -n tee /etc/sudoers.d/vega-backup >/dev/null <<'SUDO'
ubuntu ALL=(root) NOPASSWD: /usr/bin/systemctl start vega-backup.service
SUDO
sudo -n chmod 0440 /etc/sudoers.d/vega-backup

sudo -n systemctl daemon-reload

cat > /home/ubuntu/scheduled-backup <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
echo "Starting vega-backup.service as svc_backup -> backup.corp.internal..."
sudo -n systemctl start vega-backup.service
echo "Scheduled backup complete. Sentinel will inspect the window; Oracle Council should clear vm-c."
SCRIPT
chmod 0755 /home/ubuntu/scheduled-backup
echo "Provisioned vega-backup.service and ~/scheduled-backup on $(hostname)"
VM
