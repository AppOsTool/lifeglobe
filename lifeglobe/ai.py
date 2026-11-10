"""AI providers. Default is Ollama: the model runs on this computer and no text leaves it.
OpenAI and Claude are optional and use the person's own key. Every call returns JSON that matches a schema."""
import json
import urllib.error
import urllib.request

TIMEOUT = 180


class AIError(Exception):
    """code: not_configured | unreachable | auth | rate_limited | refused | bad_answer | failed"""

    def __init__(self, code: str, detail: str = ""):
        super().__init__(f"{code}: {detail}")
        self.code, self.detail = code, detail


def _post(url: str, body: dict, headers: dict) -> dict:
    req = urllib.request.Request(url, json.dumps(body).encode(), {"Content-Type": "application/json", **headers})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        code = {401: "auth", 403: "auth", 429: "rate_limited"}.get(e.code, "failed")
        raise AIError(code, e.read().decode(errors="replace")[:300])
    except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
        raise AIError("unreachable", str(e))


def _parse(text: str) -> dict:
    text = (text or "").strip()
    start, end = text.find("{"), text.rfind("}")
    try:
        return json.loads(text[start:end + 1])
    except ValueError:
        raise AIError("bad_answer", text[:200])


def _ollama(s: dict, system: str, messages: list, schema: dict) -> dict:
    url = s["ollama_url"].rstrip("/") + "/api/chat"
    body = {"model": s["ollama_model"], "stream": False, "format": schema,
            "messages": [{"role": "system", "content": system}] + messages}
    return _parse(_post(url, body, {}).get("message", {}).get("content", ""))


def _openai(s: dict, system: str, messages: list, schema: dict) -> dict:
    if not s.get("openai_key"):
        raise AIError("not_configured", "openai key")
    body = {"model": s["openai_model"],
            "messages": [{"role": "system", "content": system}] + messages,
            "response_format": {"type": "json_schema", "json_schema": {"name": "answer", "schema": schema}}}
    r = _post("https://api.openai.com/v1/chat/completions", body, {"Authorization": "Bearer " + s["openai_key"]})
    return _parse(r["choices"][0]["message"]["content"])


def _anthropic(s: dict, system: str, messages: list, schema: dict) -> dict:
    if not s.get("anthropic_key"):
        raise AIError("not_configured", "anthropic key")
    try:
        import anthropic
    except ImportError:
        raise AIError("not_configured", 'install the Claude extra: pip install "lifeglobe[claude]"')
    client = anthropic.Anthropic(api_key=s["anthropic_key"], timeout=TIMEOUT)
    try:
        # Fallbacks are on: if the model declines, the API reruns the request on a suitable model.
        resp = client.beta.messages.create(
            model=s["anthropic_model"], max_tokens=16000, system=system, messages=messages,
            output_config={"format": {"type": "json_schema", "schema": schema}},
            betas=["server-side-fallback-2026-07-01"], fallbacks="default")
    except anthropic.AuthenticationError as e:
        raise AIError("auth", str(e))
    except anthropic.RateLimitError as e:
        raise AIError("rate_limited", str(e))
    except anthropic.APIStatusError as e:
        raise AIError("failed", f"{e.status_code} {e.message}")
    except anthropic.APIConnectionError as e:
        raise AIError("unreachable", str(e))
    if resp.stop_reason == "refusal":
        raise AIError("refused", "")
    return _parse(next((b.text for b in resp.content if b.type == "text"), ""))


PROVIDERS = {"ollama": _ollama, "openai": _openai, "anthropic": _anthropic}


def ask_json(settings: dict, system: str, messages: list, schema: dict) -> dict:
    return PROVIDERS[settings.get("provider", "ollama")](settings, system, messages, schema)


def ollama_models(settings: dict) -> list[str]:
    try:
        with urllib.request.urlopen(settings["ollama_url"].rstrip("/") + "/api/tags", timeout=5) as r:
            return [m["name"] for m in json.loads(r.read()).get("models", [])]
    except Exception:
        return []
