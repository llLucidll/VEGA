import os

# Force offline deterministic settings before vega.config / vega.api are imported,
# even when backend/.env defines GEMINI_API_KEY or VEGA_STREAM_BACKEND=redis.
os.environ["VEGA_SWARM_MODE"] = "heuristic"
os.environ["VEGA_STREAM_BACKEND"] = "memory"
