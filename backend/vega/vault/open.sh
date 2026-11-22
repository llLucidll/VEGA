#!/bin/sh
# VM launcher; this config contains only public OAuth client settings.
set -eu
. /etc/vega-auth0-vault/client.conf
exec /usr/bin/python3 /opt/vega-auth0-vault/device_login.py \
  --domain "$AUTH0_DOMAIN" --client-id "$AUTH0_CLIENT_ID" \
  --vault-port "$VAULT_PORT" --audience "$VAULT_AUDIENCE" "$@"
