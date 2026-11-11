/* lifeglobe — a private, local map of how your life fits together.
   Data comes from the local server (/api/brain). Every text on screen comes from /static/i18n/<lang>.json. */
"use strict";

const $ = id => document.getElementById(id);
let I18N = {}, SETTINGS = {}, DATA = null;
const DEMO = new URLSearchParams(location.search).has("demo");
const t = (k, v = {}) => String(I18N[k] ?? k).replace(/\{(\w+)\}/g, (_, x) => v[x] ?? "");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const today = () => new Date().toISOString().slice(0, 10);

async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || String(r.status)), { code: j.error || "failed", detail: j.detail });
  return j;
}
const aiError = e => I18N["ai." + String(e.code || "failed").replace(/^ai_/, "")] || t("ai.failed");

let saveTimer = null;
function persist(now = false) {
  if (DEMO) return Promise.resolve();
  clearTimeout(saveTimer);
  const go = () => api("/api/brain", { method: "PUT", body: JSON.stringify(DATA) }).catch(e => alert(t("save.failed") + " " + (e.detail || e.code)));
  if (now) return go();
  saveTimer = setTimeout(go, 300);
  return Promise.resolve();
}

async function boot() {
  SETTINGS = await api("/api/settings");
  I18N = await (await fetch(`/static/i18n/${SETTINGS.language || "en"}.json`)).json();
  document.documentElement.lang = SETTINGS.language || "en";
  DATA = DEMO ? await api("/api/demo") : await api("/api/brain");
  document.querySelectorAll("[data-i18n]").forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll("[data-i18n-ph]").forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
  document.querySelectorAll("[data-i18n-aria]").forEach(el => { el.setAttribute("aria-label", t(el.dataset.i18nAria)); });
  $("demoBar").hidden = !DEMO;
  if (DEMO) { $("thinkBtn").hidden = true; }
  build();
}

/* ======================= the whole view ======================= */
function build() {
  const SPHERES = DATA.spheres.map(s => ({ ...s }));
  const SPH = Object.fromEntries(SPHERES.map(s => [s.id, s]));
  const TYPES = {
    goal: d3.symbolDiamond, principle: d3.symbolSquare, belief: d3.symbolTriangle, knowledge: d3.symbolWye,
    project: d3.symbolCircle, experience: d3.symbolStar, people: d3.symbolCircle
  };
  const REL = ["tied", "part", "applies", "derives", "supports", "contradicts", "taught"];
  const fmtDate = d => new Date(d + "T12:00:00").toLocaleDateString(SETTINGS.language || "en", { day: "2-digit", month: "2-digit", year: "numeric" });
  const shortDate = d => new Date(d + "T12:00:00").toLocaleDateString(SETTINGS.language || "en", { day: "2-digit", month: "2-digit" });
  const colorOf = n => n.type === "me" ? "#f2b450" : (SPH[n.type === "sphere" ? n.id.slice(4) : n.sphere] || SPHERES[0]).color;
  const plural = (n, key) => {
    const rules = new Intl.PluralRules(SETTINGS.language || "en");
    const k = `${key}.${rules.select(n)}`;
    return t(I18N[k] !== undefined ? k : `${key}.other`, { n });
  };

  const nodes = [
    ...DATA.nodes.map(n => ({ ...n })),
    ...SPHERES.map(s => ({ id: "hub_" + s.id, type: "sphere", title: s.title, text: "", sphere: s.id }))
  ];
  const byId = new Map(nodes.map(n => [n.id, n]));
  const links = DATA.links.filter(l => byId.has(l.s) && byId.has(l.t)).map(l => {
    const a = byId.get(l.s), b = byId.get(l.t);
    return { ...l, source: a, target: b, cross: a.sphere !== b.sphere };
  });
  const degree = new Map();
  links.forEach(l => { degree.set(l.s, (degree.get(l.s) || 0) + 1); degree.set(l.t, (degree.get(l.t) || 0) + 1); });
  nodes.forEach(n => { n.r = n.type === "me" ? 26 : n.type === "sphere" ? 15 : n.priority ? 15 : 7 + Math.sqrt(degree.get(n.id) || 1) * 2.4; });
  const counts = Object.fromEntries(SPHERES.map(s => [s.id, nodes.filter(n => n.sphere === s.id && n.type !== "sphere").length]));
  const realCount = () => nodes.filter(n => n.type !== "sphere" && n.type !== "me" && !n._removed).length;
  $("empty").hidden = realCount() > 0;
  $("emptyThink").onclick = () => openThink();

  /* ---------- state & visibility ---------- */
  const state = { hidden: new Set(), routes: false, onlyConflicts: false, selected: "me", until: null };
  const isNew = n => n.date && n.type !== "me" && n.type !== "sphere" && (Date.now() - new Date(n.date + "T12:00:00")) / 864e5 <= 3;
  const inConflict = id => links.some(l => l.rel === "contradicts" && (l.source.id === id || l.target.id === id));
  function nodeVisible(n) {
    if (n.type === "me") return true;
    if (n._removed) return false;
    if (state.until && n.date && n.type !== "sphere" && n.date > state.until) return false;
    if (state.hidden.has(n.sphere)) return false;
    if (state.onlyConflicts && n.type !== "sphere") return inConflict(n.id);
    return true;
  }
  function neighbours(id) {
    const n0 = byId.get(id), s = new Set([id]);
    if (!n0) return s;
    if (n0.type === "sphere") { nodes.forEach(n => { if (n.sphere === n0.sphere) s.add(n.id); }); s.add("me"); return s; }
    links.forEach(l => { if (l.source.id === id) s.add(l.target.id); if (l.target.id === id) s.add(l.source.id); });
    if (n0.sphere) s.add("hub_" + n0.sphere);
    return s;
  }

  /* ---------- flat map ---------- */
  const weight = s => Math.max(counts[s.id], 5);
  const totalW = SPHERES.reduce((a, s) => a + weight(s), 0);
  let acc = -Math.PI / 6;
  SPHERES.forEach(s => { s.a0 = acc; acc += weight(s) / totalW * Math.PI * 2; s.a1 = acc; s.mid = (s.a0 + s.a1) / 2; });
  const R_HUB = 150, R_IN = 95;
  const polar = (a, r) => [Math.sin(a) * r, -Math.cos(a) * r];
  const me = byId.get("me"); me.fx = 0; me.fy = 0;
  SPHERES.forEach(s => {
    const h = byId.get("hub_" + s.id); [h.fx, h.fy] = polar(s.mid, R_HUB);
    nodes.filter(n => n.sphere === s.id && n.type !== "sphere").forEach((n, i, arr) => {
      [n.x, n.y] = polar(s.a0 + (s.a1 - s.a0) * (i + 0.5) / arr.length, 270 + (i % 4) * 70);
    });
  });
  function sectorForce(alpha) {
    nodes.forEach(n => {
      if (n.type === "me" || n.type === "sphere") return;
      const s = SPH[n.sphere];
      let a = Math.atan2(n.x, -n.y);
      while (a < s.a0 - Math.PI) a += 2 * Math.PI;
      while (a > s.a0 + Math.PI) a -= 2 * Math.PI;
      const pad = Math.min(0.12, (s.a1 - s.a0) / 6);
      const [tx, ty] = polar(Math.max(s.a0 + pad, Math.min(s.a1 - pad, a)), Math.max(230, Math.hypot(n.x, n.y)));
      n.vx += (tx - n.x) * 0.5 * alpha; n.vy += (ty - n.y) * 0.5 * alpha;
    });
  }
  const sim = d3.forceSimulation(nodes)
    .force("link", d3.forceLink(links.filter(l => !l.cross)).distance(70).strength(0.15))
    .force("charge", d3.forceManyBody().strength(-220).distanceMax(300))
    .force("collide", d3.forceCollide(n => n.r + 30).strength(1))
    .force("radial", d3.forceRadial(n => n.type === "me" || n.type === "sphere" ? 0 : 360, 0, 0).strength(n => n.type === "me" || n.type === "sphere" ? 0 : 0.06))
    .force("sector", sectorForce).stop();
  for (let i = 0; i < 400; i++) sim.tick();

  const svg = d3.select("#graph"), stage = $("stage");
  const mapRoot = svg.append("g");
  const zoom = d3.zoom().scaleExtent([0.25, 3]).on("zoom", e => mapRoot.attr("transform", e.transform));
  svg.call(zoom).on("dblclick.zoom", null);
  const outerR = Math.max(300, ...nodes.map(n => Math.hypot(n.x, n.y))) + 70;
  const wedgeArc = d3.arc().innerRadius(R_IN).outerRadius(outerR);
  const gW = mapRoot.append("g");
  gW.selectAll("path").data(SPHERES).join("path").attr("class", "wedge")
    .attr("d", s => wedgeArc({ startAngle: s.a0, endAngle: s.a1 })).attr("fill", s => s.color).attr("fill-opacity", 0.06);
  gW.selectAll("text").data(SPHERES).join("text").attr("class", "wedge-label").attr("fill", s => s.color).attr("text-anchor", "middle")
    .attr("transform", s => { const [x, y] = polar(s.mid, outerR + 26); return `translate(${x},${y + 5})`; }).text(s => s.title);
  const spokes = [
    ...SPHERES.map(s => ({ a: me, b: byId.get("hub_" + s.id), c: s.color })),
    ...nodes.filter(n => n.sphere && n.type !== "sphere").map(n => ({ a: byId.get("hub_" + n.sphere), b: n, c: SPH[n.sphere].color }))
  ];
  const spokeSel = mapRoot.append("g").selectAll("line").data(spokes).join("line").attr("class", "spoke").attr("stroke", d => d.c);
  const linkSel = mapRoot.append("g").selectAll("path").data(links).join("path");
  const linkClass = () => linkSel.attr("class", l => `link ${l.rel}${l.draft ? " draft" : ""}`);
  linkClass();
  const nodeSel = mapRoot.append("g").selectAll("g").data(nodes).join("g")
    .attr("class", n => ["node", n.type, n.draft && "draft", n.priority && "priority"].filter(Boolean).join(" "))
    .attr("tabindex", 0).attr("role", "button").attr("aria-label", n => n.title)
    .on("click", (e, n) => { e.stopPropagation(); select(n.id, true); })
    .on("keydown", (e, n) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(n.id, true); } })
    .on("mouseenter", (e, n) => highlight(n.id)).on("mouseleave", () => highlight(state.selected));
  nodeSel.filter(isNew).append("circle").attr("class", "g-new").attr("r", n => n.r + 6);
  nodeSel.append("path")
    .attr("d", n => d3.symbol(n.type === "me" || n.type === "sphere" ? d3.symbolCircle : TYPES[n.type], Math.PI * n.r * n.r * (n.type === "me" || n.type === "sphere" ? 1 : 1.25))())
    .attr("fill", colorOf);
  function wrap(s, max = 15) {
    const words = String(s).split(" "), lines = []; let cur = "";
    words.forEach(w => { if ((cur + " " + w).trim().length > max && cur) { lines.push(cur); cur = w; } else cur = (cur + " " + w).trim(); });
    if (cur) lines.push(cur);
    return lines.slice(0, 3);
  }
  nodeSel.each(function (n) {
    const tx = d3.select(this).append("text").attr("text-anchor", "middle");
    (n.type === "me" ? [n.title] : wrap(n.title)).forEach((ln, i) => tx.append("tspan").attr("x", 0).attr("dy", i === 0 ? n.r + 14 : 13).text(ln));
  });
  function curve(l) {
    const { x: x1, y: y1 } = l.source, { x: x2, y: y2 } = l.target;
    if (!l.cross) return `M${x1},${y1}L${x2},${y2}`;
    return `M${x1},${y1}Q${(x1 + x2) / 2 * 0.35},${(y1 + y2) / 2 * 0.35} ${x2},${y2}`;
  }
  function drawMap() {
    spokeSel.attr("x1", d => d.a.x).attr("y1", d => d.a.y).attr("x2", d => d.b.x).attr("y2", d => d.b.y);
    linkSel.attr("d", curve);
    nodeSel.attr("transform", n => `translate(${n.x},${n.y})`);
  }
  drawMap();
  nodeSel.call(d3.drag().filter(e => !e.button)
    .on("start", (e, n) => { if (n.type === "me" || n.type === "sphere") return; n.fx = n.x; n.fy = n.y; })
    .on("drag", (e, n) => { if (n.type === "me" || n.type === "sphere") return; n.x = n.fx = e.x; n.y = n.fy = e.y; drawMap(); }));
  function fit() {
    const W = stage.clientWidth, H = stage.clientHeight, R = outerR + 75;
    if (!W || !H) return;
    svg.call(zoom.transform, d3.zoomIdentity.translate(W / 2, H / 2).scale(Math.min(W / (2 * R), H / (2 * R), 1.3)));
  }
  window.addEventListener("resize", () => { if (!$("graph").hasAttribute("hidden")) fit(); });
  svg.on("click", () => select("me", false));

  function linkVisible(l) {
    if (!nodeVisible(l.source) || !nodeVisible(l.target)) return false;
    if (state.onlyConflicts) return l.rel === "contradicts";
    if (!l.cross || l.rel === "contradicts") return true;
    return state.routes || l.source.id === state.selected || l.target.id === state.selected;
  }
  function applyVisibility() {
    nodeSel.classed("hidden", n => !nodeVisible(n));
    spokeSel.classed("hidden", d => !nodeVisible(d.a) || !nodeVisible(d.b));
    linkSel.classed("hidden", l => !linkVisible(l))
      .classed("route", l => l.cross && (state.routes || l.source.id === state.selected || l.target.id === state.selected));
    globe.touch();
  }
  function highlight(id) {
    if (!id || id === "me") { nodeSel.classed("dim", false); linkSel.classed("dim", false); spokeSel.classed("dim", false); return; }
    const nb = neighbours(id);
    nodeSel.classed("dim", n => !nb.has(n.id));
    linkSel.classed("dim", l => l.source.id !== id && l.target.id !== id);
    spokeSel.classed("dim", d => !(nb.has(d.a.id) && nb.has(d.b.id)));
  }

  /* ---------- header stats & chips ---------- */
  function renderStats() {
    const c = links.filter(l => l.rel === "contradicts").length, dr = nodes.filter(n => n.draft && !n._removed).length, r = realCount();
    $("stats").innerHTML = `<span>${plural(r, "stats.points")}</span><span>${plural(SPHERES.length, "stats.spheres")}</span>` +
      (c ? `<span class="warn">${plural(c, "stats.conflicts")}</span>` : "") + (dr ? `<span>${plural(dr, "stats.drafts")}</span>` : "");
  }
  const chips = $("chips");
  chips.innerHTML = SPHERES.map(s => `<button class="chip" type="button" data-sphere="${esc(s.id)}" aria-pressed="true"><i style="background:${esc(s.color)}"></i>${esc(s.title)}</button>`).join("") +
    `<span class="sep"></span>` +
    `<button class="chip mode" type="button" id="routesBtn" aria-pressed="false">${esc(t("chips.routes"))}</button>` +
    `<button class="chip mode" type="button" id="conflictsBtn" aria-pressed="false">${esc(t("chips.onlyConflicts"))}</button>` +
    `<span class="sep"></span>` +
    `<button class="chip" type="button" id="newBtn"></button>` +
    `<button class="chip" type="button" id="reviewBtn"></button>` +
    `<button class="chip" type="button" id="conflictBtn" hidden></button>` +
    `<span class="timeline"><button type="button" id="tlPlay" aria-label="${esc(t("timeline.play"))}">▶</button>` +
    `<input type="range" id="tl" min="0" value="0" aria-label="${esc(t("timeline.label"))}"><span id="tlLbl"></span></span>`;
  chips.addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.id === "routesBtn") { state.routes = !state.routes; b.setAttribute("aria-pressed", state.routes); applyVisibility(); return; }
    if (b.id === "conflictsBtn") { state.onlyConflicts = !state.onlyConflicts; b.setAttribute("aria-pressed", state.onlyConflicts); applyVisibility(); return; }
    const s = b.dataset.sphere;
    if (!s) return;
    if (state.hidden.has(s)) toggleSphere(s);
    select("hub_" + s, true);
  });
  function toggleSphere(s) {
    state.hidden.has(s) ? state.hidden.delete(s) : state.hidden.add(s);
    const chip = chips.querySelector(`[data-sphere="${CSS.escape(s)}"]`);
    if (chip) chip.setAttribute("aria-pressed", !state.hidden.has(s));
    applyVisibility();
  }
  const legendRel = (color, dash, label) => `<span><svg class="wide" viewBox="0 0 26 8"><line x1="0" y1="4" x2="26" y2="4" stroke="${color}" stroke-width="1.8" ${dash ? `stroke-dasharray="${dash}"` : ""}/></svg>${esc(label)}</span>`;
  $("legend").innerHTML = Object.keys(TYPES).filter(k => k !== "people").map(k =>
    `<span><svg viewBox="-7 -7 14 14"><path d="${d3.symbol(TYPES[k], 40)()}" fill="#8e97ad"/></svg>${esc(t(k === "project" ? "legend.projectPeople" : "type." + k))}</span>`).join("") +
    legendRel("#ff6a6a", "6 4", t("rel.contradicts")) + legendRel("#f2b450", "", t("legend.route")) +
    `<span><svg viewBox="-7 -7 14 14"><circle r="5" fill="none" stroke="#ebe8e0" stroke-dasharray="2 2"/></svg>${esc(t("legend.draft"))}</span>`;

  /* ---------- selection & side panel ---------- */
  function select(id, focus) {
    if (!byId.has(id)) id = "me";
    state.selected = id;
    nodeSel.classed("selected", n => n.id === id);
    applyVisibility();
    highlight(id);
    renderPanel(byId.get(id));
    globe.onSelect(id, focus);
    if (focus && id !== "me" && !$("graph").hasAttribute("hidden") && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const n = byId.get(id);
      svg.transition().duration(450).call(zoom.translateTo, n.x, n.y);
    }
  }
  const item = (n, extra = "", right = "") =>
    `<button class="rel-item" type="button" data-id="${esc(n.id)}"><i style="background:${esc(colorOf(n))}"></i>` +
    `<span>${esc(n.title)}${n.draft ? ` <small style="display:inline">· ${esc(t("draft"))}</small>` : ""}${extra}</span>${right}</button>`;
  function renderPanel(n) {
    let pills, body = "";
    if (n.type === "me") {
      pills = `<span class="pill" style="background:#f2b450">${esc(t("me"))}</span>`;
      body = `<div class="rels"><h3>${esc(t("panel.spheres"))}</h3>` + SPHERES.map(s =>
        item(byId.get("hub_" + s.id), "", `<span class="count">${counts[s.id]}</span>`)).join("") + `</div>`;
    } else if (n.type === "sphere") {
      const s = SPH[n.sphere];
      pills = `<span class="pill" style="background:${esc(s.color)}">${esc(t("panel.sphere"))}</span>`;
      const members = nodes.filter(m => m.sphere === s.id && m.type !== "sphere" && !m._removed);
      const groups = Object.keys(TYPES).map(k => [k, members.filter(m => m.type === k)]).filter(([, a]) => a.length);
      body = `<div class="rels">` + groups.map(([k, a]) => `<h3>${esc(t("type." + k))}</h3>` + a.map(m => item(m)).join("")).join("") +
        `<h3>${esc(t("panel.view"))}</h3><button class="rel-item" type="button" data-hide="${esc(s.id)}"><span>${esc(t(state.hidden.has(s.id) ? "panel.showSphere" : "panel.hideSphere"))}</span></button></div>`;
    } else {
      const s = SPH[n.sphere];
      pills = `<span class="pill" style="background:${esc(s.color)}">${esc(s.title)}</span><span class="pill ghost">${esc(t("type." + n.type))}</span>`;
      const groups = new Map();
      links.forEach(l => {
        let other, label;
        if (l.source.id === n.id) { other = l.target; label = t("rel." + l.rel); }
        else if (l.target.id === n.id) { other = l.source; label = t("relback." + l.rel); }
        else return;
        if (other._removed) return;
        const key = l.rel === "contradicts" ? t("rel.contradicts") : l.cross ? t("panel.route") : label;
        const cls = l.rel === "contradicts" ? "contradicts" : l.cross ? "route" : "";
        if (!groups.has(key)) groups.set(key, { cls, items: [] });
        const extra = (l.cross && l.rel !== "contradicts" ? `<small>${esc(label)} · ${esc(SPH[other.sphere]?.title || "")}</small>` : "") + (l.note ? `<small>${esc(l.note)}</small>` : "");
        groups.get(key).items.push(item(other, extra));
      });
      const rank = c => c === "contradicts" ? 0 : c === "route" ? 1 : 2;
      body = `<div class="rels"><h3>${esc(t("panel.sphere"))}</h3>${item(byId.get("hub_" + n.sphere))}` +
        [...groups.entries()].sort((a, b) => rank(a[1].cls) - rank(b[1].cls)).map(([k, g]) => `<h3 class="${g.cls}">${esc(k)}</h3>` + g.items.join("")).join("") + `</div>`;
    }
    $("panel").innerHTML = `
      <div class="card"><div class="pills">${pills}</div><h2>${esc(n.type === "me" ? t("me") : n.title)}</h2>
        ${n.text ? `<p>${esc(n.text)}</p>` : ""}${n.quote ? `<blockquote>«${esc(n.quote)}»</blockquote>` : ""}
        ${n.date ? `<div class="meta"><span>${esc(t("panel.added", { date: fmtDate(n.date) }))}</span></div>` : ""}</div>
      ${n.draft ? `<div class="draft-note">${esc(t("panel.draftNote"))}</div>` : ""}
      ${body}
      <div class="howto">${t("panel.howto", { updated: esc(fmtDate(DATA.updated || today())) })}</div>`;
  }
  $("panel").onclick = e => {
    const b = e.target.closest(".rel-item"); if (!b) return;
    if (b.dataset.hide) { toggleSphere(b.dataset.hide); renderPanel(byId.get(state.selected)); return; }
    select(b.dataset.id, true);
  };

  /* ---------- search ---------- */
  const search = $("search");
  const matches = q => { q = q.trim().toLowerCase(); return q ? nodes.filter(n => !n._removed && (n.title + " " + (n.text || "") + " " + (n.quote || "")).toLowerCase().includes(q)) : []; };
  search.oninput = () => {
    const m = new Set(matches(search.value).map(n => n.id));
    nodeSel.classed("match", n => m.has(n.id));
    globe.setMatch(m.size ? m : null);
    if (m.size) { nodeSel.classed("dim", n => !m.has(n.id)); linkSel.classed("dim", true); spokeSel.classed("dim", true); }
    else highlight(state.selected);
  };
  search.onkeydown = e => {
    if (e.key === "Enter") { const m = matches(search.value); if (m[0]) select(m[0].id, true); }
    if (e.key === "Escape") { search.value = ""; search.oninput(); }
  };

  /* ======================= the globe ======================= */
  const globe = (() => {
    const el = $("globe"), gsvg = d3.select(el);
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const norm = v => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    // Six spheres sit on the axes (an octahedron); any other number is spread evenly over the shell.
    const OCTA = [[0, 0, 1], [1, 0, 0], [0, 0, -1], [-1, 0, 0], [0, 1, 0], [0, -1, 0]];
    const DIR = {};
    SPHERES.forEach((s, i) => {
      if (SPHERES.length <= 6) { DIR[s.id] = OCTA[i]; return; }
      const y = 1 - (i + 0.5) / SPHERES.length * 2, r = Math.sqrt(1 - y * y), th = i * Math.PI * (3 - Math.sqrt(5));
      DIR[s.id] = [Math.cos(th) * r, y, Math.sin(th) * r];
    });
    const HUB_R = 0.46, CAP = (SPHERES.length <= 6 ? 40 : 32) * Math.PI / 180, GA = Math.PI * (3 - Math.sqrt(5));
    const P = new Map([["me", [0, 0, 0]]]);
    SPHERES.forEach(s => {
      const d = DIR[s.id];
      P.set("hub_" + s.id, d.map(x => x * HUB_R));
      const u = norm(cross(d, Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0])), v = cross(d, u);
      nodes.filter(n => n.sphere === s.id && n.type !== "sphere")
        .sort((a, b) => (b.priority ? 1 : 0) - (a.priority ? 1 : 0) || (degree.get(b.id) || 0) - (degree.get(a.id) || 0))
        .forEach((n, i, arr) => {
          const th = CAP * Math.sqrt((i + 0.5) / arr.length), ph = i * GA, c = Math.cos(th), sn = Math.sin(th);
          P.set(n.id, [0, 1, 2].map(k => d[k] * c + (u[k] * Math.cos(ph) + v[k] * Math.sin(ph)) * sn));
        });
    });

    let yaw = -0.55, pitch = 0.34, k = 1, grow = 0, tgt = null, dirty = true, active = false, matchSet = null;
    let S = 0, CX = 0, CY = 0, lastTouch = 0;
    let front = null, fStr = 0, lastFocus = null, autoHub = null, inert = null, lastV = null;
    const W8 = Object.fromEntries(SPHERES.map(s => [s.id, 1]));
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) grow = 1;
    const rot = p => {
      const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
      const x1 = p[0] * cy + p[2] * sy, z1 = -p[0] * sy + p[2] * cy;
      return [x1, p[1] * cp - z1 * sp, p[1] * sp + z1 * cp];
    };
    const proj = p => { const r = rot(p), f = 1 / (1 - r[2] * 0.18); return { x: CX + r[0] * S * f, y: CY - r[1] * S * f, z: r[2], f }; };
    const GRAT = [];
    for (let lat = -60; lat <= 60; lat += 30) {
      const a = [], la = lat * Math.PI / 180;
      for (let i = 0; i <= 72; i++) { const q = i / 72 * 2 * Math.PI; a.push([Math.cos(la) * Math.cos(q), Math.sin(la), Math.cos(la) * Math.sin(q)]); }
      GRAT.push(a);
    }
    for (let lon = 0; lon < 180; lon += 30) {
      const a = [], L = lon * Math.PI / 180;
      for (let i = 0; i <= 72; i++) { const q = i / 72 * 2 * Math.PI; a.push([Math.cos(q) * Math.cos(L), Math.sin(q), Math.cos(q) * Math.sin(L)]); }
      GRAT.push(a);
    }
    const defs = gsvg.append("defs");
    const gf = defs.append("radialGradient").attr("id", "gFill");
    [[0, 0.02], [0.72, 0.05], [1, 0.17]].forEach(([o, a]) => gf.append("stop").attr("offset", o).attr("stop-color", "#6fd0ff").attr("stop-opacity", a));
    const gc = defs.append("radialGradient").attr("id", "gCore");
    [[0, 0.85], [0.45, 0.35], [1, 0]].forEach(([o, a]) => gc.append("stop").attr("offset", o).attr("stop-color", "#f2b450").attr("stop-opacity", a));
    defs.append("filter").attr("id", "gBlur").attr("x", "-60%").attr("y", "-60%").attr("width", "220%").attr("height", "220%")
      .append("feGaussianBlur").attr("stdDeviation", 2.4);
    const root = gsvg.append("g");
    const rim = root.append("circle").attr("class", "g-rim");
    const gBack = root.append("path").attr("class", "g-grat-back");
    const gFront = root.append("path").attr("class", "g-grat-front");
    const gSpokes = root.append("g"), gLinks = root.append("g"), gNodes = root.append("g");
    const sp = gSpokes.selectAll("g").data(SPHERES).join("g");
    sp.append("path").attr("class", "g-spoke core").attr("stroke", s => s.color).attr("stroke-opacity", 0.6);
    sp.append("path").attr("class", "g-spoke fan").attr("stroke", s => s.color).attr("stroke-opacity", 0.12);
    const gn = gNodes.selectAll("g").data(nodes, n => n.id).join("g")
      .attr("data-id", n => n.id).attr("tabindex", 0).attr("role", "button").attr("aria-label", n => n.title)
      .attr("class", n => "g-node" + (n.type === "sphere" ? " g-hub" : "") + (n.type === "me" ? " g-me" : ""));
    gn.each(function (n) {
      const g = d3.select(this);
      if (n.type === "me") {
        g.append("circle").attr("r", 30).attr("fill", "url(#gCore)");
        g.append("circle").attr("r", 13).attr("fill", "#f2b450");
        g.append("text").attr("text-anchor", "middle").attr("dy", 5).text(t("me.short"));
        return;
      }
      if (n.type === "sphere") {
        const c = SPH[n.sphere].color;
        g.append("circle").attr("r", 10).attr("fill", "none").attr("stroke", c).attr("stroke-width", 1.6);
        g.append("circle").attr("r", 4).attr("fill", c);
        g.append("text").attr("text-anchor", "middle").attr("dy", -17).style("fill", c).text(n.title);
        return;
      }
      const r = n.priority ? 7.5 : 3.6 + Math.sqrt(degree.get(n.id) || 1) * 0.9;
      if (isNew(n)) g.append("circle").attr("class", "g-new").attr("r", r + 5);
      if (n.priority) g.append("circle").attr("class", "g-halo").attr("r", r * 2.2).attr("fill", colorOf(n)).attr("fill-opacity", 0.22);
      const path = g.append("path").attr("d", d3.symbol(TYPES[n.type], Math.PI * r * r * 1.25)()).attr("fill", colorOf(n)).attr("stroke", "#0e1320").attr("stroke-width", 1.2);
      if (n.draft) path.attr("stroke", "#ebe8e0").attr("stroke-dasharray", "2 2");
      const tx = g.append("text").attr("text-anchor", "middle");
      wrap(n.title, 18).forEach((ln, i) => tx.append("tspan").attr("x", 0).attr("dy", i === 0 ? r + 13 : 12).text(ln));
    });
    const ease = () => 1 - Math.pow(1 - grow, 3);
    function arcD(a, b, lift) {
      const ua = norm(P.get(a)), ub = norm(P.get(b));
      const om = Math.acos(clamp(ua[0] * ub[0] + ua[1] * ub[1] + ua[2] * ub[2], -1, 1)), so = Math.sin(om) || 1e-6;
      let d = "";
      for (let i = 0; i <= 18; i++) {
        const q = i / 18, wa = Math.sin((1 - q) * om) / so, wb = Math.sin(q * om) / so, r = (1 + lift * Math.sin(Math.PI * q)) * ease();
        const pt = proj([0, 1, 2].map(j => (ua[j] * wa + ub[j] * wb) * r));
        d += (i ? "L" : "M") + pt.x.toFixed(1) + "," + pt.y.toFixed(1);
      }
      return d;
    }
    function shownLinks() {
      const sel = state.selected;
      return links.filter(l => {
        if (!nodeVisible(l.source) || !nodeVisible(l.target)) return false;
        if (state.onlyConflicts) return l.rel === "contradicts";
        if (l.rel === "contradicts" || state.routes) return true;
        if (sel === autoHub) return false;
        if (sel.startsWith("hub_")) return l.source.sphere === sel.slice(4) && l.target.sphere === sel.slice(4);
        return l.source.id === sel || l.target.id === sel;
      });
    }
    function draw() {
      const e = ease(), sel = state.selected;
      let settling = false, best = null, bz = -2;
      SPHERES.forEach(s => { if (state.hidden.has(s.id)) return; const z = rot(DIR[s.id])[2]; if (z > bz) { bz = z; best = s.id; } });
      if (!front || state.hidden.has(front) || (best !== front && bz > rot(DIR[front])[2] + 0.08)) front = best;
      const fTarget = clamp((k - 1.05) / 0.25, 0, 1);
      fStr += (fTarget - fStr) * 0.2;
      if (Math.abs(fTarget - fStr) > 0.003) settling = true; else fStr = fTarget;
      SPHERES.forEach(s => {
        const goal = s.id === front ? 1 : 1 - fStr;
        W8[s.id] += (goal - W8[s.id]) * (reduce ? 1 : 0.15);
        if (Math.abs(goal - W8[s.id]) > 0.003) settling = true; else W8[s.id] = goal;
      });
      const wOf = id => W8[id] ?? 1;
      const nb = sel && sel !== "me" ? neighbours(sel) : null;
      const hasMatch = matchSet && matchSet.size;
      const pos = new Map();
      nodes.forEach(n => { const p = P.get(n.id); pos.set(n.id, proj(n.type === "me" ? p : p.map(x => x * e))); });
      rim.attr("cx", CX).attr("cy", CY).attr("r", S * e);
      let f = "", b = "";
      GRAT.forEach(line => {
        let prev = null;
        line.forEach(p => {
          const q = proj(p.map(x => x * e));
          if (prev) { const seg = `M${prev.x.toFixed(1)},${prev.y.toFixed(1)}L${q.x.toFixed(1)},${q.y.toFixed(1)}`; if (prev.z + q.z >= 0) f += seg; else b += seg; }
          prev = q;
        });
      });
      gFront.attr("d", f); gBack.attr("d", b);
      const c0 = pos.get("me");
      sp.style("display", s => state.hidden.has(s.id) ? "none" : null).style("opacity", s => (0.2 + 0.8 * wOf(s.id)).toFixed(3));
      sp.select(".core").attr("d", s => { const h = pos.get("hub_" + s.id); return `M${c0.x},${c0.y}L${h.x},${h.y}`; });
      sp.select(".fan").attr("d", s => {
        const h = pos.get("hub_" + s.id);
        return nodes.filter(n => n.sphere === s.id && n.type !== "sphere" && nodeVisible(n))
          .map(n => { const q = pos.get(n.id); return `M${h.x.toFixed(1)},${h.y.toFixed(1)}L${q.x.toFixed(1)},${q.y.toFixed(1)}`; }).join("");
      });
      gLinks.selectAll("path").data(shownLinks()).join("path")
        .attr("class", l => `link ${l.rel}${l.draft ? " draft" : ""}${l.cross && l.rel !== "contradicts" ? " route" : ""}`)
        .attr("d", l => arcD(l.source.id, l.target.id, l.cross ? 0.34 : 0.1))
        .style("opacity", l => (0.1 + 0.9 * Math.min(wOf(l.source.sphere), wOf(l.target.sphere))).toFixed(3));
      gn.each(function (n) {
        const q = pos.get(n.id), vis = nodeVisible(n);
        this.style.display = vis ? "" : "none";
        n._gz = q.z;
        if (!vis) return;
        let op = n.type === "me" ? 1 : 0.2 + 0.8 * (q.z + 1) / 2;
        if (nb && !nb.has(n.id)) op *= 0.3;
        if (hasMatch && n.type !== "me" && !matchSet.has(n.id)) op *= 0.3;
        const w = n.type === "me" ? 1 : wOf(n.sphere);
        op *= 0.22 + 0.78 * w;
        if (w < 0.6) this.setAttribute("filter", "url(#gBlur)"); else this.removeAttribute("filter");
        const base = clamp(S / (230 * k), 0.5, 1);
        const sc = n.type === "me" ? Math.max(base, 0.7) : q.f * base * (0.8 + 0.3 * Math.sqrt(k));
        this.setAttribute("transform", `translate(${q.x.toFixed(1)},${q.y.toFixed(1)}) scale(${sc.toFixed(3)})`);
        this.style.opacity = op.toFixed(3);
        const tx = this.querySelector("text");
        if (tx && n.type !== "me" && n.type !== "sphere") {
          const lab = n.id === sel || (nb && nb.has(n.id)) || (hasMatch && matchSet.has(n.id)) ||
            (n.priority && q.z > (S < 170 ? 0.7 : 0.35)) || (S > 330 && q.z > 0.15) || (sel === "hub_" + n.sphere && sel !== autoHub && q.z > 0) ||
            (fStr > 0.5 && n.sphere === front && q.z > 0.55);
          tx.style.display = lab && (w >= 0.6 || n.id === sel) ? "" : "none";
        }
        this.classList.toggle("sel", n.id === sel);
        this.classList.toggle("match", !!(hasMatch && matchSet.has(n.id)));
      });
      gn.sort((a, b2) => a._gz - b2._gz);
      const fNow = fStr > 0.5 ? front : null;
      if (fNow !== lastFocus) {
        lastFocus = fNow;
        if (fNow && (sel === "me" || sel.startsWith("hub_"))) { autoHub = "hub_" + fNow; select(autoHub, false); } else readout(sel);
      }
      return settling;
    }
    function setSize() {
      const W = el.clientWidth, H = el.clientHeight;
      if (!W || !H) return;
      CX = W / 2; CY = H / 2; S = Math.min(W, H) * 0.34 * k; dirty = true;
    }
    function focusOn(id) {
      const n = byId.get(id);
      if (!n || n.type === "me") return;
      const p = n.type === "sphere" ? DIR[n.sphere] : P.get(id);
      const ty = Math.atan2(-p[0], p[2]), z1 = -p[0] * Math.sin(ty) + p[2] * Math.cos(ty);
      tgt = { yaw: ty, pitch: Math.atan2(p[1], z1) };
    }
    const angDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
    function frame() {
      requestAnimationFrame(frame);
      if (!active) return;
      if (tgt) {
        const dy = angDiff(tgt.yaw, yaw), dp = tgt.pitch - pitch;
        if (reduce) { yaw = tgt.yaw; pitch = tgt.pitch; tgt = null; }
        else { yaw += dy * 0.12; pitch += dp * 0.12; if (Math.abs(dy) < 0.002 && Math.abs(dp) < 0.002) tgt = null; }
        dirty = true;
      } else if (inert && !dragging) {
        yaw += inert.y; pitch = clamp(pitch + inert.p, -1.35, 1.35); inert.y *= 0.93; inert.p *= 0.93; dirty = true;
        if (Math.abs(inert.y) + Math.abs(inert.p) < 0.0006) inert = null;
      } else if (!reduce && !dragging && performance.now() - lastTouch > 5000 && fStr < 0.05) { yaw += 0.0015; dirty = true; }
      if (grow < 1) { grow = Math.min(1, grow + 0.022); dirty = true; }
      if (dirty) { dirty = false; if (draw()) dirty = true; }
    }
    const ptrs = new Map();
    let dragging = false, moved = 0, lx = 0, ly = 0, pinch0 = null, downId = null;
    el.addEventListener("pointerdown", e => {
      el.setPointerCapture(e.pointerId);
      ptrs.set(e.pointerId, [e.clientX, e.clientY]);
      const hit = e.target.closest && e.target.closest("[data-id]");
      downId = hit ? hit.dataset.id : null;
      moved = 0; lx = e.clientX; ly = e.clientY; tgt = null; inert = null; lastTouch = performance.now();
      if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch0 = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, k }; moved = 99; }
    });
    el.addEventListener("pointermove", e => {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.set(e.pointerId, [e.clientX, e.clientY]);
      lastTouch = performance.now();
      if (ptrs.size === 2 && pinch0) { const [a, b] = [...ptrs.values()]; k = clamp(pinch0.k * Math.hypot(a[0] - b[0], a[1] - b[1]) / pinch0.d, 0.7, 2.6); setSize(); return; }
      const dx = e.clientX - lx, dy = e.clientY - ly; lx = e.clientX; ly = e.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      if (moved > 6) {
        dragging = true; el.classList.add("dragging");
        yaw += dx * 0.009; pitch = clamp(pitch + dy * 0.009, -1.35, 1.35); dirty = true;
        lastV = { y: dx * 0.009, p: dy * 0.009, t: performance.now() };
      }
    });
    const release = e => {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.delete(e.pointerId);
      if (ptrs.size < 2) pinch0 = null;
      if (e.type === "pointerup" && !dragging && moved <= 6) select(downId || "me", !!downId);
      if (!ptrs.size) {
        if ((dragging || moved >= 99) && fStr > 0.5 && front) focusOn("hub_" + front);
        else if (dragging && !reduce && lastV && performance.now() - lastV.t < 80) inert = { y: lastV.y, p: lastV.p };
        lastV = null; dragging = false; el.classList.remove("dragging");
      }
    };
    el.addEventListener("pointerup", release);
    el.addEventListener("pointercancel", release);
    el.addEventListener("wheel", e => { e.preventDefault(); lastTouch = performance.now(); k = clamp(k * Math.exp(-e.deltaY * 0.0015), 0.7, 2.6); setSize(); }, { passive: false });
    el.addEventListener("keydown", e => {
      const hit = e.target.closest && e.target.closest("[data-id]");
      if (hit && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); select(hit.dataset.id, true); }
    });
    new ResizeObserver(() => { if (active) setSize(); }).observe(stage);
    const read = $("hudRead");
    function readout(id) {
      const n = byId.get(id);
      const sphereLine = sid => `${esc(SPH[sid].title)} · ${esc(plural(counts[sid], "stats.points"))}`;
      if (lastFocus && (!n || n.type === "me" || n.type === "sphere")) { read.innerHTML = `${esc(t("hud.focus"))}<b>${sphereLine(lastFocus)}</b>`; return; }
      if (!n || n.type === "me") { read.innerHTML = `${esc(t("hud.core"))}<b>${esc(t("me"))} · ${esc(plural(SPHERES.length, "stats.spheres"))}</b>`; return; }
      read.innerHTML = n.type === "sphere" ? `${esc(t("panel.sphere"))}<b>${sphereLine(n.sphere)}</b>`
        : `${esc(SPH[n.sphere].title)} · ${esc(t("type." + n.type))}<b>${esc(n.title)}</b>`;
    }
    requestAnimationFrame(frame);
    return {
      onSelect(id, focus) { if (focus) autoHub = null; readout(id); if (focus) focusOn(id); dirty = true; },
      touch() { dirty = true; },
      setMatch(m) { matchSet = m; dirty = true; },
      zoom(f) { k = clamp(k * f, 0.7, 2.6); lastTouch = performance.now(); setSize(); },
      reset() { k = 1; inert = null; tgt = { yaw: -0.55, pitch: 0.34 }; setSize(); select("me", false); },
      show(on) { active = on; if (on) setSize(); },
      paint(ctx, cx, cy, R) {
        const pr = p => { const r = rot(p), f = 1 / (1 - r[2] * 0.18); return { x: cx + r[0] * R * f, y: cy - r[1] * R * f, z: r[2], f }; };
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
        g.addColorStop(0, "rgba(111,208,255,0.02)"); g.addColorStop(0.72, "rgba(111,208,255,0.05)"); g.addColorStop(1, "rgba(111,208,255,0.17)");
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, R, 0, 2 * Math.PI); ctx.fill();
        ctx.strokeStyle = "rgba(111,208,255,0.5)"; ctx.lineWidth = 2; ctx.stroke();
        GRAT.forEach(line => {
          let prev = null;
          line.forEach(p => {
            const q = pr(p);
            if (prev) { ctx.strokeStyle = `rgba(111,208,255,${prev.z + q.z >= 0 ? 0.2 : 0.06})`; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(prev.x, prev.y); ctx.lineTo(q.x, q.y); ctx.stroke(); }
            prev = q;
          });
        });
        const c0 = pr([0, 0, 0]);
        SPHERES.forEach(s => {
          const h = pr(P.get("hub_" + s.id));
          ctx.strokeStyle = s.color; ctx.globalAlpha = 0.55; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(c0.x, c0.y); ctx.lineTo(h.x, h.y); ctx.stroke();
          ctx.globalAlpha = 0.14;
          nodes.filter(n => n.sphere === s.id && n.type !== "sphere" && !n._removed).forEach(n => { const q = pr(P.get(n.id)); ctx.beginPath(); ctx.moveTo(h.x, h.y); ctx.lineTo(q.x, q.y); ctx.stroke(); });
          ctx.globalAlpha = 1;
        });
        const items = nodes.filter(n => !n._removed).map(n => ({ n, q: pr(P.get(n.id)) })).sort((a, b) => a.q.z - b.q.z);
        items.forEach(({ n, q }) => {
          const alpha = n.type === "me" ? 1 : 0.25 + 0.75 * (q.z + 1) / 2;
          ctx.globalAlpha = alpha;
          if (n.type === "me") {
            ctx.fillStyle = "#f2b450"; ctx.beginPath(); ctx.arc(q.x, q.y, 26, 0, 2 * Math.PI); ctx.fill();
          } else if (n.type === "sphere") {
            const c = SPH[n.sphere].color;
            ctx.strokeStyle = c; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(q.x, q.y, 18 * q.f, 0, 2 * Math.PI); ctx.stroke();
            ctx.fillStyle = c; ctx.beginPath(); ctx.arc(q.x, q.y, 7 * q.f, 0, 2 * Math.PI); ctx.fill();
          } else {
            const r = (n.priority ? 13 : 6 + Math.sqrt(degree.get(n.id) || 1) * 1.6) * q.f;
            if (n.priority) { ctx.fillStyle = colorOf(n); ctx.globalAlpha = alpha * 0.22; ctx.beginPath(); ctx.arc(q.x, q.y, r * 2.2, 0, 2 * Math.PI); ctx.fill(); ctx.globalAlpha = alpha; }
            ctx.fillStyle = colorOf(n); ctx.beginPath(); ctx.arc(q.x, q.y, r, 0, 2 * Math.PI); ctx.fill();
          }
        });
        ctx.globalAlpha = 1;
      }
    };
  })();

  $("zIn").onclick = () => globe.zoom(1.25);
  $("zOut").onclick = () => globe.zoom(0.8);
  $("zReset").onclick = () => globe.reset();

  /* ---------- what's new ---------- */
  const newBtn = $("newBtn");
  const newIds = () => new Set(nodes.filter(n => isNew(n) && !n._removed).map(n => n.id));
  newBtn.onclick = () => {
    const on = !newBtn.classList.contains("act");
    newBtn.classList.toggle("act", on);
    const m = on ? newIds() : null;
    globe.setMatch(m);
    nodeSel.classed("match", n => !!(m && m.has(n.id)));
    if (m) { nodeSel.classed("dim", n => !m.has(n.id) && n.type !== "me"); linkSel.classed("dim", true); spokeSel.classed("dim", true); }
    else highlight(state.selected);
  };

  /* ---------- timeline ---------- */
  const DATES = [...new Set(nodes.filter(n => n.date && n.type !== "me" && n.type !== "sphere").map(n => n.date))].sort();
  const tl = $("tl"), tlLbl = $("tlLbl"), tlPlay = $("tlPlay");
  tl.max = DATES.length; tl.value = DATES.length; tlLbl.textContent = t("timeline.all");
  function setUntil(i) {
    tl.value = i;
    state.until = i >= DATES.length ? null : DATES[i];
    tlLbl.textContent = state.until ? shortDate(state.until) : t("timeline.all");
    applyVisibility();
  }
  tl.oninput = () => setUntil(+tl.value);
  let tlTimer = null;
  tlPlay.onclick = () => {
    if (tlTimer) { clearInterval(tlTimer); tlTimer = null; tlPlay.textContent = "▶"; return; }
    let i = 0; setUntil(0); tlPlay.textContent = "❚❚";
    tlTimer = setInterval(() => { i++; setUntil(i); if (i >= DATES.length) { clearInterval(tlTimer); tlTimer = null; tlPlay.textContent = "▶"; } }, 650);
  };

  /* ---------- review drafts: right / fix / remove — saved at once ---------- */
  const reviewEl = $("review"), reviewBtn = $("reviewBtn"), conflictBtn = $("conflictBtn");
  const dataNode = id => DATA.nodes.find(x => x.id === id);
  let queue = [], qi = 0, mode = "view", panelMode = "none";
  const draftsLeft = () => nodes.filter(n => n.draft && !n._removed && n.type !== "sphere");
  const openConflicts = () => links.filter(l => l.rel === "contradicts" && !l._resolved && !l.source._removed && !l.target._removed);
  function refreshCounts() {
    const d = draftsLeft().length, c = openConflicts().length;
    reviewBtn.hidden = !d || DEMO; reviewBtn.textContent = t("review.button", { n: d });
    conflictBtn.hidden = !c || DEMO; conflictBtn.textContent = t("conflict.button", { n: c });
    const nn = newIds().size;
    newBtn.hidden = !nn; newBtn.textContent = t("new.button", { n: nn });
    renderStats();
  }
  function closeReview(msg) {
    panelMode = "none"; mode = "view";
    reviewEl.hidden = !msg;
    if (msg) reviewEl.innerHTML = `<div class="msg">${esc(msg)}</div><div class="acts"><button type="button" data-a="close">${esc(t("close"))}</button></div>`;
  }
  function showCard() {
    while (qi < queue.length && (!queue[qi].draft || queue[qi]._removed)) qi++;
    if (qi >= queue.length) { closeReview(t("review.done")); return; }
    const n = queue[qi], s = SPH[n.sphere];
    select(n.id, true);
    reviewEl.hidden = false;
    const top = label => `<div class="top"><span>${esc(label)}</span><span>${qi + 1} / ${queue.length}</span></div>`;
    if (mode === "edit") {
      reviewEl.innerHTML = top(t("review.fix") + " · " + s.title) +
        `<input id="rvTitle" value="${esc(n.title)}" aria-label="${esc(t("node.f.title"))}"><textarea id="rvText" aria-label="${esc(t("node.f.text"))}">${esc(n.text || "")}</textarea>
        <div class="acts"><button type="button" class="ok" data-a="saveedit">${esc(t("save"))}</button><button type="button" data-a="cancel">${esc(t("cancel"))}</button></div>`;
      return;
    }
    if (mode === "confirm") {
      reviewEl.innerHTML = top(t("review.removeQ")) + `<h3>${esc(n.title)}</h3><p>${esc(t("review.removeNote"))}</p>
        <div class="acts"><button type="button" class="bad" data-a="remove">${esc(t("review.removeYes"))}</button><button type="button" data-a="cancel">${esc(t("cancel"))}</button></div>`;
      return;
    }
    reviewEl.innerHTML = top(t("draft") + " · " + s.title) + `<h3>${esc(n.title)}</h3><p>${esc(n.text || "")}</p>
      <div class="acts"><button type="button" class="ok" data-a="yes">${esc(t("review.yes"))}</button><button type="button" data-a="edit">${esc(t("review.fix"))}</button>
      <button type="button" class="bad" data-a="no">${esc(t("review.remove"))}</button><button type="button" data-a="skip">${esc(t("skip"))}</button><button type="button" data-a="close">${esc(t("done"))}</button></div>`;
  }
  reviewBtn.onclick = () => {
    queue = draftsLeft().sort((a, b) => (b.date || "").localeCompare(a.date || "")); qi = 0; mode = "view"; panelMode = "drafts";
    showCard();
  };
  function removeNode(id) {
    byId.get(id)._removed = true;
    DATA.nodes = DATA.nodes.filter(x => x.id !== id);
    DATA.links = DATA.links.filter(l => l.s !== id && l.t !== id);
  }
  reviewEl.addEventListener("click", e => {
    const a = e.target.closest("[data-a]")?.dataset.a; if (!a) return;
    if (a === "close") { closeReview(); return; }
    const n = queue[qi];
    if (a === "skip") { qi++; mode = "view"; }
    if (a === "edit") mode = "edit";
    if (a === "no") mode = "confirm";
    if (a === "cancel") mode = "view";
    if (a === "yes") {
      delete dataNode(n.id).draft; n.draft = false;
      DATA.links.forEach(l => { if (l.s === n.id || l.t === n.id) delete l.draft; });
      persist(); qi++; mode = "view";
    }
    if (a === "saveedit") {
      const ti = $("rvTitle").value.trim(), x = $("rvText").value.trim();
      if (!ti) return;
      const d = dataNode(n.id); d.title = ti; d.text = x; delete d.draft;
      n.title = ti; n.text = x; n.draft = false; persist(); qi++; mode = "view";
    }
    if (a === "remove") { removeNode(n.id); persist(); qi++; mode = "view"; applyVisibility(); }
    refreshCounts(); showCard();
  });

  /* ---------- contradictions: the AI asks, your answers resolve ---------- */
  let cq = [], ci = 0, dialogue = [], cView = "busy", cData = null, cErr = "", structural = false;
  const dataLink = l => DATA.links.find(x => x.s === l.s && x.t === l.t && x.rel === "contradicts");
  function renderConflict() {
    const l = cq[ci];
    reviewEl.hidden = false;
    let html = `<div class="top"><span>${esc(t("conflict.title"))}</span><span>${ci + 1} / ${cq.length}</span></div>
      <div class="cpair"><div><b>A</b>${esc(l.source.title)}</div><div><b>B</b>${esc(l.target.title)}</div></div>` +
      (l.note ? `<p>${esc(l.note)}</p>` : "") +
      (dialogue.length ? `<div class="clog">${dialogue.map(x => `<div class="q">${esc(x.q)}</div><div class="a">${esc(x.a)}</div>`).join("")}</div>` : "");
    const btn = (c, label, cls = "") => `<button type="button" class="${cls}" data-c="${c}">${esc(t(label))}</button>`;
    if (cView === "busy") html += `<div class="msg">${esc(t("ai.thinking"))}</div>`;
    if (cView === "error") html += `<div class="msg">${esc(cErr)}</div><div class="acts">${btn("retry", "retry")}${btn("manual", "conflict.manual")}${btn("skip", "skip")}${btn("close", "close")}</div>`;
    if (cView === "manual") html += `<div class="cq">${esc(t("conflict.manualQ"))}</div><textarea id="cAns"></textarea>
      <div class="acts">${btn("manualok", "conflict.resolved", "ok")}${btn("skip", "skip")}${btn("close", "close")}</div>`;
    if (cView === "question") html += `<div class="cq">${esc(cData.question)}</div><textarea id="cAns" placeholder="${esc(t("conflict.answerPh"))}"></textarea>
      <div class="acts">${btn("answer", "conflict.answer", "ok")}${btn("enough", "conflict.enough")}${btn("skip", "skip")}${btn("close", "close")}</div>`;
    if (cView === "proposal") {
      const pr = cData.proposal, nm = id => byId.get(id)?.title || id;
      html += `<div class="prop"><div>${esc(pr.summary)}</div>` +
        (pr.edits || []).map(e => `<small>${esc(t("conflict.edit", { title: nm(e.id) }))} ${esc(e.text)}</small>`).join("") +
        (pr.principle ? `<small>${esc(t("conflict.principle", { title: pr.principle.title }))} ${esc(pr.principle.text || "")}</small>` : "") +
        `</div><div class="acts">${btn("accept", "conflict.accept", "ok")}${btn("more", "conflict.more")}${btn("skip", "skip")}</div>`;
    }
    reviewEl.innerHTML = html;
    $("cAns")?.focus();
  }
  async function askAI(extra, force = false) {
    cView = "busy"; renderConflict();
    try {
      const l = cq[ci];
      const r = await api("/api/conflict", { method: "POST", body: JSON.stringify({ s: l.s, t: l.t, dialogue: extra || dialogue, force }) });
      cData = r; cView = r.proposal ? "proposal" : "question";
    } catch (e) { cErr = aiError(e); cView = "error"; }
    renderConflict();
  }
  function startConflict() {
    if (ci >= cq.length) { closeReview(t("conflict.done")); if (structural) location.reload(); return; }
    select(cq[ci].source.id, true);
    dialogue = []; cData = null; panelMode = "conflicts";
    askAI();
  }
  function resolve(l, pr) {
    const d = dataLink(l);
    d.rel = "tied"; d.note = pr.summary; delete d.draft;
    l.rel = "tied"; l.note = pr.summary; l.draft = false; l._resolved = true;
    (pr.edits || []).forEach(e => { const dn = dataNode(e.id); if (dn && e.text) { dn.text = e.text; byId.get(e.id).text = e.text; } });
    if (pr.principle && pr.principle.title) {
      const id = "n" + Date.now().toString(16);
      const sphere = l.source.sphere === l.target.sphere ? l.source.sphere : (SPH.values ? "values" : l.source.sphere);
      DATA.nodes.push({ id, type: "principle", sphere, title: pr.principle.title, text: pr.principle.text || "", date: today() });
      DATA.links.push({ s: id, t: l.s, rel: "derives" }, { s: id, t: l.t, rel: "derives" });
      structural = true;
    }
    persist(); linkClass(); applyVisibility(); refreshCounts(); renderPanel(byId.get(state.selected));
  }
  conflictBtn.onclick = () => { cq = openConflicts(); ci = 0; structural = false; startConflict(); };
  reviewEl.addEventListener("click", e => {
    const c = e.target.closest("[data-c]")?.dataset.c; if (!c) return;
    const l = cq[ci], ans = ($("cAns")?.value || "").trim();
    if (c === "close") { closeReview(); if (structural) location.reload(); return; }
    if (c === "skip") { ci++; startConflict(); return; }
    if (c === "retry") { askAI(); return; }
    if (c === "manual") { cView = "manual"; renderConflict(); return; }
    if (c === "answer") { if (!ans) return; dialogue.push({ q: cData.question, a: ans }); askAI(); return; }
    if (c === "enough") {
      if (ans) dialogue.push({ q: cData.question, a: ans });
      askAI(null, true); return;
    }
    if (c === "more") { dialogue.push({ q: cData.proposal.summary, a: t("conflict.notQuite") }); askAI(); return; }
    if (c === "accept") { resolve(l, cData.proposal); ci++; startConflict(); return; }
    if (c === "manualok") { if (!ans) return; resolve(l, { summary: ans, edits: [], principle: null }); ci++; startConflict(); return; }
  });

  /* ---------- add a thought (AI) or a point by hand ---------- */
  const thinkDlg = $("thinkDlg");
  function openThink() { $("thinkMsg").textContent = ""; thinkDlg.showModal(); $("thinkText").focus(); }
  $("thinkBtn").onclick = openThink;
  $("thinkGo").onclick = async () => {
    const text = $("thinkText").value.trim();
    if (!text) return;
    const btn = $("thinkGo");
    btn.disabled = true; $("thinkMsg").textContent = t("ai.thinking");
    try {
      const r = await api("/api/think", { method: "POST", body: JSON.stringify({ text }) });
      try { sessionStorage.setItem("lg.select", r.nodes[0].id); } catch (e) { }
      location.reload();
    } catch (e) { $("thinkMsg").textContent = aiError(e); btn.disabled = false; }
  };
  $("thinkManual").onclick = () => {
    thinkDlg.close();
    $("nTitle").value = ""; $("nText").value = $("thinkText").value.trim();
    $("nSphere").innerHTML = SPHERES.map(s => `<option value="${esc(s.id)}">${esc(s.title)}</option>`).join("");
    $("nType").innerHTML = Object.keys(TYPES).map(k => `<option value="${k}">${esc(t("type." + k))}</option>`).join("");
    $("nLink").innerHTML = `<option value="">${esc(t("node.noLink"))}</option>` + nodes.filter(n => n.type !== "sphere" && n.type !== "me" && !n._removed)
      .map(n => `<option value="${esc(n.id)}">${esc(n.title)}</option>`).join("");
    $("nodeDlg").showModal(); $("nTitle").focus();
  };
  $("nSave").onclick = async () => {
    const title = $("nTitle").value.trim();
    if (!title) return;
    const id = "n" + Date.now().toString(16);
    DATA.nodes.push({ id, type: $("nType").value, sphere: $("nSphere").value, title, text: $("nText").value.trim(), date: today() });
    if ($("nLink").value) DATA.links.push({ s: id, t: $("nLink").value, rel: "tied" });
    await persist(true);
    try { sessionStorage.setItem("lg.select", id); } catch (e) { }
    location.reload();
  };

  /* ---------- view switch ---------- */
  function setView(v) {
    const globeOn = v !== "map";
    $("globe").toggleAttribute("hidden", !globeOn);
    $("graph").toggleAttribute("hidden", globeOn);
    ["hudRead", "hudHint", "gctl"].forEach(id => { $(id).hidden = !globeOn; });
    $("viewGlobe").setAttribute("aria-pressed", globeOn);
    $("viewMap").setAttribute("aria-pressed", !globeOn);
    globe.show(globeOn);
    if (!globeOn) fit();
    try { localStorage.setItem("lg.view", globeOn ? "globe" : "map"); } catch (e) { }
  }
  $("viewGlobe").onclick = () => setView("globe");
  $("viewMap").onclick = () => setView("map");
  let saved = "globe";
  try { saved = localStorage.getItem("lg.view") || "globe"; } catch (e) { }
  setView(saved);
  refreshCounts();
  let start = "me";
  try { start = sessionStorage.getItem("lg.select") || "me"; sessionStorage.removeItem("lg.select"); } catch (e) { }
  select(start, start !== "me");
  setupSettings(SPHERES);
  GLOBE_PAINT = (ctx, cx, cy, R) => globe.paint(ctx, cx, cy, R);
  $("emptyIntro").onclick = startIntro;
  $("thinkIntro").onclick = startIntro;
  $("sShare").onclick = sharePicture;
  if (DEMO) { $("emptyIntro").hidden = true; }
  else showIntro();
}

/* ======================= settings ======================= */
function setupSettings(SPHERES) {
  const dlg = $("settingsDlg");
  $("settingsBtn").onclick = async () => {
    const s = SETTINGS;
    $("sLang").innerHTML = Object.entries(s.languages).map(([k, v]) => `<option value="${k}" ${k === s.language ? "selected" : ""}>${esc(v)}</option>`).join("");
    dlg.querySelectorAll("input[name=prov]").forEach(r => { r.checked = r.value === s.provider; });
    $("sOllamaUrl").value = s.ollama_url; $("sOllamaModel").value = s.ollama_model;
    $("sOpenaiModel").value = s.openai_model; $("sAnthropicModel").value = s.anthropic_model;
    $("sOpenaiKey").value = ""; $("sAnthropicKey").value = "";
    $("sOpenaiKey").placeholder = s.has_openai_key ? t("settings.keySaved") : "sk-…";
    $("sAnthropicKey").placeholder = s.has_anthropic_key ? t("settings.keySaved") : "sk-ant-…";
    $("sSpheres").innerHTML = DATA.spheres.map((sp, i) =>
      `<div><input type="color" value="${esc(sp.color)}" data-i="${i}" data-k="color" aria-label="${esc(t("settings.sphereColor"))}"><input value="${esc(sp.title)}" data-i="${i}" data-k="title" aria-label="${esc(t("settings.sphereName"))}"></div>`).join("");
    $("settingsMsg").textContent = "";
    showProvider();
    dlg.showModal();
    const models = (await api("/api/models").catch(() => ({ ollama: [] }))).ollama;
    $("ollamaModels").innerHTML = models.map(m => `<option value="${esc(m)}">`).join("");
    $("ollamaState").textContent = models.length ? t("settings.ollama.found", { n: models.length }) : t("settings.ollama.missing");
  };
  function showProvider() {
    const p = dlg.querySelector("input[name=prov]:checked")?.value;
    dlg.querySelectorAll(".sub-fields").forEach(f => { f.hidden = f.dataset.for !== p; });
  }
  dlg.querySelectorAll("input[name=prov]").forEach(r => { r.onchange = showProvider; });
  $("sSave").onclick = async () => {
    const patch = {
      language: $("sLang").value, provider: dlg.querySelector("input[name=prov]:checked")?.value || "ollama",
      ollama_url: $("sOllamaUrl").value, ollama_model: $("sOllamaModel").value,
      openai_model: $("sOpenaiModel").value, anthropic_model: $("sAnthropicModel").value,
      openai_key: $("sOpenaiKey").value, anthropic_key: $("sAnthropicKey").value
    };
    const langChanged = patch.language !== SETTINGS.language;
    let spheresChanged = false;
    $("sSpheres").querySelectorAll("input").forEach(inp => {
      const sp = DATA.spheres[+inp.dataset.i], v = inp.value.trim();
      if (v && sp[inp.dataset.k] !== v) { sp[inp.dataset.k] = v; spheresChanged = true; }
    });
    try {
      SETTINGS = await api("/api/settings", { method: "PUT", body: JSON.stringify(patch) });
      if (spheresChanged && !DEMO) await persist(true);
      if (langChanged || spheresChanged) { location.reload(); return; }
      $("settingsMsg").textContent = t("settings.saved");
    } catch (e) { $("settingsMsg").textContent = t("save.failed"); }
  };
  $("sExport").onclick = () => {
    const blob = new Blob([JSON.stringify(DATA, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = `lifeglobe-${today()}.json`;
    document.body.appendChild(a); a.click(); a.remove();
  };
  $("sImport").onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const b = JSON.parse(await f.text());
      await api("/api/brain", { method: "PUT", body: JSON.stringify(b) });
      location.reload();
    } catch (err) { $("settingsMsg").textContent = t("settings.importFailed"); }
  };
}


/* ======================= introduction: 8 questions, the globe fills as you answer ======================= */
const INTRO_STEPS = 8;
function introStep() { try { const v = sessionStorage.getItem("lg.intro"); return v === null ? null : +v; } catch (e) { return null; } }
function setIntroStep(v) { try { v === null ? sessionStorage.removeItem("lg.intro") : sessionStorage.setItem("lg.intro", String(v)); } catch (e) { } }
function startIntro() { setIntroStep(0); $("thinkDlg").open && $("thinkDlg").close(); showIntro(); }
function showIntro(msg = "") {
  const step = introStep();
  const box = $("intro");
  if (step === null) { box.hidden = true; return; }
  if (step >= INTRO_STEPS) {
    setIntroStep(null);
    box.hidden = false;
    box.innerHTML = `<div class="msg">${esc(t("intro.done"))}</div><div class="acts"><button type="button" data-i="close">${esc(t("close"))}</button></div>`;
    return;
  }
  box.hidden = false;
  box.innerHTML = `<div class="top"><span>${esc(t("intro.title"))}</span><span>${step + 1} / ${INTRO_STEPS}</span></div>
    <h3>${esc(t("intro.q" + (step + 1)))}</h3>
    <textarea id="introAns" placeholder="${esc(t("intro.ph"))}"></textarea>
    ${msg ? `<div class="msg">${esc(msg)}</div>` : ""}
    <div class="acts"><button type="button" class="ok" data-i="next">${esc(t("intro.next"))}</button>
    <button type="button" data-i="skip">${esc(t("skip"))}</button><button type="button" data-i="stop">${esc(t("intro.stop"))}</button></div>`;
  $("introAns").focus();
}
$("intro").addEventListener("click", async e => {
  const a = e.target.closest("[data-i]")?.dataset.i; if (!a) return;
  const step = introStep();
  if (a === "close" || a === "stop") { setIntroStep(null); $("intro").hidden = true; return; }
  if (a === "skip") { setIntroStep(step + 1); showIntro(); return; }
  const ans = ($("introAns")?.value || "").trim();
  if (!ans) return;
  e.target.disabled = true;
  $("intro").querySelector(".acts").insertAdjacentHTML("beforebegin", `<div class="msg">${esc(t("ai.thinking"))}</div>`);
  try {
    const r = await api("/api/think", { method: "POST", body: JSON.stringify({ text: `${t("intro.q" + (step + 1))}\n${ans}` }) });
    setIntroStep(step + 1);
    try { sessionStorage.setItem("lg.select", r.nodes[0].id); } catch (err) { }
    location.reload();
  } catch (err) { showIntro(aiError(err)); }
});

/* ======================= a picture to share: points without any personal text ======================= */
function sharePicture() {
  const W = 1080, H = 1920, c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#0e1320"; ctx.fillRect(0, 0, W, H);
  const font = (w, px) => `${w} ${px}px "Avenir Next", "Segoe UI", system-ui, sans-serif`;
  ctx.fillStyle = "#ebe8e0"; ctx.font = font(700, 64); ctx.textAlign = "center";
  ctx.fillText(t("share.headline"), W / 2, 190);
  ctx.fillStyle = "#8e97ad"; ctx.font = font(500, 34);
  const pts = DATA.nodes.filter(n => n.type !== "me").length, cons = DATA.links.filter(l => l.rel === "contradicts").length;
  ctx.fillText([plural0(pts, "stats.points"), plural0(DATA.spheres.length, "stats.spheres"), cons ? plural0(cons, "stats.conflicts") : ""].filter(Boolean).join("  ·  "), W / 2, 255);
  GLOBE_PAINT(ctx, W / 2, 900, 420);
  ctx.textAlign = "left"; ctx.font = font(600, 36);
  const per = Object.fromEntries(DATA.spheres.map(s => [s.id, DATA.nodes.filter(n => n.sphere === s.id).length]));
  DATA.spheres.forEach((s, i) => {
    const col = i % 2, row = Math.floor(i / 2), x = 150 + col * 430, y = 1470 + row * 80;
    ctx.fillStyle = s.color; ctx.beginPath(); ctx.arc(x, y - 12, 14, 0, 2 * Math.PI); ctx.fill();
    ctx.fillStyle = "#ebe8e0"; ctx.fillText(`${s.title}  ${per[s.id]}`, x + 32, y);
  });
  ctx.textAlign = "center"; ctx.fillStyle = "#6fd0ff"; ctx.font = font(600, 34);
  ctx.fillText("lifeglobe — " + t("share.tagline"), W / 2, H - 110);
  c.toBlob(b => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(b); a.download = `lifeglobe-${today()}.png`;
    document.body.appendChild(a); a.click(); a.remove();
  }, "image/png");
}
function plural0(n, key) {
  const k = `${key}.${new Intl.PluralRules(SETTINGS.language || "en").select(n)}`;
  return t(I18N[k] !== undefined ? k : `${key}.other`, { n });
}
let GLOBE_PAINT = () => { };

boot().catch(e => { document.body.innerHTML = `<p style="padding:24px">Could not start: ${esc(e.message)}</p>`; });
