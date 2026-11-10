"""Local web server: serves the page and a small JSON API. Listens on this computer only."""
import json
import mimetypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from . import ai, tasks
from .settings import Settings
from .storage import BadBrain, Store, empty_brain

STATIC = Path(__file__).with_name("static")
MAX_BODY = 8 * 1024 * 1024


def sphere_titles(lang: str) -> dict:
    path = STATIC / "i18n" / f"{lang}.json"
    if not path.exists():
        path = STATIC / "i18n" / "en.json"
    t = json.loads(path.read_text(encoding="utf-8"))
    titles = {k.split(".", 1)[1]: v for k, v in t.items() if k.startswith("sphere.")}
    titles["me"] = t.get("me", "Me")
    return titles


class App:
    def __init__(self, store: Store, settings: Settings, port: int):
        self.store, self.settings, self.port = store, settings, port

    def brain(self) -> dict:
        b = self.store.load()
        if b is None:
            b = self.store.save(empty_brain(sphere_titles(self.settings.data["language"])))
        return b


def make_handler(app: App):
    allowed_hosts = {f"127.0.0.1:{app.port}", f"localhost:{app.port}"}

    class Handler(BaseHTTPRequestHandler):
        server_version = "lifeglobe"

        def log_message(self, fmt, *args):     # quiet: nothing personal ends up in the terminal
            pass

        # --- helpers
        def _send(self, code: int, body: bytes, ctype: str, extra: dict | None = None):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy",
                             "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
                             "connect-src 'self'; frame-ancestors 'none'")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def _json(self, code: int, obj):
            self._send(code, json.dumps(obj, ensure_ascii=False).encode(), "application/json; charset=utf-8")

        def _error(self, code: int, err: str, detail: str = ""):
            self._json(code, {"error": err, "detail": detail})

        def _trusted(self) -> bool:
            """Only this computer's own page may talk to the API (blocks DNS rebinding and other sites)."""
            if self.headers.get("Host") not in allowed_hosts:
                return False
            origin = self.headers.get("Origin")
            if origin and urlparse(origin).netloc not in allowed_hosts:
                return False
            return True

        def _body(self):
            n = int(self.headers.get("Content-Length") or 0)
            if n > MAX_BODY:
                raise ValueError("too_big")
            return json.loads(self.rfile.read(n) or b"{}")

        # --- routes
        def do_GET(self):
            if not self._trusted():
                return self._error(403, "forbidden")
            path = urlparse(self.path).path
            if path == "/":
                return self._file(STATIC / "index.html")
            if path.startswith("/static/"):
                target = (STATIC / path[len("/static/"):]).resolve()
                if STATIC.resolve() not in target.parents or not target.is_file():
                    return self._error(404, "not_found")
                return self._file(target)
            if path == "/api/brain":
                return self._json(200, app.brain())
            if path == "/api/demo":
                return self._file(STATIC / "demo.json")
            if path == "/api/settings":
                return self._json(200, app.settings.public())
            if path == "/api/models":
                return self._json(200, {"ollama": ai.ollama_models(app.settings.data)})
            return self._error(404, "not_found")

        def do_PUT(self):
            if not self._trusted():
                return self._error(403, "forbidden")
            path = urlparse(self.path).path
            try:
                body = self._body()
            except ValueError as e:
                return self._error(400, str(e) if str(e) == "too_big" else "bad_json")
            if path == "/api/brain":
                try:
                    return self._json(200, app.store.save(body))
                except BadBrain as e:
                    return self._error(400, "bad_brain", str(e))
            if path == "/api/settings":
                return self._json(200, app.settings.update(body))
            return self._error(404, "not_found")

        def do_POST(self):
            if not self._trusted():
                return self._error(403, "forbidden")
            path = urlparse(self.path).path
            try:
                body = self._body()
            except ValueError:
                return self._error(400, "bad_json")
            try:
                if path == "/api/think":
                    text = (body.get("text") or "").strip()
                    if not text:
                        return self._error(400, "empty")
                    brain = app.brain()
                    added = tasks.think(app.settings.data, brain, text)
                    app.store.save(brain)
                    return self._json(200, added)
                if path == "/api/conflict":
                    brain = app.brain()
                    link = next((l for l in brain["links"] if l["s"] == body.get("s") and l["t"] == body.get("t")
                                 and l["rel"] == "contradicts"), None)
                    if not link:
                        return self._error(404, "not_found")
                    dialogue = [d for d in body.get("dialogue") or [] if isinstance(d, dict)][:6]
                    return self._json(200, tasks.conflict_turn(app.settings.data, brain, link, dialogue, bool(body.get("force"))))
            except ai.AIError as e:
                return self._error(502, "ai_" + e.code, e.detail)
            return self._error(404, "not_found")

        def _file(self, path: Path):
            ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
                ctype += "; charset=utf-8"
            self._send(200, path.read_bytes(), ctype)

    return Handler


def serve(store: Store, settings: Settings, host: str, port: int) -> ThreadingHTTPServer:
    app = App(store, settings, port)
    return ThreadingHTTPServer((host, port), make_handler(app))
