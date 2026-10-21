"use strict";

/**
 * Cline Upstream — expose ClinePass' real upstream choice.
 *
 * The plugin runs a loopback OpenAI-compatible endpoint and forwards chat
 * requests to api.cline.bot. The gateway answers every stream with its own
 * `routing` object; we read it out of the response and keep the last result
 * per model, then optionally try to pin a preferred provider and *verify* the
 * pin against that same object.
 */

const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { execFile } = require("node:child_process");

/* ---------------------------------------------------------- secret at rest */
/**
 * Windows 上用 DPAPI（绑定当前登录用户）加密 API Key 后再落盘，磁盘与快照里都只有密文；
 * 插件启动时解密到内存里用。其它平台没有等价机制，保持明文并记日志说明。
 */
const CAN_SEAL = process.platform === "win32";
const SEAL_SCRIPT =
  "$s=[Console]::In.ReadToEnd(); $sec=ConvertTo-SecureString $s -AsPlainText -Force; ConvertFrom-SecureString $sec";
const UNSEAL_SCRIPT =
  "$b=[Console]::In.ReadToEnd(); $sec=ConvertTo-SecureString $b; $p=[System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec); [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($p)";

function powerShell(script, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, timeout: 20000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(String(stderr || error.message || "powershell failed").trim()));
          return;
        }
        resolve(String(stdout).replace(/\r?\n$/, ""));
      }
    );
    child.stdin.end(String(input));
  });
}

async function sealKey(plain) {
  if (!CAN_SEAL) throw new Error("dpapi unavailable on " + process.platform);
  return powerShell(SEAL_SCRIPT, plain);
}

async function unsealKey(blob) {
  if (!CAN_SEAL) throw new Error("dpapi unavailable on " + process.platform);
  return powerShell(UNSEAL_SCRIPT, blob);
}
const SERVICE_ID = "provider-host";
const HOST = "127.0.0.1";
const PORT = 41891;
const UPSTREAM_HOST = "api.cline.bot";
const UPSTREAM_BASE = "/api/v1";
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const TEE_LIMIT = 8 * 1024 * 1024;
const STATE_VERSION = 1;

const DEFAULTS = {
  enabled: true,
  preferredUpstream: "",
  injectRouting: false,
  hardPin: false,
  toastOnMismatch: true,
  apiKey: "",
  apiKeyEnc: "",
  enabledModels: "",
};

let settings = Object.assign({}, DEFAULTS);
let server = null;
let manifest = null;
let dataDir = "";
let state = { version: STATE_VERSION, updatedAt: 0, models: {}, lastError: null };

/* ------------------------------------------------------------------ utils */

function log(level, message) {
  const line = `[cline-upstream] ${level}: ${message}`;
  if (level === "error") console.error(line);
  else console.log(line);
}

function messageOf(error) {
  if (!error) return "unknown error";
  return error.message || String(error);
}

function statePath() {
  return path.join(dataDir, "routing-state.json");
}

function loadState() {
  try {
    const raw = fs.readFileSync(statePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.models) {
      state = {
        version: STATE_VERSION,
        updatedAt: Number(parsed.updatedAt) || 0,
        models: parsed.models,
        lastError: parsed.lastError || null,
      };
    }
  } catch {
    /* first run: no state yet */
  }
}

let snapshotTimer = null;
let declarationTimer = null;

/**
 * Panels cannot reach loopback (the host denies panel egress to local hosts),
 * so the snapshot travels through the documented settings channel instead.
 * Debounced: a burst of turns publishes once.
 */
function publishSnapshot() {
  if (snapshotTimer) clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    if (!pi || !pi.plugin || typeof pi.plugin.setSettings !== "function") return;
    const payload = Object.assign({}, settings, {
      apiKey: "",
      routingSnapshot: JSON.stringify({
        at: state.updatedAt,
        models: state.models,
        available: state.availableModels || [],
        catalog: state.catalogStatus || null,
        log: (state.log || []).slice(0, 60),
      }),
    });
    Promise.resolve(pi.plugin.setSettings(payload)).catch((error) => {
      log("warn", "could not publish snapshot: " + messageOf(error));
    });
  }, 400);
}

function saveState() {
  if (!dataDir) return;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify(state), "utf8");
  } catch (error) {
    log("warn", "could not persist state: " + messageOf(error));
  }
  publishSnapshot();
}

function enabledModelSet() {
  const raw = String(settings.enabledModels || "");
  if (!raw.trim()) return null;
  const ids = raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.length ? new Set(ids) : null;
}

function filterByWhitelist(list) {
  const set = enabledModelSet();
  return set ? list.filter((m) => set.has(m.id)) : list;
}

/**
 * 像 wtq-pool 那样改写自己安装目录里的 manifest.json：宿主重读清单后，
 * 服务商的模型表就变成用户勾选的那批。原子写，失败只记日志。
 */
function publishModels(ids) {
  const target = path.join(__dirname, "manifest.json");
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(target, "utf8"));
  } catch (error) {
    log("warn", "manifest read failed: " + messageOf(error));
    return;
  }
  const providers = (doc.contributes && doc.contributes.providers) || [];
  if (!providers.length) return;
  if (!ids.length) {
    log("warn", "declaration not written: empty model selection");
    return;
  }
  const known = new Map([...KNOWN_MODELS, ...declaredModels()].map((m) => [m.id, m]));
  const next = ids.map((id) => {
    const src = known.get(id) || {};
    return {
      id,
      name: src.name || id,
      contextWindow: src.contextWindow || 200000,
      maxTokens: src.maxTokens || 32000,
      supportsImages: src.supportsImages !== false,
      thinkingLevels: src.thinkingLevels && src.thinkingLevels.length ? src.thinkingLevels : ["off", "low", "high", "max"],
      defaultThinkingLevel: src.defaultThinkingLevel || "high",
    };
  });
  const before = (providers[0].models || []).map((m) => m.id).join("|");
  const after = next.map((m) => m.id).join("|");
  if (before === after) return;
  providers[0].models = next;
  doc.contributes.providers = providers;
  const tmp = target + ".tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, target);
    log("info", "declaration updated: " + next.length + " models");
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* nothing to clean */
    }
    log("warn", "manifest write failed: " + messageOf(error));
  }
}

/** 未勾选的模型即使仍留在 PI 的服务商表里，也会在转发层被拒绝。 */
function modelAllowed(model) {
  const set = enabledModelSet();
  if (!set) return true;
  return set.has(model);
}

function filterIds(ids) {
  const set = enabledModelSet();
  return set ? ids.filter((id) => set.has(id)) : ids;
}

/**
 * 出厂自带的上游清单：/api/v1/models 会变（曾返回 18 个 cline-pass，后来换成 468 个
 * OpenRouter 风格 id），所以面板的「可选模型」不能只靠它。这里存全量，含参数。
 */
const KNOWN_MODELS = [
  { id: "cline-pass/deepseek-v4-flash", name: "DeepSeek V4 Flash", contextWindow: 1000000, maxTokens: 384000, supportsImages: false, thinkingLevels: ["off", "none", "low", "high", "max"], defaultThinkingLevel: "high" },
  { id: "cline-pass/deepseek-v4-pro", name: "DeepSeek V4 Pro", contextWindow: 1000000, maxTokens: 384000, supportsImages: false, thinkingLevels: ["off", "none", "high", "max"], defaultThinkingLevel: "high" },
  { id: "cline-pass/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", contextWindow: 1000000, maxTokens: 384000, supportsImages: true, thinkingLevels: ["off", "none", "low", "high", "max"], defaultThinkingLevel: "high" },
  { id: "cline-pass/glm-5.2", name: "GLM-5.2", contextWindow: 1000000, maxTokens: 131072, supportsImages: false, thinkingLevels: ["off", "none", "high", "max"], defaultThinkingLevel: "high" },
  { id: "cline-pass/glm-5.3", name: "GLM-5.3", contextWindow: 1000000, maxTokens: 131072, supportsImages: false, thinkingLevels: ["off", "low", "high", "max"], defaultThinkingLevel: "high" },
  { id: "cline-pass/glm-5.3-flash", name: "GLM-5.3 Flash", contextWindow: 1000000, maxTokens: 131072, supportsImages: true, thinkingLevels: ["off", "low", "high", "max"], defaultThinkingLevel: "high" },
  { id: "cline-pass/kimi-k2.6", name: "Kimi K2.6", contextWindow: 262144, maxTokens: 262144, supportsImages: true, thinkingLevels: ["off"], defaultThinkingLevel: "off" },
  { id: "cline-pass/kimi-k2.7-code", name: "Kimi K2.7 Code", contextWindow: 262144, maxTokens: 262144, supportsImages: true, thinkingLevels: ["off"], defaultThinkingLevel: "off" },
  { id: "cline-pass/kimi-k3", name: "Kimi K3", contextWindow: 1048576, maxTokens: 131072, supportsImages: true, thinkingLevels: ["off", "none", "low", "high", "max"], defaultThinkingLevel: "high" },
  { id: "cline-pass/mimo-v2.5", name: "MiMo-V2.5", contextWindow: 1048576, maxTokens: 131072, supportsImages: true, thinkingLevels: ["off"], defaultThinkingLevel: "off" },
  { id: "cline-pass/mimo-v2.5-pro", name: "MiMo-V2.5-Pro", contextWindow: 1048576, maxTokens: 131072, supportsImages: false, thinkingLevels: ["off"], defaultThinkingLevel: "off" },
  { id: "cline-pass/mimo-v2.6-flash", name: "MiMo-V2.6-Flash", contextWindow: 1048576, maxTokens: 131072, supportsImages: true, thinkingLevels: ["off", "none", "low", "medium", "high", "xhigh"], defaultThinkingLevel: "high" },
  { id: "cline-pass/mimo-v2.6-pro", name: "MiMo-V2.6-Pro", contextWindow: 1048576, maxTokens: 131072, supportsImages: true, thinkingLevels: ["off", "none", "low", "medium", "high", "xhigh"], defaultThinkingLevel: "high" },
  { id: "cline-pass/minimax-m3", name: "MiniMax-M3", contextWindow: 1048576, maxTokens: 512000, supportsImages: true, thinkingLevels: ["off"], defaultThinkingLevel: "off" },
  { id: "cline-pass/muse-spark-1.3-contributor", name: "Muse Spark 1.3 Contributor", contextWindow: 1048576, maxTokens: 131072, supportsImages: true, thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh"], defaultThinkingLevel: "high" },
  { id: "cline-pass/qwen3.7-max", name: "Qwen3.7 Max", contextWindow: 1000000, maxTokens: 65536, supportsImages: false, thinkingLevels: ["off"], defaultThinkingLevel: "off" },
  { id: "cline-pass/qwen3.7-plus", name: "Qwen3.7 Plus", contextWindow: 1000000, maxTokens: 64000, supportsImages: true, thinkingLevels: ["off"], defaultThinkingLevel: "off" },
  { id: "cline-pass/qwen3.8-max", name: "Qwen3.8 Max", contextWindow: 1000000, maxTokens: 131072, supportsImages: true, thinkingLevels: ["off", "none", "low", "medium", "xhigh"], defaultThinkingLevel: "off" },
];

/**
 * 目录只增不减：拉取失败时退回「已知的全部模型」，绝不因为清单被缩过就跟着缩水。
 * 否则面板会把自己锁死——只剩声明里那几个，用户再也勾不回来。
 */
function knownCatalog() {
  const seeded = declaredModels().map((m) => m.id);
  const cached = Array.isArray(state.catalog) ? state.catalog : [];
  const previous = Array.isArray(state.availableModels) ? state.availableModels : [];
  const seen = [];
  for (const id of [...KNOWN_MODELS.map((m) => m.id), ...seeded, ...cached, ...previous]) {
    if (id && seen.indexOf(id) === -1) seen.push(id);
  }
  return seen;
}

function fetchCatalog(done) {
  const known = knownCatalog();
  const finish = (ids, ok, note) => {
    state.availableModels = ids;
    state.catalogStatus = { ok, at: Date.now(), count: ids.length, note: note || null };
    saveState();
    if (done) done(ids);
  };
  if (!settings.apiKey) {
    finish(known, false, "no-api-key");
    return;
  }
  const req = https.request(
    {
      host: UPSTREAM_HOST,
      port: 443,
      method: "GET",
      path: UPSTREAM_BASE + "/models",
      headers: { authorization: "Bearer " + settings.apiKey, accept: "application/json" },
    },
    (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        let ids = [];
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          ids = (Array.isArray(parsed && parsed.data) ? parsed.data : [])
            .filter((m) => m && typeof m.id === "string" && m.id.startsWith("cline-pass/"))
            .map((m) => m.id);
        } catch (error) {
          log("warn", "catalog parse failed: " + messageOf(error));
        }
        if (!ids.length) {
          log("warn", "catalog empty (status " + res.statusCode + "), keeping " + known.length + " known models");
          finish(known, false, "empty:" + res.statusCode);
          return;
        }
        const merged = known.slice();
        for (const id of ids) {
          if (merged.indexOf(id) === -1) merged.push(id);
        }
        state.catalog = merged;
        finish(merged, true);
      });
    }
  );
  req.on("error", (error) => {
    log("warn", "catalog fetch failed: " + messageOf(error));
    finish(known, false, "network");
  });
  req.end();
}

function declaredModels() {
  const providers = (manifest && manifest.contributes && manifest.contributes.providers) || [];
  const mine = providers.find((p) => p && p.id === "cline-upstream") || providers[0];
  return (mine && mine.models) || [];
}

/* --------------------------------------------------------------- manifest */

async function readManifest() {
  try {
    if (pi && pi.plugin && typeof pi.plugin.getManifest === "function") {
      manifest = await pi.plugin.getManifest();
    }
  } catch (error) {
    log("warn", "getManifest failed: " + messageOf(error));
  }
  if (!manifest) {
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "manifest.json"), "utf8"));
    } catch (error) {
      log("warn", "manifest fallback failed: " + messageOf(error));
      manifest = {};
    }
  }
}

/* ---------------------------------------------------------------- routing */

function numberAfter(text, key) {
  const m = new RegExp('"' + key + '"\\s*:\\s*(\\d+)').exec(text);
  return m ? Number(m[1]) : null;
}

function stringAfter(text, key) {
  const m = new RegExp('"' + key + '"\\s*:\\s*"([^"]*)"').exec(text);
  return m ? m[1] : null;
}

/** Pull the gateway's routing block out of a (possibly SSE) response body. */
function parseRouting(body) {
  if (!body) return null;
  const at = body.lastIndexOf('"routing"');
  if (at < 0) return null;
  const window = body.slice(at, at + 8000);

  let fallbackCount = null;
  let fallbackNames = [];
  const list = /"fallbacksAvailable"\s*:\s*\[([^\]]*)\]/.exec(window);
  if (list) {
    fallbackNames = list[1]
      .split(",")
      .map((s) => s.trim().replace(/^"|"$/g, ""))
      .filter(Boolean)
      .slice(0, 40);
    fallbackCount = fallbackNames.length;
  }

  return {
    finalProvider: stringAfter(window, "finalProvider"),
    resolvedProvider: stringAfter(window, "resolvedProvider"),
    pinnedProvider: stringAfter(window, "pinnedProvider"),
    affinityOutcome: stringAfter(window, "affinity"),
    canonicalSlug: stringAfter(window, "canonicalSlug"),
    originalModelId: stringAfter(window, "originalModelId"),
    fallbackCount,
    fallbacks: fallbackNames,
    modelAttemptCount: numberAfter(window, "modelAttemptCount"),
    providerAttemptCount: numberAfter(window, "providerAttemptCount"),
    cacheHitTokens: numberAfter(body, "promptCacheHitTokens"),
    cacheMissTokens: numberAfter(body, "promptCacheMissTokens"),
    cost: stringAfter(body, "cost"),
  };
}

function recordResult(model, routing, injected, statusCode) {
  if (!model) return;
  const preferred = selectedUpstreams().join(" / ");
  const entry = {
    at: Date.now(),
    statusCode,
    finalProvider: routing ? routing.finalProvider : null,
    resolvedProvider: routing ? routing.resolvedProvider : null,
    pinnedProvider: routing ? routing.pinnedProvider : null,
    canonicalSlug: routing ? routing.canonicalSlug : null,
    fallbackCount: routing ? routing.fallbackCount : null,
    fallbacks: routing && Array.isArray(routing.fallbacks) ? routing.fallbacks : [],
    modelAttemptCount: routing ? routing.modelAttemptCount : null,
    providerAttemptCount: routing ? routing.providerAttemptCount : null,
    cacheHitTokens: routing ? routing.cacheHitTokens : null,
    cacheMissTokens: routing ? routing.cacheMissTokens : null,
    cost: routing ? routing.cost : null,
    injected: injected ? preferred : null,
    matched:
      injected && routing && routing.finalProvider
        ? selectedUpstreams().indexOf(routing.finalProvider) !== -1
        : null,
    requests: ((state.models[model] && state.models[model].requests) || 0) + 1,
  };

  state.models[model] = entry;

  // 逐条请求日志：面板按行展示（模型名 + 时间 + 落点），保留最近 200 条
  const item = {
    at: entry.at,
    model,
    statusCode: entry.statusCode,
    finalProvider: entry.finalProvider,
    pinnedProvider: entry.pinnedProvider,
    fallbackCount: entry.fallbackCount,
    cacheHitTokens: entry.cacheHitTokens,
    cost: entry.cost,
    injected: entry.injected,
    matched: entry.matched,
  };
  if (!Array.isArray(state.log)) state.log = [];
  state.log.unshift(item);
  if (state.log.length > 200) state.log.length = 200;
  state.updatedAt = entry.at;
  state.lastError = null;
  saveState();

  if (injected && entry.matched === false && settings.toastOnMismatch) {
    const actual = entry.finalProvider || "未知";
    toast(`目标上游 ${preferred}，实际落在 ${actual}`);
  }
  if (injected && !routing) {
    log("warn", "response carried no routing metadata; pin cannot be verified");
  }
}

async function toast(message) {
  try {
    if (pi && pi.ui && typeof pi.ui.showToast === "function") await pi.ui.showToast(message);
  } catch (error) {
    log("warn", "toast failed: " + messageOf(error));
  }
}

/* ------------------------------------------------------------------ proxy */

function writeJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function forwardHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = key.toLowerCase();
    if (lower === "host" || lower === "content-length" || lower === "connection") continue;
    // Ask for identity so the routing block stays readable.
    if (lower === "accept-encoding") continue;
    out[key] = value;
  }
  return out;
}

/** 目标上游可以是多个：provider.only 本身就是白名单数组。 */
function selectedUpstreams() {
  return String(settings.preferredUpstream || "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function injectRouting(model, payload) {
  if (!settings.injectRouting) return false;
  const list = selectedUpstreams();
  if (list.length === 0) return false;
  if (typeof model !== "string" || !model.startsWith("cline-pass/")) return false;

  const provider = { only: list };
  if (settings.hardPin) provider.allow_fallbacks = false;
  payload.provider = provider;
  return true;
}

function proxyChat(req, res) {
  readBody(req)
    .then((buffer) => {
      let payload = null;
      let model = null;
      let injected = false;

      try {
        payload = JSON.parse(buffer.toString("utf8"));
        model = payload.model;
        injected = injectRouting(model, payload);
      } catch (error) {
        log("warn", "could not parse request body, forwarding verbatim: " + messageOf(error));
      }

      if (model && !modelAllowed(model)) {
        // PI 的服务商模型表由宿主持有，取消勾选改不动它；这里直接挡掉。
        writeJson(res, 404, {
          error: {
            message: "model not enabled in Cline Upstream: " + model,
            type: "invalid_request_error",
            code: "model_not_enabled",
          },
        });
        return;
      }

      const outgoing = injected ? Buffer.from(JSON.stringify(payload), "utf8") : buffer;
      const headers = forwardHeaders(req.headers);
      // 插件自持 key 优先：宿主不会把其它服务商的凭据交给插件
      if (settings.apiKey) headers["authorization"] = "Bearer " + settings.apiKey;
      headers["content-length"] = outgoing.length;

      const upstream = https.request(
        {
          host: UPSTREAM_HOST,
          port: 443,
          method: req.method,
          path: UPSTREAM_BASE + "/chat/completions",
          headers,
        },
        (upstreamRes) => {
          const responseHeaders = {};
          for (const [key, value] of Object.entries(upstreamRes.headers || {})) {
            const lower = key.toLowerCase();
            if (lower === "connection" || lower === "transfer-encoding" || lower === "content-length") continue;
            responseHeaders[key] = value;
          }
          res.writeHead(upstreamRes.statusCode || 502, responseHeaders);

          const tee = [];
          let teeSize = 0;

          upstreamRes.on("data", (chunk) => {
            res.write(chunk);
            if (teeSize < TEE_LIMIT) {
              tee.push(chunk);
              teeSize += chunk.length;
            }
          });

          upstreamRes.on("end", () => {
            res.end();
            let routing = null;
            try {
              routing = parseRouting(Buffer.concat(tee).toString("utf8"));
            } catch (error) {
              log("warn", "routing parse failed: " + messageOf(error));
            }
            recordResult(model, routing, injected, upstreamRes.statusCode || 0);
          });

          upstreamRes.on("error", (error) => {
            log("warn", "upstream stream error: " + messageOf(error));
            try {
              res.end();
            } catch {
              /* already closed */
            }
          });
        }
      );

      upstream.on("error", (error) => {
        log("error", "upstream request failed: " + messageOf(error));
        state.lastError = messageOf(error);
        saveState();
        if (!res.headersSent) writeJson(res, 502, { error: { message: messageOf(error), type: "upstream_unreachable" } });
        else res.end();
      });

      req.on("close", () => {
        if (!res.writableEnded) upstream.destroy();
      });

      upstream.end(outgoing);
    })
    .catch((error) => {
      if (!res.headersSent) writeJson(res, 400, { error: { message: messageOf(error), type: "bad_request" } });
    });
}

/* ---------------------------------------------------------------- routing */

function snapshot() {
  return {
    settings,
    models: state.models,
    updatedAt: state.updatedAt,
    lastError: state.lastError,
    catalogStatus: state.catalogStatus || null,
    declared: declaredModels().map((m) => m.id),
  };
}

function applySettings(next) {
  if (!next || typeof next !== "object") return;
  for (const key of Object.keys(DEFAULTS)) {
    if (key in next) settings[key] = next[key];
  }
  settings.preferredUpstream = String(settings.preferredUpstream || "").trim();
  settings.injectRouting = Boolean(settings.injectRouting);
  settings.hardPin = Boolean(settings.hardPin);
  settings.apiKey = String(settings.apiKey || "").trim();
  settings.enabledModels = String(settings.enabledModels || "").trim();
  settings.enabled = next.enabled === undefined ? settings.enabled : Boolean(next.enabled);
}

/* -------------------------------------------------------------- key at rest */

/** 把内存里的明文 key 加密写回宿主设置；磁盘上只保留密文。 */
async function persistSealedKey() {
  const plain = String(settings.apiKey || "").trim();
  if (!plain) return false;
  if (!CAN_SEAL) {
    log("warn", "no dpapi on " + process.platform + "; api key stays plaintext in plugin settings");
    return false;
  }
  try {
    const blob = await sealKey(plain);
    settings.apiKeyEnc = blob;
    if (pi && pi.plugin && typeof pi.plugin.setSettings === "function") {
      await pi.plugin.setSettings(Object.assign({}, settings, { apiKey: "" }));
    }
    log("info", "api key sealed with dpapi, blob chars " + blob.length);
    return true;
  } catch (error) {
    log("warn", "api key seal failed: " + messageOf(error));
    return false;
  }
}

/** 启动时把密文解回内存；老版本留下的明文则顺手加密掉。 */
async function hydrateKey() {
  if (String(settings.apiKey || "").trim()) {
    await persistSealedKey();
    return;
  }
  const blob = String(settings.apiKeyEnc || "").trim();
  if (!blob) return;
  try {
    settings.apiKey = String(await unsealKey(blob)).trim();
    log("info", "api key unsealed from dpapi blob");
  } catch (error) {
    log("warn", "api key unseal failed: " + messageOf(error));
  }
}

/* ----------------------------------------------------------------- server */

function handle(req, res) {
  const url = (req.url || "").split("?")[0];

  if (req.method === "OPTIONS") {
    res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "*" });
    res.end();
    return;
  }

  if (req.method === "GET" && url === "/v1/models") {
    // PI 的「获取列表」会打这里。只暴露声明里的模型（再按白名单过滤）：
    // 若返回完整目录，宿主会把整张目录抄回服务商行，清单就再也缩不回去。
    const exposed = filterIds(declaredModels().map((m) => m.id));
    writeJson(res, 200, {
      object: "list",
      data: exposed.map((id) => ({ id, object: "model", owned_by: "cline-pass" })),
    });
    return;
  }

  if (req.method === "GET" && (url === "/v1/__state" || url === "/__state")) {
    writeJson(res, 200, snapshot());
    return;
  }

  if (req.method === "POST" && (url === "/v1/__settings" || url === "/__settings")) {
    readBody(req)
      .then(async (buffer) => {
        const next = JSON.parse(buffer.toString("utf8") || "{}");
        applySettings(next);
        try {
          if (pi && pi.plugin && typeof pi.plugin.setSettings === "function") {
            await pi.plugin.setSettings(settings);
          }
        } catch (error) {
          log("warn", "setSettings failed: " + messageOf(error));
        }
        writeJson(res, 200, snapshot());
      })
      .catch((error) => writeJson(res, 400, { error: { message: messageOf(error) } }));
    return;
  }

  if (req.method === "POST" && (url === "/v1/__clear" || url === "/__clear")) {
    state.models = {};
    state.lastError = null;
    state.updatedAt = Date.now();
    saveState();
    writeJson(res, 200, snapshot());
    return;
  }

  if (req.method === "POST" && (url === "/v1/chat/completions" || url === "/v1/responses")) {
    proxyChat(req, res);
    return;
  }

  writeJson(res, 404, { error: { message: "not found: " + url, type: "invalid_request_error" } });
}

async function startServer() {
  if (server) return;
  await new Promise((resolve, reject) => {
    const created = http.createServer((req, res) => {
      try {
        handle(req, res);
      } catch (error) {
        log("error", "handler threw: " + messageOf(error));
        if (!res.headersSent) writeJson(res, 500, { error: { message: messageOf(error) } });
      }
    });
    created.once("error", reject);
    created.listen(PORT, HOST, () => {
      created.removeListener("error", reject);
      server = created;
      log("info", `loopback listening on http://${HOST}:${PORT}/v1`);
      resolve();
    });
  });
  if (!settings.enabled) log("warn", "plugin disabled in settings; request forwarding still needs the toggle");
}

async function stopServer() {
  if (!server) return;
  const closing = server;
  server = null;
  await new Promise((resolve) => closing.close(() => resolve()));
  log("info", "loopback stopped");
}

/* --------------------------------------------------------------- lifecycle */

async function onLoad() {
  await readManifest();

  try {
    if (pi && pi.plugin && typeof pi.plugin.getDataPath === "function") dataDir = await pi.plugin.getDataPath();
  } catch (error) {
    log("warn", "getDataPath failed: " + messageOf(error));
  }
  if (!dataDir) dataDir = path.join(os.tmpdir(), "cline-upstream");
  loadState();

  // 老版本只存了「每个模型最近一次」，升级首启时用它们补一批日志行，面板不会空着
  if (!Array.isArray(state.log)) {
    state.log = Object.keys(state.models || {})
      .map((model) => {
        const e = state.models[model] || {};
        return {
          at: e.at || null,
          model,
          statusCode: e.statusCode,
          finalProvider: e.finalProvider,
          pinnedProvider: e.pinnedProvider,
          fallbackCount: e.fallbackCount,
          cacheHitTokens: e.cacheHitTokens,
          cost: e.cost,
          injected: e.injected,
          matched: e.matched,
          seeded: true,
        };
      })
      .sort((a, b) => (b.at || 0) - (a.at || 0));
    log("info", "request log seeded from summaries: " + state.log.length);
  }

  try {
    if (pi && pi.plugin && typeof pi.plugin.getSettings === "function") {
      applySettings(await pi.plugin.getSettings());
      await hydrateKey();
    }
  } catch (error) {
    log("warn", "getSettings failed: " + messageOf(error));
  }

  try {
    if (pi && pi.events && typeof pi.events.on === "function") {
      pi.events.on("plugin:settingsChanged", (next) => {
        const incoming = next && typeof next === "object" ? Object.assign({}, next) : {};
        const typedKey = typeof incoming.apiKey === "string" ? incoming.apiKey.trim() : "";
        delete incoming.apiKey; // 明文 key 单独处理，不能被空串覆盖掉内存里的值
        const before = settings.enabledModels;
        applySettings(incoming);
        if (typedKey && typedKey !== settings.apiKey) {
          settings.apiKey = typedKey;
          void persistSealedKey();
        }
        log("info", "settings updated from host");
        // 勾选的模型变了就改写声明（防抖，避免连续点击反复热重载）
        if (settings.enabledModels !== before) {
          if (declarationTimer) clearTimeout(declarationTimer);
          declarationTimer = setTimeout(() => {
            declarationTimer = null;
            if (!state.availableModels || state.availableModels.length === 0) return;
            publishModels(filterIds(state.availableModels));
          }, 1500);
        }
      });
    }
  } catch (error) {
    log("warn", "settings subscription failed: " + messageOf(error));
  }

  try {
    if (pi && pi.commands && typeof pi.commands.register === "function") {
      await pi.commands.register({
        id: "cline-upstream.open",
        title: "Cline Upstream: 打开面板",
        run: async () => {
          await pi.ui.openPanel();
        },
      });
      await pi.commands.register({
        id: "cline-upstream.clear",
        title: "Cline Upstream: 清空检测记录",
        run: async () => {
          state.models = {};
          state.lastError = null;
          state.updatedAt = Date.now();
          saveState();
          await toast("已清空上游检测记录");
        },
      });
    }
  } catch (error) {
    log("warn", "command registration failed: " + messageOf(error));
  }

  try {
    if (pi && pi.services && typeof pi.services.register === "function") {
      pi.services.register({ id: SERVICE_ID, start: startServer, stop: stopServer });
    } else {
      await startServer();
    }
  } catch (error) {
    log("error", "service registration failed: " + messageOf(error));
  }

  // 载入即拉一次目录：面板的模型勾选区不用等「获取列表」
  setTimeout(() => {
    fetchCatalog((ids) => log("info", "catalog ready: " + ids.length + " models"));
  }, 1200);
}

async function onUnload() {
  try {
    if (pi && pi.commands && typeof pi.commands.unregister === "function") {
      await pi.commands.unregister("cline-upstream.open");
      await pi.commands.unregister("cline-upstream.clear");
    }
  } catch {
    /* best effort */
  }
  await stopServer();
}

/**
 * 面板的 invoke 不是全部直达宿主：app 会把非固定通道转到插件的
 * `onPanelInvoke`（见 plugin host 的 panel.invoke 分派）。写操作在这里承接。
 */
async function onPanelInvoke(channel, payload) {
  const name = String(channel || "");
  if (name === "writeSettings") {
    applySettings(payload || {});
    if (String(settings.apiKey || "").trim()) await persistSealedKey();
    const safe = Object.assign({}, settings, { apiKey: "" });
    if (pi && pi.plugin && typeof pi.plugin.setSettings === "function") {
      await pi.plugin.setSettings(safe);
    }
    return { ok: true, settings: safe };
  }
  if (name === "applyModels") {
    return new Promise((resolve) => {
      fetchCatalog((ids) => {
        const exposed = filterIds(ids);
        publishModels(exposed);
        resolve({ ok: true, applied: exposed.length, available: ids.length });
      });
    });
  }
  if (name === "readState") {
    return {
      ok: true,
      settings,
      available: state.availableModels || [],
    };
  }
  throw new Error("unknown panel channel: " + name);
}

module.exports = { onLoad, onUnload, onPanelInvoke };
