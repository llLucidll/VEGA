#!/usr/bin/env bash
# Exercise the file and process collectors with synthetic content only.
set -euo pipefail
umask 077
fixture=$(mktemp -d /tmp/vega-sentinel.XXXXXX)
trap 'rm -f -- "$fixture/vega-demo.txt"; rmdir -- "$fixture"' EXIT
archive="/tmp/.cache-bundle-${fixture##*.}.tgz"
printf 'Synthetic VEGA Sentinel demo data.\n' > "$fixture/vega-demo.txt"

cmd=(tar -czf "$archive" -C "$fixture" vega-demo.txt)
"${cmd[@]}"
# The collector tails Bash history; record the exact command this script ran.
printf -v command_line '%q ' "${cmd[@]}"
history -s "${command_line% }"
history -a "$HOME/.bash_history"
printf 'Demo archive: %s\n' "$archive"
