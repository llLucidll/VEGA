from typing import Literal

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="VEGA_", env_file=".env", extra="ignore")

    stream_backend: Literal["memory", "redis"] = "memory"
    redis_url: str = "redis://127.0.0.1:6379/0"
    retention_seconds: int = 600
    cleanup_interval_seconds: int = 5
    window_seconds: int = Field(default=120, ge=1)
    early_analysis: bool = True
    stage_delay_seconds: float = Field(default=5.0, ge=0.0)
    demo_topology: bool = True
    channels: tuple[str, ...] = ("file", "network", "process")

    swarm_mode: Literal["auto", "gemini", "heuristic"] = "auto"
    swarm_max_concurrency: int = 6
    gemini_model: str = "gemini-3.5-flash-lite"
    gemini_api_key: str = Field(
        default="",
        validation_alias=AliasChoices("VEGA_GEMINI_API_KEY", "GEMINI_API_KEY"),
    )

    # TypeSafe AI System One (Jev) + Warden live containment
    typesafe_api_key: str = Field(
        default="",
        validation_alias=AliasChoices("VEGA_TYPESAFE_API_KEY", "TYPESAFE_API_KEY"),
    )
    jev_model: str = "jev-latest"
    jev_timeout_seconds: float = 10.0
    jev_confidence_threshold: float = 0.75
    jev_probability_threshold: float = 0.80
    jev_safe_automate_threshold: float = 0.70

    warden_enabled: bool = True
    warden_dry_run: bool = False
    warden_telemetry_host: str = "10.97.0.1"
    warden_vm_subjects: dict[str, str] = Field(
        default_factory=lambda: {"vm-a": "auth0|6b01f488d9d84efdf43850d4"}
    )
    auth0_domain: str = Field(
        default="dev-aouetthi51by1teb.us.auth0.com",
        validation_alias=AliasChoices("VEGA_AUTH0_DOMAIN", "AUTH0_DOMAIN"),
    )
    auth0_warden_client_id: str = Field(
        default="",
        validation_alias=AliasChoices("VEGA_AUTH0_WARDEN_CLIENT_ID", "AUTH0_WARDEN_CLIENT_ID"),
    )
    auth0_warden_secret: str = Field(
        default="",
        validation_alias=AliasChoices(
            "VEGA_AUTH0_WARDEN_SECRET",
            "AUTH0_WARDEN_CLIENT_SECRET",
            "Auth0_WARDEN_SECRET",
        ),
    )


settings = Settings()
