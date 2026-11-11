"""What the AI does: turn a thought into points and links; talk a contradiction through. Results are always drafts."""
import time

from . import ai
from .settings import LANGUAGES
from .storage import RELS, TYPES, today

MAX_NEW_NODES = 3
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
    "text": _S,          # the question, or the resolution in the first person
    "principle": _S,     # "Title — one sentence" if a new rule for myself was born, else ""
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
        "Rules:\n"
        "1. Make points ONLY from the person's new words at the end. Never invent beliefs, values or facts they did not say.\n"
        f"2. Usually 1–2 new points, at most {MAX_NEW_NODES}. One idea = one point.\n"
        "3. Points already on the map must NOT be created again: refer to them by their id in links.\n"
        "4. If they want two things and one gets in the way of the other, make a link with rel=contradicts between "
        "those two points and say in note what pulls against what.\n"
        "5. Link only what is clearly related in meaning. Fewer links are better than wrong ones.\n\n"
        f"Point fields: key (n1, n2, …), type ({TYPE_HELP}), sphere (a sphere id), title (2–7 words), "
        "text (1–2 short sentences in the first person), quote (a few of the person's own words, or empty).\n"
        f"Link fields: s and t are new keys or existing ids; rel is one of: {REL_HELP}; note is a few words or empty.\n\n"
        "Example. Map already has: w1 [work] Freelance design. New words: \"I want evenings with my son, but clients "
        "call me until ten.\" Good answer: nodes = [{key n1, type goal, sphere family, title \"Evenings with my son\"}, "
        "{key n2, type experience, sphere work, title \"Clients call until ten\"}]; links = [{s n2, t n1, rel "
        "contradicts, note \"late calls take my evenings\"}, {s n2, t w1, rel part}].\n\n"
        f"{_map_summary(brain)}\n\n"
        f"THE PERSON'S NEW WORDS (make points only from these):\n\"\"\"\n{text}\n\"\"\"")
    ans = ai.ask_json(settings, system, [{"role": "user", "content": prompt}], THINK_SCHEMA)

    spheres = {s["id"] for s in brain["spheres"]}
    existing = {n["id"] for n in brain["nodes"]}
    norm = lambda t: " ".join(t.lower().split())
    by_title = {norm(n["title"]): n["id"] for n in brain["nodes"] if n.get("type") != "me"}
    stamp = format(int(time.time() * 1000), "x")
    keymap, added = {}, []
    for i, n in enumerate((ans.get("nodes") or [])[:MAX_NEW_NODES]):
        title = (n.get("title") or "").strip()
        if not title:
            continue
        if norm(title) in by_title:                      # the model repeated a point: link to the one we have
            keymap[n.get("key") or title] = by_title[norm(title)]
            continue
        nid = f"n{stamp}{i}"
        keymap[n.get("key") or nid] = nid
        by_title[norm(title)] = nid
        node = {"id": nid, "type": n.get("type") if n.get("type") in TYPES else "experience",
                "sphere": n.get("sphere") if n.get("sphere") in spheres else brain["spheres"][0]["id"],
                "title": title, "text": (n.get("text") or "").strip(), "date": today(), "draft": True}
        if (n.get("quote") or "").strip():
            node["quote"] = n["quote"].strip()
        added.append(node)
    if not added and not any(l.get("rel") == "contradicts" for l in ans.get("links") or []):
        raise ai.AIError("bad_answer", "no points")
    new_ids = {n["id"] for n in added}
    valid = existing | new_ids
    links = []
    for l in ans.get("links") or []:
        s, t = keymap.get(l.get("s"), l.get("s")), keymap.get(l.get("t"), l.get("t"))
        if s in valid and t in valid and s != t and l.get("rel") in RELS and (s in new_ids or t in new_ids or l["rel"] == "contradicts"):
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
        f"Write only in {lang}. Address the person informally"
        + (" (use «ты», never «вы»)" if settings.get("language") in ("ru", "uk") else "") + ". Keep it simple.")
    talk = "\n".join(f"Q: {d['q']}\nA: {d['a']}" for d in dialogue) or "(no questions asked yet)"
    force = force or len(dialogue) >= 3
    prompt = (
        f"Point A (id {a['id']}): {line(a)}\nPoint B (id {b['id']}): {line(b)}\n"
        f"Why they conflict: {link.get('note') or 'not stated'}\n\nConversation so far:\n{talk}\n\n"
        + ("Enough questions: now give a proposal.\n" if force else
           "Either ask the next question (kind=question) or, if it is clear already, give a proposal.\n")
        + "Answer with kind=question and text=the question (at most 25 words), or kind=proposal and text=1–2 sentences (at most 40 words) written as the "
        "person speaking (\"I …\"), built ONLY from their answers above: restate how THEY reconcile it. Never add "
        "your own advice or new ideas. principle: if the conversation produced a new rule for "
        "myself, write it as \"Title — one sentence\", otherwise an empty string.")
    ans = ai.ask_json(settings, system, [{"role": "user", "content": prompt}], CONFLICT_SCHEMA)
    text = (ans.get("text") or "").strip()
    if ans.get("kind") == "question" and not force and text:
        return {"question": text}
    if not text:
        raise ai.AIError("bad_answer", "empty proposal")
    principle = None
    raw = (ans.get("principle") or "").strip()
    if raw:
        title, _, rest = raw.partition("—")
        principle = {"title": title.strip(" -—"), "text": rest.strip()}
    return {"proposal": {"summary": text, "edits": [], "principle": principle}}
