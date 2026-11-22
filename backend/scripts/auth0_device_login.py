"""Test employee sign-in from a headless VM with Auth0 Device Flow."""

import argparse
from http.client import HTTPConnection
import json
import os
from pathlib import Path
import re
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen


DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"
VAULT_ROUTE = "/v1/files/secrets.txt"


def auth_request(issuer, path, *, fields=None, bearer=None):
    request = Request(
        issuer + path,
        data=urlencode(fields).encode() if fields is not None else None,
        headers={"Authorization": f"Bearer {bearer}"} if bearer is not None else {},
    )
    try:
        with urlopen(request, timeout=8) as response:
            return response.status, json.load(response)
    except HTTPError as error:
        with error:
            try:
                return error.code, json.load(error)
            except ValueError:
                return error.code, {}


def vault_request(port, bearer=None):
    # Fixed loopback destination; never forward a vault token through a proxy or redirect.
    connection = HTTPConnection("127.0.0.1", port, timeout=10)
    try:
        headers = {"Authorization": f"Bearer {bearer}"} if bearer else {}
        connection.request("GET", VAULT_ROUTE, headers=headers)
        result = connection.getresponse()
        return result.status, result.read(64 * 1024)
    finally:
        connection.close()


def login(issuer, client_id, *, audience=None, vault_port=None, output=None):
    fields = {"client_id": client_id, "scope": "openid"}
    if vault_port is not None:
        status, _ = vault_request(vault_port)
        if status != 401:
            print(f"Expected a sign-in challenge from the local vault (got HTTP {status}); stopping.")
            return 1
        print("Sign in with Auth0 to open the vault.", flush=True)
        fields.update(audience=audience, scope="openid read:vault")
    status, device = auth_request(issuer, "/oauth/device/code", fields=fields)
    if status != 200:
        if audience and device.get("error_description") == f"Service not found: {audience}":
            print(f"Auth0 has not registered the vault API ({audience}). Register it before signing in.", file=sys.stderr)
        else:
            print(f"Could not start device login (HTTP {status}, {device.get('error', 'unknown error')}).", file=sys.stderr)
        return 1

    verification_uri = device["verification_uri"]
    uri = urlsplit(verification_uri)
    if (uri.scheme, uri.netloc) != ("https", urlsplit(issuer).netloc):
        print("Unexpected Auth0 verification URL; stopping.", file=sys.stderr)
        return 1

    lifetime = int(device["expires_in"])
    deadline = time.monotonic() + lifetime
    interval = max(1, int(device.get("interval", 5)))
    print(f"On your laptop, open {verification_uri} in a private browser window.", flush=True)
    print(f"Enter code {device['user_code']} and sign in as the test employee.", flush=True)
    print(f"Waiting for Auth0 (up to {lifetime // 60} min). Press Ctrl+C to stop.", flush=True)

    while time.monotonic() + interval < deadline:
        time.sleep(interval)
        try:
            status, result = auth_request(issuer, "/oauth/token", fields={
                "client_id": client_id,
                "device_code": device["device_code"],
                "grant_type": DEVICE_GRANT,
            })
        except (URLError, TimeoutError):
            interval = min(60, max(5, interval * 2))
            continue

        access_token = result.get("access_token")
        if status == 200 and access_token:
            if vault_port is not None:
                vault_status, body = vault_request(vault_port, bearer=access_token)
                if vault_status == 200:
                    if output is None:
                        print("Vault access granted (HTTP 200):")
                        print(body.decode("utf-8", errors="replace"), end="")
                    else:
                        fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                        with os.fdopen(fd, "wb") as file:
                            file.write(body)
                        print(f"Vault access granted (HTTP 200). Saved to {output}.")
                    return 0
                print(f"Vault did not return the file (HTTP {vault_status}): {body.decode('utf-8', errors='replace').strip()}")
                return 1
            profile_status, profile = auth_request(issuer, "/userinfo", bearer=access_token)
            if profile_status == 200 and isinstance(profile.get("sub"), str):
                print(f"Sign-in succeeded: Auth0 issued a token. User ID: {profile['sub']!r}")
                return 0
            print(f"Auth0 issued a token, but /userinfo did not verify an account (HTTP {profile_status}).")
            return 1
        error = result.get("error")
        if error == "slow_down" or status == 429:
            interval += 5
        elif error == "expired_token":
            break
        elif error != "authorization_pending":
            print(f"No token issued (Auth0 HTTP {status}, {error or 'unknown error'}).")
            return 1

    print("Device code expired without a token. Expiry alone does not prove the account is blocked.")
    return 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--domain", required=True, help="Auth0 tenant hostname")
    parser.add_argument("--client-id", required=True, help="Native application's Client ID (not Warden's)")
    parser.add_argument("--vault-port", type=int, help="Read secrets.txt through the loopback vault at this port")
    parser.add_argument("--audience", help="Auth0 custom API identifier for the vault")
    parser.add_argument("--output", type=Path, help="Save the authenticated file to a new local path")
    args = parser.parse_args()
    if args.output is not None and args.vault_port is None:
        parser.error("--output requires --vault-port")
    if (args.vault_port is None) != (args.audience is None):
        parser.error("--vault-port and --audience must be supplied together")
    if args.vault_port is not None and not 1 <= args.vault_port <= 65535:
        parser.error("invalid --vault-port")
    if not re.fullmatch(r"[a-z0-9-]+(?:\.[a-z0-9-]+)*\.auth0\.com", args.domain):
        parser.error("--domain must be an Auth0 hostname ending in .auth0.com")
    try:
        return login(f"https://{args.domain}", args.client_id, audience=args.audience, vault_port=args.vault_port, output=args.output)
    except FileExistsError:
        print("Output file already exists; refusing to overwrite it.", file=sys.stderr)
        return 1
    except (OSError, ValueError, KeyError) as error:
        print(f"Could not complete the Auth0 sign-in check ({type(error).__name__}).", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\nStopped waiting for Auth0.")
        return 130


if __name__ == "__main__":
    sys.exit(main())
