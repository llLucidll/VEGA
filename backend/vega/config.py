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
    channels: tuple[str, ...] = ("file", "network", "process")

    swarm_mode: Literal["auto", "gemini", "heuristic"] = "auto"
    swarm_max_concurrency: int = 6
    gemini_model: str = "gemini-3.5-flash-lite"
    gemini_api_key: str = Field(
        default="",
        validation_alias=AliasChoices("VEGA_GEMINI_API_KEY", "GEMINI_API_KEY"),
    )


settings = Settings()
