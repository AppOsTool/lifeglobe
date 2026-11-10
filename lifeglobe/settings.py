"""Settings live next to the map. API keys never leave this computer and are never sent to the browser."""
import json
import os
from pathlib import Path

LANGUAGES = {"en": "English", "ru": "Русский", "uk": "Українська"}
PROVIDERS = ("ollama", "openai", "anthropic")
DEFAULTS = {
    "language": "en",
    "provider": "ollama",
    "ollama_url": "http://127.0.0.1:11434",
    "ollama_model": "qwen2.5:7b",
    "openai_model": "gpt-5.4-mini",
    "openai_key": "",
    "anthropic_model": "claude-sonnet-5-5",
    "anthropic_key": "",
}
SECRET = ("openai_key", "anthropic_key")


class Settings:
    def __init__(self, root: Path):
        self.path = root / "settings.json"
        self.data = dict(DEFAULTS)
        if self.path.exists():
            self.data.update(json.loads(self.path.read_text(encoding="utf-8")))

    def public(self) -> dict:
        """What the page may see: everything except the keys themselves."""
        out = {k: v for k, v in self.data.items() if k not in SECRET}
        out.update({f"has_{k}": bool(self.data.get(k)) for k in SECRET})
        out["languages"] = LANGUAGES
        return out

    def update(self, patch: dict) -> dict:
        for k, v in patch.items():
            if k not in DEFAULTS or not isinstance(v, str):
                continue
            if k == "language" and v not in LANGUAGES:
                continue
            if k == "provider" and v not in PROVIDERS:
                continue
            if k in SECRET and v == "":
                continue                     # empty field in the form = keep the saved key
            self.data[k] = v.strip()
        if patch.get("forget_keys"):
            for k in SECRET:
                self.data[k] = ""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self.data, indent=1), encoding="utf-8")
        os.chmod(self.path, 0o600)
        return self.public()
