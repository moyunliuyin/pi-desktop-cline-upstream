"use strict";

/**
 * Cline Upstream — panel.
 *
 * Reads the snapshot the plugin process publishes into its own settings, via the
 * documented `pluginBridge.plugin.getSettings` channel. No panel-side network:
 * panels are not the right place to reach loopback, and the host denies it.
 *
 * Everything shown here comes from the gateway's own `routing` block, so
 * "实际落点" is measured, not guessed.
 */

const el = {
  status: document.getElementById("status"),
  pulse: document.getElementById("pulse"),
  refresh: document.getElementById("refresh"),
  preferred: document.getElementById("preferred"),
  inject: document.getElementById("inject"),
  hardPin: document.getElementById("hardPin"),
  hint: document.getElementById("hint"),
  rows: document.getElementById("rows"),
  footLeft: document.getElementById("foot-left"),
  footRight: document.getElementById("foot-right"),
};

/* ----------------------------------------------------------------- bridge */

function bridge() {
  return window.pluginBridge || null;
}

async function readSettings() {
  const b = bridge();
  if (!b || !b.plugin || typeof b.plugin.getSettings !== "function") {
    throw new Error("pluginBridge.plugin.getSettings 不可用");
  }
  return (await b.plugin.getSettings()) || {};
}

function parseSnapshot(settings) {
  const raw = settings && settings.routingSnapshot;
  if (!raw || typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------------- utils */

function fmtCount(value) {
  if (value === null || value === undefined) return "—";
  return String(value);
}

function fmtCost(value) {
  if (!value) return "—";
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);
  if (num === 0) return "$0";
  if (num < 0.01) return "$" + num.toFixed(5);
  return "$" + num.toFixed(4);
}

function fmtAgo(ts) {
  if (!ts) return "—";
  const delta = Date.now() - Number(ts);
  if (!Number.isFinite(delta) || delta < 0) return "—";
  const sec = Math.floor(delta / 1000);
  if (sec < 60) return sec + " 秒前";
  const min = Math.floor(sec / 60);
  if (min < 60) return min + " 分钟前";
  const hour = Math.floor(min / 60);
  if (hour < 24) return hour + " 小时前";
  return Math.floor(hour / 24) + " 天前";
}

function cell(text, className) {
  const td = document.createElement("td");
  if (className) td.className = className;
  if (text instanceof Node) td.appendChild(text);
  else td.textContent = text === null || text === undefined ? "—" : String(text);
  return td;
}

function providerChip(name, matched) {
  const span = document.createElement("span");
  span.className = "provider" + (matched === true ? " hit" : matched === false ? " miss" : "");
  span.textContent = name || "—";
  return span;
}

function verdictBadge(entry) {
  const span = document.createElement("span");
  if (entry.injected) {
    if (entry.matched === true) {
      span.className = "badge ok";
      span.textContent = "已生效";
      span.title = "请求里写了目标上游，网关实际就落在它上面";
    } else if (entry.matched === false) {
      span.className = "badge bad";
      span.textContent = "未生效";
      span.title = "请求里写了目标上游，但网关落到了别家 —— 说明 Cline 不接受该字段";
    } else {
      span.className = "badge idle";
      span.textContent = "无元数据";
      span.title = "响应里没有 routing 信息，无法校验";
    }
  } else {
    span.className = "badge idle";
    span.textContent = "仅观察";
    span.title = "没有写入 routing 字段，只记录网关自己的选择";
  }
  return span;
}

/* ---------------------------------------------------------------- render */

function renderTable(snapshot) {
  const models = (snapshot && snapshot.models) || {};
  const entries = Object.entries(models).sort((a, b) => (b[1].at || 0) - (a[1].at || 0));

  if (entries.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 8;
    td.className = "empty";
    td.textContent = "还没有记录。把模型切到「Cline Upstream」服务商，随便发一条消息。";
    tr.appendChild(td);
    el.rows.replaceChildren(tr);
    return;
  }

  const frag = document.createDocumentFragment();
  for (const [model, entry] of entries) {
    const tr = document.createElement("tr");
    tr.appendChild(cell(model, "model"));
    tr.appendChild(cell(providerChip(entry.finalProvider, entry.matched)));
    tr.appendChild(cell(entry.pinnedProvider ? providerChip(entry.pinnedProvider, null) : "—"));
    tr.appendChild(cell(fmtCount(entry.fallbackCount), "num"));
    tr.appendChild(cell(fmtCount(entry.cacheHitTokens), "num"));
    tr.appendChild(cell(fmtCost(entry.cost), "num"));
    tr.appendChild(cell(verdictBadge(entry)));
    tr.appendChild(cell(fmtAgo(entry.at)));
    frag.appendChild(tr);
  }
  el.rows.replaceChildren(frag);
}

function renderControls(settings) {
  const s = settings || {};
  el.preferred.value = s.preferredUpstream || "";
  el.inject.checked = Boolean(s.injectRouting);
  el.hardPin.checked = Boolean(s.hardPin);
}

function setStatus(text, mode) {
  el.status.textContent = text;
  el.pulse.className = "pulse" + (mode === "live" ? " live" : mode === "down" ? " down" : "");
}

/* ------------------------------------------------------------------- ops */

async function refresh() {
  try {
    const settings = await readSettings();
    const snapshot = parseSnapshot(settings);
    renderControls(settings);
    renderTable(snapshot);

    const count = Object.keys((snapshot && snapshot.models) || {}).length;
    el.footLeft.textContent = count === 0 ? "尚无记录" : "已记录 " + count + " 个模型";
    el.footRight.textContent = snapshot && snapshot.at
      ? "最近更新 " + new Date(snapshot.at).toLocaleTimeString()
      : "等待第一次请求";

    const hasTarget = Boolean(settings.preferredUpstream);
    if (settings.injectRouting && hasTarget) {
      el.hint.classList.remove("warn");
      el.hint.textContent = "正在尝试把请求钉到「" + settings.preferredUpstream + "」，每次响应都会自动校验是否真的生效。";
    } else if (hasTarget) {
      el.hint.classList.remove("warn");
      el.hint.textContent = "已设定目标「" + settings.preferredUpstream + "」但未开启写入。当前只观察，不干预路由。";
    } else {
      el.hint.classList.remove("warn");
      el.hint.textContent = "本面板只读：数据来自 Cline 网关自己返回的 routing 元数据。目标上游与开关请到 设置 → 插件 → Cline 上游 里改。";
    }
    setStatus("已连接", "live");
  } catch (error) {
    setStatus("读取失败", "down");
    el.hint.classList.add("warn");
    el.hint.textContent = "读取插件设置失败：" + (error && error.message ? error.message : error);
  }
}

el.refresh.addEventListener("click", refresh);
el.preferred.disabled = true;
el.inject.disabled = true;
el.hardPin.disabled = true;

(async function boot() {
  await refresh();
  setInterval(refresh, 3000);
})();
