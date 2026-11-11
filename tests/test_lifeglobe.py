"""Run: python -m unittest -v   (no extra packages needed; the AI is replaced by a fake)."""
import http.client
import json
import os
import stat
import tempfile
import threading
import unittest
from pathlib import Path

from lifeglobe import ai, tasks
from lifeglobe.server import serve
from lifeglobe.settings import Settings
from lifeglobe.storage import BACKUPS_KEPT, BadBrain, Store, empty_brain, validate


def brain():
    b = empty_brain({"family": "Family", "work": "Work", "projects": "P", "craft": "C", "values": "V", "self": "S"})
    b["nodes"].append({"id": "a", "type": "goal", "sphere": "family", "title": "Dinner with kids", "date": "2026-01-01"})
    b["nodes"].append({"id": "b", "type": "belief", "sphere": "work", "title": "More hours, more money", "date": "2026-01-01"})
    b["links"].append({"s": "b", "t": "a", "rel": "contradicts", "note": "evenings"})
    return b


class StorageTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.store = Store(self.root)

    def test_save_load_and_backups(self):
        b = brain()
        for i in range(BACKUPS_KEPT + 5):
            b["nodes"][1]["title"] = f"v{i}"
            self.store.save(b)
        self.assertEqual(self.store.load()["nodes"][1]["title"], f"v{BACKUPS_KEPT + 4}")
        self.assertLessEqual(len(list((self.root / "backups").glob("*.json"))), BACKUPS_KEPT)

    def test_validate_rejects_broken_maps(self):
        for broken in ({}, {"nodes": [], "links": [], "spheres": []},
                       dict(brain(), links=[{"s": "a", "t": "ghost", "rel": "tied"}]),
                       dict(brain(), nodes=brain()["nodes"] + [brain()["nodes"][1]]),
                       dict(brain(), nodes=[n for n in brain()["nodes"] if n["id"] != "me"])):
            with self.assertRaises(BadBrain):
                validate(broken)
        self.assertFalse(self.store.exists())


class SettingsTest(unittest.TestCase):
    def test_keys_stay_private(self):
        root = Path(tempfile.mkdtemp())
        s = Settings(root)
        pub = s.update({"anthropic_key": "sk-ant-secret", "language": "xx", "provider": "evil"})
        self.assertNotIn("anthropic_key", pub)
        self.assertTrue(pub["has_anthropic_key"])
        self.assertEqual((pub["language"], pub["provider"]), ("en", "ollama"))
        s.update({"anthropic_key": ""})                         # empty field keeps the saved key
        self.assertEqual(Settings(root).data["anthropic_key"], "sk-ant-secret")
        self.assertEqual(stat.S_IMODE(os.stat(root / "settings.json").st_mode), 0o600)


class FakeAI:
    """Stands in for every provider; records what it was asked."""

    def __init__(self):
        self.calls, self.reply, self.fail = [], None, None

    def __call__(self, settings, system, messages, schema):
        self.calls.append((system, messages[-1]["content"], schema))
        if self.fail:
            raise ai.AIError(self.fail)
        return self.reply


class ServerTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.fake = FakeAI()
        self._orig = dict(ai.PROVIDERS)
        for k in ai.PROVIDERS:
            ai.PROVIDERS[k] = self.fake
        self.srv = serve(Store(self.root), Settings(self.root), "127.0.0.1", 0)
        self.port = self.srv.server_address[1]
        # the server checks Host against its own port, so rebuild the handler with the real port
        from lifeglobe.server import App, make_handler
        self.srv.RequestHandlerClass = make_handler(App(Store(self.root), Settings(self.root), self.port))
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        ai.PROVIDERS.update(self._orig)

    def req(self, method, path, body=None, host=None, origin=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        h = {"Host": host or f"127.0.0.1:{self.port}", "Content-Type": "application/json"}
        if origin:
            h["Origin"] = origin
        c.request(method, path, json.dumps(body) if body is not None else None, h)
        r = c.getresponse()
        data = r.read()
        ctype = r.getheader("Content-Type", "")
        c.close()
        return r.status, (json.loads(data) if ctype.startswith("application/json") else data)

    def test_first_open_creates_map_in_interface_language(self):
        self.req("PUT", "/api/settings", {"language": "ru"})
        st, b = self.req("GET", "/api/brain")
        self.assertEqual(st, 200)
        self.assertEqual([s["title"] for s in b["spheres"]][0], "Семья")
        self.assertTrue((self.root / "brain.json").exists())

    def test_page_and_static(self):
        st, html = self.req("GET", "/")
        self.assertEqual(st, 200)
        self.assertIn(b"/static/app.js", html)
        self.assertEqual(self.req("GET", "/static/../server.py")[0], 404)
        self.assertEqual(self.req("GET", "/static/%2e%2e/server.py")[0], 404)
        st, demo = self.req("GET", "/api/demo")
        self.assertEqual(st, 200)
        validate(demo)

    def test_other_sites_are_refused(self):
        self.assertEqual(self.req("GET", "/api/brain", host="evil.example:80")[0], 403)
        self.assertEqual(self.req("PUT", "/api/brain", brain(), origin="http://evil.example")[0], 403)
        self.assertEqual(self.req("PUT", "/api/brain", brain(), origin=f"http://localhost:{self.port}")[0], 200)

    def test_bad_save_does_not_touch_the_file(self):
        self.req("PUT", "/api/brain", brain())
        st, err = self.req("PUT", "/api/brain", {"nodes": "oops"})
        self.assertEqual((st, err["error"]), (400, "bad_brain"))
        self.assertEqual(len(json.loads((self.root / "brain.json").read_text())["nodes"]), 3)

    def test_think_adds_drafts_and_only_valid_links(self):
        self.req("PUT", "/api/brain", brain())
        self.fake.reply = {"nodes": [
            {"key": "n1", "type": "principle", "sphere": "family", "title": "Calls end at six", "text": "After six — family.", "quote": ""},
            {"key": "n2", "type": "weird", "sphere": "nowhere", "title": "Fallbacks work", "text": "", "quote": "x"},
            {"key": "n3", "type": "goal", "sphere": "family", "title": "", "text": "no title — dropped", "quote": ""}],
            "links": [{"s": "n1", "t": "a", "rel": "supports", "note": ""},
                      {"s": "n1", "t": "ghost", "rel": "tied", "note": ""},
                      {"s": "a", "t": "b", "rel": "tied", "note": "between old points — not allowed"},
                      {"s": "n2", "t": "b", "rel": "nonsense", "note": ""}]}
        st, added = self.req("POST", "/api/think", {"text": "I want to stop working at night"})
        self.assertEqual(st, 200)
        self.assertEqual([n["title"] for n in added["nodes"]], ["Calls end at six", "Fallbacks work"])
        self.assertTrue(all(n["draft"] for n in added["nodes"]))
        self.assertEqual((added["nodes"][1]["type"], added["nodes"][1]["sphere"]), ("experience", "family"))
        self.assertEqual([(l["t"], l["rel"]) for l in added["links"]], [("a", "supports")])
        saved = json.loads((self.root / "brain.json").read_text())
        self.assertEqual(len(saved["nodes"]), 5)
        validate(saved)
        system, prompt, _ = self.fake.calls[-1]
        self.assertIn("Dinner with kids", prompt)        # the AI sees the existing map
        self.assertIn("English", system)                 # and writes in the interface language

    def test_conflict_dialogue(self):
        self.req("PUT", "/api/brain", brain())
        self.fake.reply = {"kind": "question", "text": "What matters more?", "principle": ""}
        st, r = self.req("POST", "/api/conflict", {"s": "b", "t": "a", "dialogue": []})
        self.assertEqual((st, r), (200, {"question": "What matters more?"}))
        self.fake.reply = {"kind": "question", "text": "Resolved: six o'clock.", "principle": "Six o'clock — Calls end at six."}
        st, r = self.req("POST", "/api/conflict", {"s": "b", "t": "a", "dialogue": [{"q": "?", "a": "kids"}], "force": True})
        self.assertEqual(r["proposal"]["summary"], "Resolved: six o'clock.")       # force turns a question into a proposal
        self.assertEqual(r["proposal"]["principle"], {"title": "Six o'clock", "text": "Calls end at six."})
        self.assertIn("Enough questions", self.fake.calls[-1][1])
        self.assertEqual(self.req("POST", "/api/conflict", {"s": "a", "t": "b"})[0], 404)

    def test_ai_errors_are_readable(self):
        self.req("PUT", "/api/brain", brain())
        self.fake.fail = "unreachable"
        st, r = self.req("POST", "/api/think", {"text": "hello"})
        self.assertEqual((st, r["error"]), (502, "ai_unreachable"))
        self.assertEqual(self.req("POST", "/api/think", {"text": "  "})[0], 400)


class TranslationsTest(unittest.TestCase):
    def test_every_language_has_every_text(self):
        folder = Path(__file__).resolve().parent.parent / "lifeglobe" / "static" / "i18n"
        en = set(json.loads((folder / "en.json").read_text(encoding="utf-8")))
        for f in folder.glob("*.json"):
            keys = set(json.loads(f.read_text(encoding="utf-8")))
            plural_extras = {k for k in keys - en if k.rsplit(".", 1)[-1] in ("zero", "two", "few", "many")}
            self.assertEqual(keys - plural_extras, en, f.name)


class SchemaTest(unittest.TestCase):
    def test_schemas_are_strict(self):
        for schema in (tasks.THINK_SCHEMA, tasks.CONFLICT_SCHEMA):
            self.assertFalse(schema["additionalProperties"])
            self.assertEqual(set(schema["required"]), set(schema["properties"]))


if __name__ == "__main__":
    unittest.main()
