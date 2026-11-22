import os

# Force offline deterministic settings before vega.config / vega.api are imported,
# even when backend/.env defines GEMINI_API_KEY, TYPESAFE_API_KEY, or VEGA_STREAM_BACKEND=redis.
os.environ["VEGA_SWARM_MODE"] = "heuristic"
os.environ["VEGA_STREAM_BACKEND"] = "memory"
os.environ["VEGA_WARDEN_DRY_RUN"] = "true"
os.environ["VEGA_STAGE_DELAY_SECONDS"] = "0"
os.environ["VEGA_DEMO_TOPOLOGY"] = "false"
os.environ["TYPESAFE_API_KEY"] = ""
os.environ["VEGA_TYPESAFE_API_KEY"] = ""
