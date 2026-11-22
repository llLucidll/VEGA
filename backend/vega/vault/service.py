"""Read-only, loopback-only demo vault for a Multipass VM (requires PyJWT[crypto])."""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import socket
import stat
from dataclasses import dataclass
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import URLError
from urllib.request import Request, urlopen
from uuid import uuid4

import jwt


ROUTE = "/v1/files/secrets.txt"
READ_SCOPE = "read:vault"
MAX_FILE_BYTES = 64 * 1024
LOG = logging.getLogger("vega.vault")


@dataclass(frozen=True)
class VaultConfig:
    issuer: str
    audience: str
    client_id: str
    allowed_subjects: frozenset[str]
    file: Path
    blocked_users_file: Path
    ingest_url: str
    source_id: str
    run_id: str


class Vault:
    def __init__(self, config: VaultConfig, jwks: jwt.PyJWKClient | None = None) -> None:
        self.config = config
        self.jwks = jwks if jwks is not None else jwt.PyJWKClient(
            f"{config.issuer}.well-known/jwks.json", timeout=5
        )

    def verify(self, token: str) -> dict:
        if len(token) > 8192 or jwt.get_unverified_header(token).get("alg") != "RS256":
            raise jwt.InvalidTokenError("Expected an RS256 access token")
        key = self.jwks.get_signing_key_from_jwt(token)
        return jwt.decode(
            token,
            key.key,
            algorithms=["RS256"],
            audience=self.config.audience,
            issuer=self.config.issuer,
            options={"require": ["iss", "aud", "exp", "sub", "iat"]},
        )

    def audit(self, outcome: str, reason: str, request_id: str) -> bool:
        event = {
            "schema_version": 1,
            "run_id": self.config.run_id,
            "event_id": f"evt-{uuid4().hex}",
            "source_id": self.config.source_id,
            "channel": "file",
            "event_time": datetime.now(timezone.utc).isoformat(),
            "payload": {
                "op": outcome,
                "path": str(self.config.file),
                "resource": "demo-vault",
                "reason": reason,
                "request_id": request_id,
            },
        }
        request = Request(
            f"{self.config.ingest_url.rstrip('/')}/events",
            data=json.dumps(event).encode(),
            headers={"Content-Type": "application/json"},
        )
        try:
            with urlopen(request, timeout=4) as response:
                if response.status == 201:
                    return True
        except (URLError, TimeoutError, OSError):
            pass
        LOG.warning("Could not deliver %s file event to VEGA (request %s)", outcome, request_id)
        return False

    def read_file(self, authorization: str | None) -> tuple[int, bytes]:
        request_id = uuid4().hex

        def reject(status: int, reason: str) -> tuple[int, bytes]:
            self.audit("auth_required" if reason == "missing_token" else "access_denied", reason, request_id)
            return status, (reason + "\n").encode()

        if authorization is None:
            return reject(401, "missing_token")
        scheme, _, token = authorization.partition(" ")
        if scheme.lower() != "bearer" or not token or any(char.isspace() for char in token):
            return reject(401, "invalid_token")
        try:
            claims = self.verify(token)
        except jwt.PyJWKClientConnectionError:
            return reject(503, "identity_service_unavailable")
        except jwt.PyJWTError:
            return reject(401, "invalid_token")
        if claims.get("azp") != self.config.client_id or claims["sub"] not in self.config.allowed_subjects:
            return reject(403, "account_not_allowed")
        scope = claims.get("scope")
        if not isinstance(scope, str) or READ_SCOPE not in scope.split():
            return reject(403, "missing_scope")
        try:
            blocked = {line.strip() for line in self.config.blocked_users_file.read_text().splitlines()}
        except (OSError, UnicodeError):
            return reject(503, "access_policy_unavailable")
        if claims["sub"] in blocked:
            return reject(403, "account_blocked")

        # The service serves exactly one configured file, never a request-provided filesystem path.
        try:
            fd = os.open(self.config.file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, "rb") as file:
                if not stat.S_ISREG(os.fstat(file.fileno()).st_mode):
                    return reject(503, "file_unavailable")
                content = file.read(MAX_FILE_BYTES + 1)
        except OSError:
            return reject(503, "file_unavailable")
        if len(content) > MAX_FILE_BYTES:
            return reject(503, "file_unavailable")
        if not self.audit("access_granted", "verified_token", request_id):
            return 503, b"telemetry_unavailable\n"
        return 200, content


class VaultServer(ThreadingHTTPServer):
    def __init__(self, port: int, vault: Vault) -> None:
        self.vault = vault
        super().__init__(("127.0.0.1", port), VaultHandler)

    def get_request(self) -> tuple[socket.socket, tuple[str, int]]:
        connection, address = super().get_request()
        connection.settimeout(10)
        return connection, address


class VaultHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path == ROUTE:
            headers = self.headers.get_all("Authorization", [])
            auth = headers[0] if len(headers) == 1 else ("" if headers else None)
            status, body = self.server.vault.read_file(auth)
        else:
            status, body = 404, b"not_found\n"
        self.send_response(status)
        if status == 401:
            self.send_header("WWW-Authenticate", 'Bearer realm="vega-vault"')
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format: str, *args: object) -> None:
        # Don't copy arbitrary request lines or headers into logs.
        return


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--domain", required=True)
    parser.add_argument("--audience", required=True)
    parser.add_argument("--client-id", required=True)
    subjects = parser.add_mutually_exclusive_group(required=True)
    subjects.add_argument("--allow-subject", action="append", help="Authorized Auth0 subject (repeatable)")
    subjects.add_argument("--deny-all", action="store_true", help="Run sign-in challenges without granting reads until enrollment")
    parser.add_argument("--file", required=True, type=Path)
    parser.add_argument("--blocked-users-file", required=True, type=Path)
    parser.add_argument("--ingest-url", required=True)
    parser.add_argument("--source-id", required=True)
    parser.add_argument("--run-id", default="auth0-vault-demo")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z0-9-]+(?:\.[a-z0-9-]+)*\.auth0\.com", args.domain):
        parser.error("--domain must be an Auth0 hostname ending in .auth0.com")
    logging.basicConfig(level=logging.INFO)
    config = VaultConfig(
        issuer=f"https://{args.domain}/",
        audience=args.audience,
        client_id=args.client_id,
        allowed_subjects=frozenset(args.allow_subject or ()),
        file=args.file,
        blocked_users_file=args.blocked_users_file,
        ingest_url=args.ingest_url,
        source_id=args.source_id,
        run_id=args.run_id,
    )
    with VaultServer(args.port, Vault(config)) as server:
        LOG.info("Listening on http://127.0.0.1:%d%s for %s", server.server_port, ROUTE, config.source_id)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
