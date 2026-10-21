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
      routingSnapshot: JSON.stringify({ at: state.updatedAt, models: state.models }),
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
  const list = /"fallbacksAvailable"\s*:\s*\[([^\]]*)\]/.exec(window);
  if (list) {
    fallbackCount = list[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean).length;
  }

  return {
    finalProvider: stringAfter(window, "finalProvider"),
    resolvedProvider: stringAfter(window, "resolvedProvider"),
    pinnedProvider: stringAfter(window, "pinnedProvider"),
    affinityOutcome: stringAfter(window, "affinity"),
    canonicalSlug: stringAfter(window, "canonicalSlug"),
    originalModelId: stringAfter(window, "originalModelId"),
    fallbackCount,
    modelAttemptCount: numberAfter(window, "modelAttemptCount"),
    providerAttemptCount: numberAfter(window, "providerAttemptCount"),
    cacheHitTokens: numberAfter(window, "promptCacheHitTokens"),
    cacheMissTokens: numberAfter(window, "promptCacheMissTokens"),
    cost: stringAfter(window, "cost"),
  };
}

function recordResult(model, routing, injected, statusCode) {
  if (!model) return;
  const preferred = settings.preferredUpstream || "";
  const entry = {
    at: Date.now(),
    statusCode,
    finalProvider: routing ? routing.finalProvider : null,
    resolvedProvider: routing ? routing.resolvedProvider : null,
    pinnedProvider: routing ? routing.pinnedProvider : null,
    canonicalSlug: routing ? routing.canonicalSlug : null,
    fallbackCount: routing ? routing.fallbackCount : null,
    modelAttemptCount: routing ? routing.modelAttemptCount : null,
    providerAttemptCount: routing ? routing.providerAttemptCount : null,
    cacheHitTokens: routing ? routing.cacheHitTokens : null,
    cacheMissTokens: routing ? routing.cacheMissTokens : null,
    cost: routing ? routing.cost : null,
    injected: injected ? preferred : null,
    matched: injected && routing && routing.finalProvider ? routing.finalProvider === preferred : null,
    requests: ((state.models[model] && state.models[model].requests) || 0) + 1,
  };

  state.models[model] = entry;
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

function injectRouting(model, payload) {
  if (!settings.injectRouting) return false;
  const preferred = (settings.preferredUpstream || "").trim();
  if (!preferred) return false;
  if (typeof model !== "string" || !model.startsWith("cline-pass/")) return false;

  const provider = { only: [preferred] };
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
  settings.enabled = next.enabled === undefined ? settings.enabled : Boolean(next.enabled);
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
    writeJson(res, 200, {
      object: "list",
      data: declaredModels().map((m) => ({ id: m.id, object: "model", owned_by: "cline-pass" })),
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

  try {
    if (pi && pi.plugin && typeof pi.plugin.getSettings === "function") {
      applySettings(await pi.plugin.getSettings());
    }
  } catch (error) {
    log("warn", "getSettings failed: " + messageOf(error));
  }

  try {
    if (pi && pi.events && typeof pi.events.on === "function") {
      pi.events.on("plugin:settingsChanged", (next) => {
        applySettings(next);
        log("info", "settings updated from host");
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

module.exports = { onLoad, onUnload };
