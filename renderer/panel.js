"use strict";

/**
 * Cline Upstream — panel (interactive).
 *
 * Read path: `plugin.getSettings` is a host bridge channel.
 * Write path: the app forwards unknown channels to the plugin's
 * `onPanelInvoke`, so writes go through `writeSettings` and land in main.js.
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
  const result = await invoke("writeSettings", next);
  if (result && result.settings) current = result.settings;
  else current = next;
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

function setStatus(text, mode) {
  el.status.textContent = text;
  el.pulse.className = "pulse" + (mode === "live" ? " live" : mode === "down" ? " down" : "");
}

function checkRow(id, checked, labelText, metaText, onChange) {
  const label = document.createElement("label");
  label.className = "model";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = checked;
  box.addEventListener("change", () => {
    if (busy) return;
    onChange(box.checked);
  });
  const text = document.createElement("span");
  text.textContent = labelText;
  label.append(box, text);
  if (metaText) {
    const meta = document.createElement("em");
    meta.className = "meta";
    meta.textContent = metaText;
    label.appendChild(meta);
  }
  if (id) label.dataset.id = id;
  return label;
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

function renderUpstreamChecks(settings, detected) {
  const target = settings.preferredUpstream || "";
  const names = [];
  const seen = new Set();
  for (const d of detected) {
    if (!seen.has(d.name)) { seen.add(d.name); names.push(d.name); }
  }
  for (const n of KNOWN_UPSTREAMS) {
    if (!seen.has(n)) { seen.add(n); names.push(n); }
  }

  const frag = document.createDocumentFragment();
  const meta = new Map(detected.map((d) => [d.name, `${d.final}/${d.pinned}/${d.fallback}`]));
  frag.appendChild(
    checkRow("", target === "", "不指定（只观察）", "", (checked) =>
      writeSettings({ preferredUpstream: checked ? "" : "" }).catch(fail)
    )
  );
  for (const name of names) {
    frag.appendChild(
      checkRow(name, target === name, name, meta.get(name) || "0/0/0", (checked) => {
        // 单选：勾上即设为目标并开启写入；取消勾选等于回到不指定
        writeSettings(checked
          ? { preferredUpstream: name, injectRouting: true }
          : { preferredUpstream: "" }
        ).catch(fail);
      })
    );
  }
  el.upstreams.replaceChildren(frag);
}

function renderModels(settings, snapshot) {
  const available = (snapshot && snapshot.available) || [];
  if (available.length === 0) {
    el.models.replaceChildren();
    el.modelsHint.textContent = "还没有模型目录：插件载入后会自己拉取（失败则用内置 18 个）。";
    return;
  }
  const chosen = splitModels(settings.enabledModels);
  const all = chosen.length === 0;
  el.modelsHint.textContent = all
    ? `共 ${available.length} 个可用模型，当前全部启用`
    : `共 ${available.length} 个可用模型，当前启用 ${chosen.length} 个`;

  const frag = document.createDocumentFragment();
  for (const id of available) {
    frag.appendChild(
      checkRow(id, all || chosen.includes(id), id, "", (checked) => {
        const base = splitModels(current.enabledModels);
        const seed = base.length === 0 ? available.slice() : base;
        const next = new Set(seed);
        if (checked) next.add(id);
        else next.delete(id);
        let list = [...next];
        if (list.length === available.length) list = [];
        writeSettings({ enabledModels: list.join(",") }).catch(fail);
      })
    );
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

  renderUpstreamChecks(settings, detected);
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
    el.hint.textContent = "勾选上面的上游即设为锚定目标（单选）。数据来自 Cline 网关自己返回的 routing 元数据。";
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
el.inject.addEventListener("change", () => guard(() => writeSettings({ injectRouting: el.inject.checked })));
el.hardPin.addEventListener("change", () => guard(() => writeSettings({ hardPin: el.hardPin.checked })));
el.toast.addEventListener("change", () => guard(() => writeSettings({ toastOnMismatch: el.toast.checked })));

(async function boot() {
  await refresh();
  setInterval(refresh, 4000);
})();
