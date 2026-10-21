"use strict";

/**
 * Cline Upstream — panel (interactive).
 *
 * Reads the snapshot the plugin publishes into its own settings and writes user
 * choices back through `plugin.setSettings`. Panels may not reach loopback, so
 * settings are the channel in both directions.
 */

const KNOWN_UPSTREAMS = [
  "deepseek", "fireworks", "baseten", "digitalocean", "pareto", "wafer", "runware",
  "alibaba", "vertex", "particle", "novita", "togetherai", "deepinfra", "parasail",
  "gmicloud", "modal", "morph", "runinfra", "tencent", "boundless", "inference-net",
  "relace", "token-pass",
];

const el = {
  status: document.getElementById("status"),
  pulse: document.getElementById("pulse"),
  refresh: document.getElementById("refresh"),
  target: document.getElementById("target"),
  inject: document.getElementById("inject"),
  hardPin: document.getElementById("hardPin"),
  toast: document.getElementById("toast"),
  hint: document.getElementById("hint"),
  upstreams: document.getElementById("upstreams"),
  models: document.getElementById("models"),
  modelsHint: document.getElementById("models-hint"),
  rows: document.getElementById("rows"),
  footLeft: document.getElementById("foot-left"),
  footRight: document.getElementById("foot-right"),
};

let current = {};
let busy = false;

/* ----------------------------------------------------------------- bridge */

function bridge() {
  return window.pluginBridge || null;
}

async function invoke(channel, payload) {
  const b = bridge();
  if (!b || typeof b.invoke !== "function") throw new Error("pluginBridge.invoke 不可用");
  return b.invoke(channel, payload);
}

async function readSettings() {
  const raw = await invoke("plugin.getSettings");
  const s = (raw && typeof raw === "object" && (raw.settings || raw.value)) || raw;
  return s && typeof s === "object" ? s : {};
}

async function writeSettings(patch) {
  const next = Object.assign({}, current, patch);
  await invoke("plugin.setSettings", next);
  current = next;
  render();
}

/* ----------------------------------------------------------------- utils */

function splitModels(value) {
  return String(value || "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseSnapshot(settings) {
  const raw = settings && settings.routingSnapshot;
  if (!raw || typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function fmtCount(v) {
  return v === null || v === undefined ? "—" : String(v);
}

function fmtCost(v) {
  if (!v) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  if (n === 0) return "$0";
  return "$" + (n < 0.01 ? n.toFixed(5) : n.toFixed(4));
}

function fmtAgo(ts) {
  if (!ts) return "—";
  const d = Date.now() - Number(ts);
  if (!Number.isFinite(d) || d < 0) return "—";
  const s = Math.floor(d / 1000);
  if (s < 60) return s + " 秒前";
  const m = Math.floor(s / 60);
  if (m < 60) return m + " 分钟前";
  const h = Math.floor(m / 60);
  if (h < 24) return h + " 小时前";
  return Math.floor(h / 24) + " 天前";
}

function setStatus(text, mode) {
  el.status.textContent = text;
  el.pulse.className = "pulse" + (mode === "live" ? " live" : mode === "down" ? " down" : "");
}

/* ---------------------------------------------------------------- render */

function detectedUpstreams(snapshot) {
  const counts = new Map();
  const bump = (name, kind) => {
    if (!name) return;
    const row = counts.get(name) || { name, final: 0, pinned: 0, fallback: 0 };
    row[kind] += 1;
    counts.set(name, row);
  };
  for (const entry of Object.values((snapshot && snapshot.models) || {})) {
    bump(entry.finalProvider, "final");
    bump(entry.pinnedProvider, "pinned");
    for (const name of entry.fallbacks || []) bump(name, "fallback");
  }
  return [...counts.values()].sort(
    (a, b) => b.final - a.final || b.pinned - a.pinned || b.fallback - a.fallback
  );
}

function renderTarget(settings, detected) {
  const names = new Set([...KNOWN_UPSTREAMS, ...detected.map((d) => d.name)]);
  if (settings.preferredUpstream) names.add(settings.preferredUpstream);
  const frag = document.createDocumentFragment();
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "不指定（只观察）";
  frag.appendChild(none);
  for (const name of [...names].sort()) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    frag.appendChild(opt);
  }
  el.target.replaceChildren(frag);
  el.target.value = settings.preferredUpstream || "";
}

function renderUpstreamList(detected, settings) {
  if (detected.length === 0) {
    const p = document.createElement("p");
    p.className = "dim small";
    p.textContent = "还没有探测到上游。发出一次请求后这里会列出网关实际用过和备选的全部上游。";
    el.upstreams.replaceChildren(p);
    return;
  }
  const frag = document.createDocumentFragment();
  for (const row of detected) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip" + (row.name === settings.preferredUpstream ? " on" : "");
    chip.title = `实际 ${row.final} 次 / 钉住 ${row.pinned} 次 / 备选 ${row.fallback} 次 — 点击设为锚定目标`;
    const label = document.createElement("span");
    label.textContent = row.name;
    const meta = document.createElement("em");
    meta.textContent = `${row.final}/${row.pinned}/${row.fallback}`;
    chip.append(label, meta);
    chip.addEventListener("click", () => {
      if (busy) return;
      writeSettings({ preferredUpstream: row.name, injectRouting: true }).catch(fail);
    });
    frag.appendChild(chip);
  }
  el.upstreams.replaceChildren(frag);
}

function renderModels(settings, snapshot) {
  const available = (snapshot && snapshot.available) || [];
  if (available.length === 0) {
    el.models.replaceChildren();
    el.modelsHint.textContent =
      "还没有模型目录。到 设置 → AI 服务 → Cline Upstream 点一次「获取列表」（插件会用你的 key 拉取真实目录）。";
    return;
  }
  const chosen = splitModels(settings.enabledModels);
  const all = chosen.length === 0;
  el.modelsHint.textContent = all
    ? `共 ${available.length} 个可用模型，当前全部启用（取消勾选可限制）`
    : `共 ${available.length} 个可用模型，当前启用 ${chosen.length} 个`;

  const frag = document.createDocumentFragment();
  for (const id of available) {
    const label = document.createElement("label");
    label.className = "model";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = all || chosen.includes(id);
    box.addEventListener("change", () => {
      if (busy) return;
      const base = splitModels(current.enabledModels);
      const seed = base.length === 0 ? available.slice() : base;
      const next = new Set(seed);
      if (box.checked) next.add(id);
      else next.delete(id);
      let list = [...next];
      if (list.length === available.length) list = [];
      writeSettings({ enabledModels: list.join(",") }).catch(fail);
    });
    const text = document.createElement("span");
    text.textContent = id;
    label.append(box, text);
    frag.appendChild(label);
  }
  el.models.replaceChildren(frag);
}

function renderTable(snapshot) {
  const models = (snapshot && snapshot.models) || {};
  const entries = Object.entries(models).sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
  if (entries.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 7;
    td.className = "empty";
    td.textContent = "还没有请求记录。用该服务商发一条消息即可。";
    tr.appendChild(td);
    el.rows.replaceChildren(tr);
    return;
  }
  const frag = document.createDocumentFragment();
  for (const [model, e] of entries) {
    const tr = document.createElement("tr");
    const td = (text, cls) => {
      const c = document.createElement("td");
      if (cls) c.className = cls;
      c.textContent = text === null || text === undefined ? "—" : String(text);
      return c;
    };
    tr.appendChild(td(model, "model"));

    const final = td("");
    const span = document.createElement("span");
    span.className = "provider" + (e.matched === true ? " hit" : e.matched === false ? " miss" : "");
    span.textContent = e.finalProvider || "—";
    final.appendChild(span);
    tr.appendChild(final);

    tr.appendChild(td(e.pinnedProvider || "—"));
    tr.appendChild(td(fmtCount(e.fallbackCount), "num"));
    tr.appendChild(td(fmtCount(e.cacheHitTokens), "num"));
    tr.appendChild(td(fmtCost(e.cost), "num"));

    const verdict = td("");
    const badge = document.createElement("span");
    if (e.injected) {
      badge.className = "badge " + (e.matched === true ? "ok" : e.matched === false ? "bad" : "idle");
      badge.textContent = e.matched === true ? "已生效" : e.matched === false ? "未生效" : "无元数据";
    } else {
      badge.className = "badge idle";
      badge.textContent = "仅观察";
    }
    verdict.appendChild(badge);
    tr.appendChild(verdict);
    frag.appendChild(tr);
  }
  el.rows.replaceChildren(frag);
}

function render() {
  const settings = current || {};
  const snapshot = parseSnapshot(settings);
  const detected = detectedUpstreams(snapshot);

  renderTarget(settings, detected);
  renderUpstreamList(detected, settings);
  renderModels(settings, snapshot);
  renderTable(snapshot);

  el.inject.checked = Boolean(settings.injectRouting);
  el.hardPin.checked = Boolean(settings.hardPin);
  el.toast.checked = settings.toastOnMismatch !== false;

  const rows = Object.keys((snapshot && snapshot.models) || {}).length;
  el.footLeft.textContent = rows === 0 ? "尚无请求记录" : `已记录 ${rows} 个模型`;
  el.footRight.textContent = snapshot && snapshot.at
    ? "最近更新 " + new Date(snapshot.at).toLocaleTimeString()
    : "等待第一次请求";

  const hasKey = Boolean(settings.apiKey);
  const target = settings.preferredUpstream;
  if (!hasKey) {
    el.hint.className = "hint warn";
    el.hint.textContent = "还没有填写 ClinePass API Key：设置 → 插件 → Cline 上游。没有 key 时插件无法转发请求。";
  } else if (target && settings.injectRouting) {
    el.hint.className = "hint";
    el.hint.textContent = `正在把请求钉到「${target}」，每次响应都会用 finalProvider 自动校验是否生效。`;
  } else if (target) {
    el.hint.className = "hint";
    el.hint.textContent = `已选目标「${target}」但未开启写入，当前只观察。`;
  } else {
    el.hint.className = "hint";
    el.hint.textContent = "数据来自 Cline 网关自己返回的 routing 元数据。点上面的上游标签即可「设为锚定目标」，并在插件设置里填 key。";
  }
}

/* ------------------------------------------------------------------- ops */

function fail(error) {
  setStatus("写入失败", "down");
  el.hint.className = "hint warn";
  el.hint.textContent = "写入插件设置失败：" + (error && error.message ? error.message : error);
}

async function refresh() {
  try {
    current = await readSettings();
    render();
    setStatus("已连接", "live");
  } catch (error) {
    setStatus("读取失败", "down");
    fail(error);
  }
}

async function guard(fn) {
  if (busy) return;
  busy = true;
  try {
    await fn();
    setStatus("已保存", "live");
    setTimeout(() => setStatus("已连接", "live"), 1200);
  } catch (error) {
    fail(error);
  } finally {
    busy = false;
  }
}

/* ------------------------------------------------------------------ boot */

el.refresh.addEventListener("click", refresh);
el.target.addEventListener("change", () => guard(() => writeSettings({ preferredUpstream: el.target.value })));
el.inject.addEventListener("change", () => guard(() => writeSettings({ injectRouting: el.inject.checked })));
el.hardPin.addEventListener("change", () => guard(() => writeSettings({ hardPin: el.hardPin.checked })));
el.toast.addEventListener("change", () => guard(() => writeSettings({ toastOnMismatch: el.toast.checked })));

(async function boot() {
  await refresh();
  setInterval(refresh, 4000);
})();
