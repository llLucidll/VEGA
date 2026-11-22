"""Check Warden's Auth0 token grant or block/unblock a disposable account."""

import argparse
import getpass
import json
import os
import re
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


SCOPE = "update:users"


def set_user_blocked(issuer: str, access_token: str, user_id: str, *, blocked: bool) -> int:
    action = "block" if blocked else "unblock"
    request = Request(
        f"{issuer}/api/v2/users/{quote(user_id, safe='')}",
        method="PATCH",
        data=json.dumps({"blocked": blocked}).encode(),
        headers={"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"},
    )
    try:
        with urlopen(request, timeout=10) as response:
            user = json.load(response)
    except HTTPError as exc:
        print(f"Auth0 returned HTTP {exc.code} for the {action} request.", file=sys.stderr)
        return 1
    except (URLError, TimeoutError, ValueError):
        print(f"Could not confirm the {action}. Check the user's status in Auth0.", file=sys.stderr)
        return 1
    if not isinstance(user, dict) or user.get("user_id") != user_id or user.get("blocked") is not blocked:
        print(f"Auth0 did not confirm the {action} for the requested user.", file=sys.stderr)
        return 1
    print(f"Auth0 confirmed the test account is {action}ed.")
    if blocked:
        print("This does not revoke existing access tokens.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--domain", required=True, help="Auth0 tenant hostname without https://")
    parser.add_argument("--client-id", required=True, help="Warden Machine-to-Machine client ID")
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument("--block-test-user", metavar="USER_ID", help="Block a disposable Auth0 database user")
    actions.add_argument("--unblock-test-user", metavar="USER_ID", help="Unblock a disposable Auth0 database user")
    parser.add_argument("--yes", action="store_true", help="Confirm the specified block or unblock without prompting")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z0-9-]+(?:\.[a-z0-9-]+)*\.auth0\.com", args.domain):
        parser.error("--domain must be an Auth0 tenant hostname ending in .auth0.com")
    blocked = args.block_test_user is not None
    user_id = args.block_test_user if blocked else args.unblock_test_user
    action = "block" if blocked else "unblock"
    if user_id is not None:
        if not re.fullmatch(r"auth0\|[a-zA-Z0-9_-]+", user_id):
            parser.error("provide the demo user's Auth0 ID (auth0|…)")
        if not args.yes and not sys.stdin.isatty():
            parser.error(f"{action} requires confirmation (use --yes for automation)")
    elif args.yes:
        parser.error("--yes requires a block or unblock action")

    secret = os.environ.get("Auth0_WARDEN_SECRET") or os.environ.get("AUTH0_WARDEN_CLIENT_SECRET")
    if not secret:
        if not sys.stdin.isatty():
            parser.error("run in an interactive terminal or set AUTH0_WARDEN_CLIENT_SECRET securely")
        secret = getpass.getpass("Warden client secret: ")
    if not secret:
        parser.error("client secret is required")

    issuer = f"https://{args.domain}"
    request = Request(
        f"{issuer}/oauth/token",
        data=json.dumps({
            "grant_type": "client_credentials",
            "client_id": args.client_id,
            "client_secret": secret,
            "audience": f"{issuer}/api/v2/",
            "scope": SCOPE,
        }).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urlopen(request, timeout=10) as response:
            token = json.load(response)
    except HTTPError as exc:
        print(f"Auth0 rejected the token request (HTTP {exc.code}).", file=sys.stderr)
        return 1
    except (URLError, TimeoutError, ValueError):
        print("Could not get a usable token response from Auth0.", file=sys.stderr)
        return 1

    if not isinstance(token, dict) or not token.get("access_token"):
        print("Auth0 did not return an access token.", file=sys.stderr)
        return 1
    scopes = set(str(token.get("scope", "")).split())
    if SCOPE not in scopes:
        print(f"Auth0 issued a token but did not report the {SCOPE} scope.", file=sys.stderr)
        return 1
    if user_id is None:
        print(f"Auth0 issued a Management API token with {SCOPE}. No accounts were changed.")
        if scopes - {SCOPE}:
            print("Warning: the token has additional scopes. Narrow the Warden app's API permissions.")
        return 0

    if scopes != {SCOPE}:
        print(f"{action.capitalize()} not attempted: grant the Warden app only {SCOPE} and retry.", file=sys.stderr)
        return 1
    if not args.yes:
        answer = input(f"{action.capitalize()} test user {user_id} in {args.domain}? Type '{action}' to confirm: ")
        if answer != action:
            print("Cancelled. No accounts were changed.")
            return 1
    return set_user_blocked(issuer, token["access_token"], user_id, blocked=blocked)


if __name__ == "__main__":
    sys.exit(main())
