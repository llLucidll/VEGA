# VEGA Auth0 demo vault

On `vm-a`, `vm-b`, and `vm-c`, `~/sensitive_data/` is the entry point. It contains the `open` launcher, not a copy of the protected data. The vault serves `secrets.txt` at `/v1/files/secrets.txt` over VM loopback. The file lives at `/srv/sensitive_data/secrets.txt` and is readable by the `vega-vault` service account, not by the regular VM user. A user with VM root/sudo can bypass this demo boundary; don't place real secrets here.

## Register the API in Auth0

1. In **Applications → APIs → Create API**, use name `VEGA Vault`, identifier `https://vega.demo/vault`, and signing algorithm `RS256`. The identifier is an audience string, not a URL the VM needs to reach.
2. Add `read:vault` in the API's **Permissions** tab. Use the Auth0 access-token profile (the vault checks the `azp` claim). Allow the **VEGA VM Demo** Native application user access to this API if the API access policy requires explicit authorization.
3. Keep **Device Code** and the database connection enabled on the Native app. The Warden Management API credentials are not required on the VM.

## Read the demo file on a VM

```bash
~/sensitive_data/open
```

Regular `cd` and `cat` do not start OAuth. Use the launcher to request a protected read.

The command first requests the file without credentials. On `401`, it starts Device Flow and prints the browser URL and code. Use the VM's test employee account in the browser. The command retries the local read with the resulting access token and does not save or print that token.

The service requires a signed RS256 token for the configured issuer, audience, client, allowed subject, and `read:vault` scope. It emits `auth_required`, `access_granted`, and `access_denied` metadata to VEGA Central's `file` channel. It does not emit user IDs, credentials, or file contents. A permitted read fails closed if VEGA ingest does not acknowledge the event.

## Service settings and containment

Run `python3 -m vega.vault.service --help` from the backend to see settings. On all three VMs, `vega-auth0-vault.service` runs as a dedicated non-root user and binds only to `127.0.0.1:8765`. Point `--ingest-url` at the same VEGA listener used by the VM collector. Set each VM's `--source-id` and explicitly allowlist its test employee's Auth0 `sub` with `--allow-subject`. Until their subjects are configured, `vm-b` and `vm-c` run with `--deny-all`: they can start sign-in but will not release the file.

The service reads the root-managed `--blocked-users-file` on each request. It expects one Auth0 user ID per line (empty means none are locally blocked) and returns `403` for listed users even with an otherwise valid token. The Warden CLI's Auth0 account block prevents new sign-ins but does not populate this file. Wiring those two controls together is a separate step.
