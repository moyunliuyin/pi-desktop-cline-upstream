"use strict";

/**
 * Cline Upstream — panel (draft + save).
 *
 * Ticking a box only mutates a local draft; nothing is written until 保存.
 * Saving writes the settings once and then asks the plugin to re-apply them
 * (fetch the catalog and republish the declaration) in a single hot reload,
 * which is what makes the model selection actually take effect.
 *
 * Read path: `plugin.getSettings` (host bridge channel).
 * Write path: `writeSettings` / `applyModels` → plugin's onPanelInvoke.
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
  save: document.getElementById("save"),
  inject: document.getElementById("inject"),
  hardPin: document.getElementById("hardPin"),
  toast: document.getElementById("toast"),
  dirty: document.getElementById("dirty"),
  hint: document.getElementById("hint"),
  upstreams: document.getElementById("upstreams"),
  models: document.getElementById("models"),
  modelsHint: document.getElementById("models-hint"),
  rows: document.getElementById("rows"),
  footLeft: document.getElementById("foot-left"),
  footRight: document.getElementById("foot-right"),
};

let current = {};
let draft = null;
let dirty = false;
let busy = false;
let probing = null;
let lastProbe = null;

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

/* ----------------------------------------------------------------- utils */

function splitList(value) {
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

function markDirty() {
  dirty = true;
  el.dirty.classList.add("on");
  el.save.disabled = false;
}

function clearDirty() {
  dirty = false;
  el.dirty.classList.remove("on");
  el.save.disabled = true;
}

/* ----------------------------------------------------------------- draft */

function snapshotOf(settings) {
  return parseSnapshot(settings);
}

function availableModels(settings) {
  const snap = snapshotOf(settings);
  return (snap && snap.available) || [];
}

/** 某个模型已探测到的候选 id：[{ id, upstream }] */
function probeOf(settings, id) {
  const snap = snapshotOf(settings) || {};
  const all = snap.probe || {};
  return Array.isArray(all[id]) ? all[id] : [];
}

function parseThinking(raw) {
  try {
    const parsed = JSON.parse(String(raw || "") || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function makeDraft(settings) {
  const available = availableModels(settings);
  const chosen = splitList(settings.enabledModels);
  return {
    upstreams: new Set(splitList(settings.preferredUpstream)),
    modelsAll: chosen.length === 0,
    models: new Set(chosen.length === 0 ? available : chosen),
    thinking: new Map(Object.entries(parseThinking(settings.modelThinking))),
    overrides: new Map(Object.entries(parseThinking(settings.modelIdOverride))),
    inject: Boolean(settings.injectRouting),
    hardPin: Boolean(settings.hardPin),
    toast: settings.toastOnMismatch !== false,
  };
}

/* ---------------------------------------------------------------- render */

function detectedUpstreams(settings) {
  const snap = snapshotOf(settings);
  const counts = new Map();
  const bump = (name, kind) => {
    if (!name) return;
    const row = counts.get(name) || { name, final: 0, pinned: 0, fallback: 0 };
    row[kind] += 1;
    counts.set(name, row);
  };
  for (const entry of Object.values((snap && snap.models) || {})) {
    bump(entry.finalProvider, "final");
    bump(entry.pinnedProvider, "pinned");
    for (const name of entry.fallbacks || []) bump(name, "fallback");
  }
  return [...counts.values()].sort(
    (a, b) => b.final - a.final || b.pinned - a.pinned || b.fallback - a.fallback
  );
}

function checkRow(checked, labelText, metaText, onChange) {
  const label = document.createElement("label");
  label.className = "model" + (checked ? " on" : "");
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = checked;
  box.addEventListener("change", () => onChange(box.checked));
  const text = document.createElement("span");
  text.textContent = labelText;
  label.append(box, text);
  if (metaText) {
    const meta = document.createElement("em");
    meta.className = "meta";
    meta.textContent = metaText;
    label.appendChild(meta);
  }
  return label;
}

function renderUpstreams(settings) {
  const detected = detectedUpstreams(settings);
  const names = [];
  const seen = new Set();
  for (const d of detected) {
    if (!seen.has(d.name)) { seen.add(d.name); names.push(d.name); }
  }
  for (const n of KNOWN_UPSTREAMS) {
    if (!seen.has(n)) { seen.add(n); names.push(n); }
  }
  const meta = new Map(detected.map((d) => [d.name, `${d.final}/${d.pinned}/${d.fallback}`]));

  const frag = document.createDocumentFragment();
  for (const name of names) {
    frag.appendChild(
      checkRow(draft.upstreams.has(name), name, meta.get(name) || "0/0/0", (checked) => {
        if (checked) draft.upstreams.add(name);
        else draft.upstreams.delete(name);
        markDirty();
        renderUpstreams(settings);
      })
    );
  }
  el.upstreams.replaceChildren(frag);
}

function renderModels(settings) {
  const available = availableModels(settings);
  if (available.length === 0) {
    el.models.replaceChildren();
    el.modelsHint.textContent = "还没有模型目录：插件载入后会自己拉取（失败则用内置）。";
    return;
  }
  const checkedCount = available.filter((id) => draft.models.has(id)).length;
  const effCount = checkedCount === 0 ? available.length : checkedCount;
  const scope =
    checkedCount === available.length || checkedCount === 0
      ? "全部启用"
      : `已选 ${checkedCount} 个（未勾选的请求被拒绝）`;
  el.modelsHint.textContent = `共 ${available.length} 个，${scope} · 重启 PI 后模型下拉框 = ${effCount} 个 · 右侧可设思考强度与锚定上游`;
  const cat = (snapshotOf(settings) || {}).catalog;
  if (cat && cat.ok === false) {
    const why =
      cat.note === "no-api-key"
        ? "未填 key"
        : cat.note === "network"
          ? "网络失败"
          : String(cat.note || "未知原因");
    el.modelsHint.textContent += ` · 目录未刷新（${why}），当前显示已知模型`;
  }

  const meta = (snapshotOf(settings) || {}).modelMeta || {};
  const frag = document.createDocumentFragment();
  for (const id of available) {
    const row = document.createElement("div");
    row.className = "model-row";
    row.appendChild(
      checkRow(draft.models.has(id), id, "", (checked) => {
        if (checked) draft.models.add(id);
        else draft.models.delete(id);
        markDirty();
        renderModels(settings);
      })
    );
    const info = meta[id];
    if (info && Array.isArray(info.levels) && info.levels.length > 1) {
      const pick = document.createElement("select");
      pick.className = "think";
      pick.title = "默认思考强度（保存后重启 PI 生效）";
      for (const level of info.levels) {
        const opt = document.createElement("option");
        opt.value = level;
        opt.textContent = level;
        pick.appendChild(opt);
      }
      pick.value = draft.thinking.get(id) || info.default;
      pick.addEventListener("change", () => {
        draft.thinking.set(id, pick.value);
        markDirty();
      });
      row.appendChild(pick);
    }
    const probeRows = probeOf(settings, id);
    const override = document.createElement("select");
    override.className = "think route";
    override.title = "锚定上游：选一个会落到目标上游的模型 id（默认原样转发）";
    const keep = document.createElement("option");
    keep.value = "";
    keep.textContent = "原样转发";
    override.appendChild(keep);
    for (const row of probeRows) {
      const opt = document.createElement("option");
      opt.value = row.id;
      opt.textContent = row.upstream ? `${row.upstream} ← ${row.id}` : `${row.id}（探测失败）`;
      override.appendChild(opt);
    }
    override.value = draft.overrides.get(id) || "";
    override.addEventListener("change", () => {
      if (override.value) draft.overrides.set(id, override.value);
      else draft.overrides.delete(id);
      markDirty();
    });
    row.appendChild(override);

    const probe = document.createElement("button");
    probe.type = "button";
    probe.className = "ghost tiny";
    probe.textContent = probing === id ? "探测中…" : "探测";
    probe.disabled = probing !== null;
    probe.title = "用最小请求问一次上游：这个模型有哪些 id、各落在哪家（会产生少量真实调用）";
    probe.addEventListener("click", async () => {
      probing = id;
      renderModels(settings);
      try {
        const res = await invoke("probeUpstream", { model: id });
        if (res && Array.isArray(res.rows)) {
          let text;
          if (res.rows.length <= 1) {
            const only = res.rows[0] || {};
            text = `已探测 ${id}：上游目录里没有同族的替代 id，只能原样转发（当前落点 ${only.upstream || "未知"}）。`;
          } else {
            const union = new Map();
            for (const row of res.rows) {
              if (row.upstream) union.set(row.upstream, "primary");
              for (const name of row.fallbacks || []) if (!union.has(name)) union.set(name, "fallback");
            }
            const anchorable = res.rows.filter((r) => r.upstream).map((r) => `${r.upstream} ← ${r.id}`);
            const fallbackOnly = [...union.entries()]
              .filter(([, kind]) => kind === "fallback")
              .map(([name]) => name);
            text =
              `已探测 ${id} · 可达上游共 ${union.size} 家\n` +
              `可锚定（${anchorable.length}）：${anchorable.join("\n              ") || "无"}` +
              (fallbackOnly.length
                ? `\n仅备选（${fallbackOnly.length}）：${fallbackOnly.slice(0, 14).join("、")}${
                    fallbackOnly.length > 14 ? "…" : ""
                  }`
                : "");
          }
          lastProbe = text;
          el.hint.className = "hint";
          el.hint.textContent = text;
        }
      } catch (error) {
        el.hint.className = "hint warn";
        el.hint.textContent = error && error.message ? error.message : String(error);
      } finally {
        probing = null;
        await refresh(true);
      }
    });
    row.appendChild(probe);
    frag.appendChild(row);
  }
  el.models.replaceChildren(frag);
}

function fmtTime(ms) {
  if (!ms) return "—";
  const d = new Date(ms);
  const p2 = (n) => String(n).padStart(2, "0");
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

/** 逐条请求日志：一条请求一行，按时间倒序。 */
function renderTable(settings) {
  const snap = snapshotOf(settings) || {};
  const items = Array.isArray(snap.log) ? snap.log : [];
  const td = (text, cls) => {
    const c = document.createElement("td");
    if (cls) c.className = cls;
    c.textContent = text === null || text === undefined || text === "" ? "—" : String(text);
    return c;
  };
  if (items.length === 0) {
    const tr = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 8;
    cell.className = "empty";
    cell.textContent = "还没有请求记录：用该服务商发一条消息，这里会按请求逐条记下来。";
    tr.appendChild(cell);
    el.rows.replaceChildren(tr);
    return;
  }
  const frag = document.createDocumentFragment();
  for (const e of items) {
    const tr = document.createElement("tr");
    tr.appendChild(td(fmtTime(e.at), "time"));
    tr.appendChild(td(e.model, "model"));

    const final = td("");
    const span = document.createElement("span");
    span.className = "provider" + (e.matched === true ? " hit" : e.matched === false ? " miss" : "");
    span.textContent = e.finalProvider || "—";
    final.appendChild(span);
    tr.appendChild(final);

    tr.appendChild(td(e.pinnedProvider));
    tr.appendChild(td(fmtCount(e.fallbackCount), "num"));
    tr.appendChild(td(fmtCount(e.cacheHitTokens), "num"));
    tr.appendChild(td(fmtCost(e.cost), "num"));

    const verdict = td("");
    const badge = document.createElement("span");
    if (e.injected) {
      badge.className = "badge " + (e.matched === true ? "ok" : e.matched === false ? "bad" : "idle");
      badge.textContent = e.matched === true ? "落点一致" : e.matched === false ? "网关忽略" : "无元数据";
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

function renderHints(settings) {
  const hasKey = Boolean(settings.apiKey || settings.apiKeyEnc);
  const targets = splitList(settings.preferredUpstream);
  if (!hasKey) {
    el.hint.className = "hint warn";
    el.hint.textContent = "还没有填写 ClinePass API Key：设置 → 插件 → Cline 上游。没有 key 时插件无法转发请求。";
  } else if (targets.length && settings.injectRouting) {
    el.hint.className = "hint warn";
    el.hint.textContent =
      `已把「${targets.join(" / ")}」写进请求的 provider 字段，但实测 Cline 网关会忽略它：` +
      "落点仍由会话亲和决定，所以「网关忽略」是预期结果，不是配置错了。";
  } else if (targets.length) {
    el.hint.className = "hint";
    el.hint.textContent = `已记下目标「${targets.join(" / ")}」，当前只观察，不改写请求。`;
  } else {
    el.hint.className = "hint";
    el.hint.textContent =
      "本插件负责观察：每个请求落在哪个上游、还有多少备选、花了多少钱。勾选上游只是实验，网关目前忽略。";
  }

  // 探测结果要能留住：refresh() 会走 renderHints()，否则刚显示就被通用提示覆盖
  if (lastProbe) {
    el.hint.className = "hint";
    el.hint.textContent += "\n" + lastProbe;
  }
}

function render() {
  const settings = current || {};
  const snap = snapshotOf(settings);
  renderUpstreams(settings);
  renderModels(settings);
  renderTable(settings);
  renderHints(settings);

  el.inject.checked = draft.inject;
  el.hardPin.checked = draft.hardPin;
  el.toast.checked = draft.toast;

  const rows = Object.keys((snap && snap.models) || {}).length;
  el.footLeft.textContent = rows === 0 ? "尚无请求记录" : `已记录 ${rows} 个模型`;
  el.footRight.textContent = snap && snap.at
    ? "最近更新 " + new Date(snap.at).toLocaleTimeString()
    : "等待第一次请求";
}

/* ------------------------------------------------------------------- ops */

function fail(error) {
  setStatus("失败", "down");
  el.hint.className = "hint warn";
  el.hint.textContent = (error && error.message ? error.message : String(error));
}

async function refresh(keepDraft) {
  try {
    const next = await readSettings();
    const first = !current || !current.routingSnapshot;
    const availableChanged =
      JSON.stringify(availableModels(next)) !== JSON.stringify(availableModels(current));
    current = next;
    if (!draft || first || (availableChanged && !dirty)) draft = makeDraft(current);
    if (!keepDraft && !dirty) draft = makeDraft(current);
    render();
    setStatus("已连接", "live");
  } catch (error) {
    setStatus("读取失败", "down");
    fail(error);
  }
}

async function save() {
  if (busy) return;
  busy = true;
  el.save.disabled = true;
  try {
    const available = availableModels(current);
    const all = available.length > 0 && available.every((id) => draft.models.has(id));
    const patch = {
      preferredUpstream: [...draft.upstreams].join(","),
      enabledModels: all ? "" : [...draft.models].join(","),
      injectRouting: draft.inject,
      hardPin: draft.hardPin,
      toastOnMismatch: draft.toast,
      modelThinking: JSON.stringify(Object.fromEntries(draft.thinking)),
      modelIdOverride: JSON.stringify(Object.fromEntries(draft.overrides)),
    };
    const res = await invoke("writeSettings", patch);
    if (res && res.settings) current = res.settings;
    clearDirty();
    setStatus("已保存，正在应用…", "live");
    const applied = await invoke("applyModels");
    setStatus("已应用", "live");
    if (applied && typeof applied.applied === "number") {
      el.hint.className = "hint";
      el.hint.textContent = `已保存：清单改为 ${applied.applied} 个（可用 ${applied.available} 个）。PI 的模型下拉框要重启 PI 后才会跟着变。`;
    }
    await refresh(true);
  } catch (error) {
    fail(error);
  } finally {
    busy = false;
    el.save.disabled = !dirty;
  }
}

/* ------------------------------------------------------------------ boot */

function bindDraftSwitch(node, key) {
  node.addEventListener("change", () => {
    draft[key] = node.checked;
    markDirty();
  });
}

el.refresh.addEventListener("click", () => refresh(false));
el.save.addEventListener("click", save);
bindDraftSwitch(el.inject, "inject");
bindDraftSwitch(el.hardPin, "hardPin");
bindDraftSwitch(el.toast, "toast");

(async function boot() {
  await refresh(false);
  setInterval(() => { if (!dirty) refresh(true); }, 4000);
})();
