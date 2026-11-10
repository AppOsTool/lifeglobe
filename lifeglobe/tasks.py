"""What the AI does: turn a thought into points and links; talk a contradiction through. Results are always drafts."""
import time

from . import ai
from .settings import LANGUAGES
from .storage import RELS, TYPES, today

MAX_NEW_NODES = 4
CONTEXT_NODES = 200

_S = {"type": "string"}


def _obj(props: dict) -> dict:
    return {"type": "object", "properties": props, "required": list(props), "additionalProperties": False}


THINK_SCHEMA = _obj({
    "nodes": {"type": "array", "items": _obj({
        "key": _S, "type": {"type": "string", "enum": sorted(TYPES)}, "sphere": _S,
        "title": _S, "text": _S, "quote": _S})},
    "links": {"type": "array", "items": _obj({
        "s": _S, "t": _S, "rel": {"type": "string", "enum": sorted(RELS)}, "note": _S})},
})

CONFLICT_SCHEMA = _obj({
    "kind": {"type": "string", "enum": ["question", "proposal"]},
    "question": _S, "summary": _S,
    "edits": {"type": "array", "items": _obj({"id": _S, "text": _S})},
    "principle_title": _S, "principle_text": _S,
})

REL_HELP = ("tied (related), part (is part of), applies (is applied in), derives (follows from), "
            "supports (confirms), contradicts (conflicts with), taught (taught me)")
TYPE_HELP = ("goal, principle (a rule I live by), belief, knowledge, project, "
             "experience (something that happened), people (a person or a place)")


def _lang(code: str) -> str:
    return LANGUAGES.get(code, "English")


def _map_summary(brain: dict) -> str:
    spheres = "\n".join(f"- {s['id']}: {s['title']}" for s in brain["spheres"])
    nodes = [n for n in brain["nodes"] if n.get("type") != "me"][-CONTEXT_NODES:]
    points = "\n".join(f"- {n['id']} [{n['sphere']}] {n['title']}" for n in nodes) or "(empty yet)"
    return f"Life spheres:\n{spheres}\n\nPoints already on the map:\n{points}"


def think(settings: dict, brain: dict, text: str) -> dict:
    """Adds 1–4 draft points and their links to the brain (in place) and returns what was added."""
    system = (
        "You help a person build a visual map of their life: points (thoughts, goals, principles, events, people) "
        "placed in life spheres and connected by labelled links. You turn what the person writes into points.\n"
        f"Write every title and text in {_lang(settings.get('language'))}, in the first person, as the person "
        "would say it. Keep their meaning; do not add advice, judgement or diagnoses.")
    prompt = (
        f"{_map_summary(brain)}\n\nThe person writes:\n\"\"\"\n{text}\n\"\"\"\n\n"
        f"Create 1–{MAX_NEW_NODES} new points from this. Each point: key (n1, n2, …), type ({TYPE_HELP}), "
        "sphere (one of the sphere ids above), title (2–7 words), text (1–3 short sentences), "
        "quote (a short phrase in the person's own words, or empty).\n"
        f"Then links: s and t are keys of new points or ids of existing points; rel is one of: {REL_HELP}; "
        "note explains the link in a few words or is empty. Link each new point to 1–3 relevant points. "
        "Use contradicts only when two points really pull in opposite directions.")
    ans = ai.ask_json(settings, system, [{"role": "user", "content": prompt}], THINK_SCHEMA)

    spheres = {s["id"] for s in brain["spheres"]}
    existing = {n["id"] for n in brain["nodes"]}
    stamp = format(int(time.time() * 1000), "x")
    keymap, added = {}, []
    for i, n in enumerate((ans.get("nodes") or [])[:MAX_NEW_NODES]):
        title = (n.get("title") or "").strip()
        if not title:
            continue
        nid = f"n{stamp}{i}"
        keymap[n.get("key") or nid] = nid
        node = {"id": nid, "type": n.get("type") if n.get("type") in TYPES else "experience",
                "sphere": n.get("sphere") if n.get("sphere") in spheres else brain["spheres"][0]["id"],
                "title": title, "text": (n.get("text") or "").strip(), "date": today(), "draft": True}
        if (n.get("quote") or "").strip():
            node["quote"] = n["quote"].strip()
        added.append(node)
    if not added:
        raise ai.AIError("bad_answer", "no points")
    valid = existing | set(keymap.values())
    links = []
    for l in ans.get("links") or []:
        s, t = keymap.get(l.get("s"), l.get("s")), keymap.get(l.get("t"), l.get("t"))
        if s in valid and t in valid and s != t and l.get("rel") in RELS and (s in keymap.values() or t in keymap.values()):
            link = {"s": s, "t": t, "rel": l["rel"], "draft": True}
            if (l.get("note") or "").strip():
                link["note"] = l["note"].strip()
            links.append(link)
    brain["nodes"].extend(added)
    brain["links"].extend(links)
    return {"nodes": added, "links": links}


def conflict_turn(settings: dict, brain: dict, link: dict, dialogue: list[dict], force: bool = False) -> dict:
    """One step of talking a contradiction through. dialogue: [{"q": question, "a": answer}, …]."""
    nodes = {n["id"]: n for n in brain["nodes"]}
    a, b = nodes[link["s"]], nodes[link["t"]]

    def line(n):
        return f"«{n['title']}» — {n.get('text', '')}" + (f" (in my words: «{n['quote']}»)" if n.get("quote") else "")

    lang = _lang(settings.get("language"))
    system = (
        "You help a person resolve a contradiction in their life map. You ask short questions, one at a time, "
        "to understand how they themselves reconcile the two points: what matters more, where the line is, what "
        "they will do. At most three questions. No advice, no moralising, no diagnoses. "
        f"Write in {lang}, address the person informally, keep it simple.")
    talk = "\n".join(f"Q: {d['q']}\nA: {d['a']}" for d in dialogue) or "(no questions asked yet)"
    force = force or len(dialogue) >= 3
    prompt = (
        f"Point A (id {a['id']}): {line(a)}\nPoint B (id {b['id']}): {line(b)}\n"
        f"Why they conflict: {link.get('note') or 'not stated'}\n\nConversation so far:\n{talk}\n\n"
        + ("Enough questions: now give a proposal.\n" if force else
           "Either ask the next question (kind=question) or, if it is clear already, give a proposal.\n")
        + "Proposal (kind=proposal): summary — 1–2 sentences in the first person that resolve it in the person's "
        f"own words; edits — new full texts for point {a['id']} or {b['id']} only if the conversation made them "
        "wrong, otherwise empty; principle_title and principle_text — a new rule for myself if one was born, "
        "otherwise empty strings. Unused fields are empty strings.")
    ans = ai.ask_json(settings, system, [{"role": "user", "content": prompt}], CONFLICT_SCHEMA)
    if ans.get("kind") == "question" and not force and (ans.get("question") or "").strip():
        return {"question": ans["question"].strip()}
    if not (ans.get("summary") or "").strip():
        raise ai.AIError("bad_answer", "empty proposal")
    edits = [e for e in ans.get("edits") or [] if e.get("id") in (a["id"], b["id"]) and (e.get("text") or "").strip()]
    principle = None
    if (ans.get("principle_title") or "").strip():
        principle = {"title": ans["principle_title"].strip(), "text": (ans.get("principle_text") or "").strip()}
    return {"proposal": {"summary": ans["summary"].strip(), "edits": edits, "principle": principle}}
