"""Local storage: one JSON file with the whole map, plus rolling backups. Nothing leaves this computer."""
import json
import os
import time
from pathlib import Path

TYPES = {"goal", "principle", "belief", "knowledge", "project", "experience", "people"}
RELS = {"tied", "part", "applies", "derives", "supports", "contradicts", "taught"}
BACKUPS_KEPT = 20

# Six default spheres. Titles come from the interface language on first run; people rename them freely.
DEFAULT_SPHERES = [
    ("family", "#ff8f73"), ("work", "#f0d36a"), ("projects", "#6fb4ff"),
    ("craft", "#56d0a8"), ("values", "#c39bff"), ("self", "#a6d66a"),
]


def data_dir() -> Path:
    return Path(os.environ.get("LIFEGLOBE_HOME") or Path.home() / ".lifeglobe")


def today() -> str:
    return time.strftime("%Y-%m-%d")


def empty_brain(sphere_titles: dict) -> dict:
    return {
        "version": 1,
        "updated": today(),
        "spheres": [{"id": k, "title": sphere_titles.get(k, k), "color": c} for k, c in DEFAULT_SPHERES],
        "nodes": [{"id": "me", "type": "me", "title": sphere_titles.get("me", "Me"), "date": today(), "text": ""}],
        "links": [],
    }


class BadBrain(ValueError):
    pass


def validate(b: dict) -> dict:
    """Light checks so a broken save can never wipe the map: shapes, unique ids, links point to real nodes."""
    if not isinstance(b, dict) or not isinstance(b.get("nodes"), list) or not isinstance(b.get("links"), list) \
            or not isinstance(b.get("spheres"), list) or not b["spheres"]:
        raise BadBrain("bad_shape")
    sphere_ids = set()
    for s in b["spheres"]:
        if not isinstance(s, dict) or not s.get("id") or not s.get("title"):
            raise BadBrain("bad_sphere")
        sphere_ids.add(s["id"])
    ids = set()
    for n in b["nodes"]:
        if not isinstance(n, dict) or not n.get("id") or not isinstance(n.get("title"), str):
            raise BadBrain("bad_node")
        if n["id"] in ids:
            raise BadBrain("duplicate_id")
        ids.add(n["id"])
        if n.get("type") != "me" and (n.get("type") not in TYPES or n.get("sphere") not in sphere_ids):
            raise BadBrain("bad_node")
    if "me" not in ids:
        raise BadBrain("no_center")
    for l in b["links"]:
        if not isinstance(l, dict) or l.get("s") not in ids or l.get("t") not in ids or l.get("rel") not in RELS:
            raise BadBrain("bad_link")
    return b


class Store:
    def __init__(self, root: Path | None = None):
        self.root = root or data_dir()
        self.path = self.root / "brain.json"
        self.backups = self.root / "backups"

    def exists(self) -> bool:
        return self.path.exists()

    def load(self) -> dict | None:
        if not self.path.exists():
            return None
        return json.loads(self.path.read_text(encoding="utf-8"))

    def save(self, brain: dict) -> dict:
        validate(brain)
        brain["updated"] = today()
        self.root.mkdir(parents=True, exist_ok=True)
        if self.path.exists():
            self.backups.mkdir(exist_ok=True)
            stamp = time.strftime("%Y%m%d-%H%M%S")
            (self.backups / f"brain-{stamp}.json").write_bytes(self.path.read_bytes())
            for old in sorted(self.backups.glob("brain-*.json"))[:-BACKUPS_KEPT]:
                old.unlink()
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(brain, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(tmp, self.path)
        return brain
