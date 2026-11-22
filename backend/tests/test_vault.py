from datetime import datetime, timezone
from types import SimpleNamespace

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

from vega.vault.service import Vault, VaultConfig


@pytest.fixture
def vault_setup(tmp_path, monkeypatch):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    config = VaultConfig(
        issuer="https://example.us.auth0.com/",
        audience="https://vega.demo/vault",
        client_id="native-demo",
        allowed_subjects=frozenset({"auth0|demo"}),
        file=tmp_path / "secrets.txt",
        blocked_users_file=tmp_path / "blocked-users",
        ingest_url="http://127.0.0.1:8000",
        source_id="vm-a",
        run_id="vault-test",
    )
    config.file.write_bytes(b"Synthetic vault data\n")
    config.blocked_users_file.touch()
    jwks = SimpleNamespace(get_signing_key_from_jwt=lambda _: SimpleNamespace(key=key.public_key()))
    vault = Vault(config, jwks=jwks)
    events = []
    monkeypatch.setattr(vault, "audit", lambda *args: events.append(args) or True)

    def authorization(**overrides):
        now = int(datetime.now(timezone.utc).timestamp())
        claims = {
            "iss": config.issuer, "aud": config.audience, "azp": config.client_id,
            "sub": "auth0|demo", "scope": "openid read:vault", "iat": now, "exp": now + 300,
        } | overrides
        return "Bearer " + jwt.encode(claims, key, algorithm="RS256")

    return vault, authorization, events


def test_login_challenge_and_grant(vault_setup):
    vault, authorization, events = vault_setup
    assert vault.read_file(None) == (401, b"missing_token\n")
    assert vault.read_file(authorization()) == (200, b"Synthetic vault data\n")
    assert [(outcome, reason) for outcome, reason, _ in events] == [
        ("auth_required", "missing_token"), ("access_granted", "verified_token"),
    ]


@pytest.mark.parametrize(("override", "status", "reason"), [
    ({"aud": "another-api"}, 401, b"invalid_token\n"),
    ({"iss": "https://different.us.auth0.com/"}, 401, b"invalid_token\n"),
    ({"iat": 0, "exp": 0}, 401, b"invalid_token\n"),
    ({"azp": "other-client"}, 403, b"account_not_allowed\n"),
    ({"sub": "auth0|other"}, 403, b"account_not_allowed\n"),
    ({"scope": "openid"}, 403, b"missing_scope\n"),
])
def test_wrong_claims_are_denied(vault_setup, override, status, reason):
    vault, authorization, events = vault_setup
    assert vault.read_file(authorization(**override)) == (status, reason)
    assert events[-1][0] == "access_denied"


def test_policy_blocks_an_already_issued_token(vault_setup):
    vault, authorization, _ = vault_setup
    token = authorization()
    assert vault.read_file(token)[0] == 200
    vault.config.blocked_users_file.write_text("auth0|demo\n")
    assert vault.read_file(token) == (403, b"account_blocked\n")


def test_audit_unavailable_does_not_release_file(vault_setup, monkeypatch):
    vault, authorization, _ = vault_setup
    monkeypatch.setattr(vault, "audit", lambda *_: False)
    assert vault.read_file(authorization()) == (503, b"telemetry_unavailable\n")
