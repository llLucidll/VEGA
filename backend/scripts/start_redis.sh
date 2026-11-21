#!/usr/bin/env bash
set -euo pipefail

# Memory-only Redis 7.4+ per VEGA Ephemeral Streams spec (no RDB snapshots, no AOF)
exec redis-server --port 6379 --save "" --appendonly no
