#!/usr/bin/env node
/*
 * Local server for the UN Sanctions Evasion site + closed-circuit RAG chat.
 * No npm dependencies. Requires Node 18+.
 *
 *   node server/server.js
 *
 * Answer modes (LLM_PROVIDER, or auto-detected):
 *   none       retrieval-only: quotes passages from the database (default, needs no key)
 *   anthropic  Claude writes the answer from the retrieved passages only (needs ANTHROPIC_API_KEY)
 *   ollama     a local model via Ollama writes the answer; nothing leaves your machine
 *
 * In every mode the model is shown ONLY the retrieved passages, has no tools and no web access,
 * and if retrieval finds nothing relevant the model is not called at all.
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const RAG = require("../js/rag.js");

const ROOT = path.resolve(__dirname, "..");

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  fs.readFileSync(file, "utf8").split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  });
}
loadEnv(path.join(ROOT, ".env"));

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || ""; // set only if the site is hosted on another origin
const PROVIDER = (process.env.LLM_PROVIDER || (process.env.ANTHROPIC_API_KEY ? "anthropic" : "none")).toLowerCase();
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
const ANTHROPIC_URL = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com") + "/v1/messages";
const OLLAMA_URL = (process.env.OLLAMA_URL || "http://127.0.0.1:11434") + "/api/chat";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.1:8b";
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_MIN) || 20;

// ---- knowledge base (reloads automatically when the JSON file changes) ----
const KB_PATH = path.join(ROOT, "data", "knowledge-base.json");
let INDEX = null;
function loadKB() {
  try {
    const kb = JSON.parse(fs.readFileSync(KB_PATH, "utf8"));
    INDEX = RAG.createIndex(kb);
    console.log(`Knowledge base loaded: ${INDEX.size} passages`);
  } catch (e) {
    console.error("Could not load knowledge base:", e.message);
  }
}
loadKB();
fs.watchFile(KB_PATH, { interval: 1000 }, loadKB);

// ---- LLM providers ----
async function callAnthropic(system, user) {
  const r = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 700,
      system,
      messages: [{ role: "user", content: user }],
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error("Anthropic API returned " + r.status);
  const j = await r.json();
  return (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
}

async function callOllama(system, user) {
  const r = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      options: { temperature: 0 },
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
    signal: AbortSignal.timeout(90000),
  });
  if (!r.ok) throw new Error("Ollama returned " + r.status);
  const j = await r.json();
  return (j.message && j.message.content) || "";
}

async function answer(question, previous) {
  if (!INDEX) return { answer: "The knowledge base is not loaded.", sources: [], grounded: false, mode: "error" };

  const talk = RAG.smallTalk(question);
  if (talk) return { answer: talk, sources: [], grounded: false, mode: PROVIDER };

  const res = INDEX.search(RAG.retrievalQuery(question, previous), { k: 4 });
  // Gate: nothing relevant retrieved -> the model is never called.
  if (!res.passed) return { answer: RAG.NOT_COVERED, sources: [], grounded: false, mode: PROVIDER };

  if (PROVIDER === "anthropic" || PROVIDER === "ollama") {
    try {
      const { system, user } = RAG.buildPrompt(INDEX, question, res.hits);
      const raw = PROVIDER === "anthropic" ? await callAnthropic(system, user) : await callOllama(system, user);
      const out = RAG.finalizeLLMAnswer(INDEX, raw, res.hits);
      out.mode = PROVIDER === "anthropic" ? "claude" : "ollama";
      return out;
    } catch (e) {
      console.error("LLM call failed, falling back to retrieval-only:", e.message);
      const out = RAG.respondExtractive(INDEX, question, previous);
      out.mode = "retrieval-only (model unavailable)";
      return out;
    }
  }
  return RAG.respondExtractive(INDEX, question, previous);
}

// ---- tiny in-memory rate limiter ----
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > RATE_LIMIT;
}

// ---- static files (allow-listed folders only) ----
const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon",
};
const PUBLIC_DIRS = new Set(["css", "js", "images", "data"]);

function serveStatic(req, res) {
  let rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (rel === "/") rel = "/index.html";
  const full = path.normalize(path.join(ROOT, rel));
  if (!full.startsWith(ROOT + path.sep)) return send(res, 403, "Forbidden");
  const parts = path.relative(ROOT, full).split(path.sep);
  const ok = parts.length === 1 ? /\.html$/.test(parts[0]) : PUBLIC_DIRS.has(parts[0]);
  if (!ok || parts.some((p) => p.startsWith("."))) return send(res, 404, "Not found");
  fs.readFile(full, (err, buf) => {
    if (err) return send(res, 404, "Not found");
    res.writeHead(200, { "content-type": MIME[path.extname(full)] || "application/octet-stream" });
    res.end(buf);
  });
}

function send(res, code, body, type) {
  res.writeHead(code, { "content-type": type || "text/plain; charset=utf-8" });
  res.end(body);
}
function sendJSON(res, code, obj) {
  const headers = { "content-type": "application/json; charset=utf-8" };
  if (ALLOWED_ORIGIN) headers["access-control-allow-origin"] = ALLOWED_ORIGIN;
  res.writeHead(code, headers);
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");

  if (ALLOWED_ORIGIN && req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": ALLOWED_ORIGIN,
      "access-control-allow-methods": "POST, GET, OPTIONS",
      "access-control-allow-headers": "content-type",
    });
    return res.end();
  }

  if (url.pathname === "/api/health") {
    return sendJSON(res, 200, { ok: !!INDEX, provider: PROVIDER, passages: INDEX ? INDEX.size : 0 });
  }

  if (url.pathname === "/api/chat") {
    if (req.method !== "POST") return sendJSON(res, 405, { error: "POST only" });
    const ip = req.socket.remoteAddress || "?";
    if (limited(ip)) return sendJSON(res, 429, { error: "Too many questions - please wait a minute." });
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 4096) req.destroy();
    });
    req.on("end", async () => {
      let data;
      try { data = JSON.parse(body); } catch { return sendJSON(res, 400, { error: "Invalid JSON" }); }
      const q = typeof data.question === "string" ? data.question.trim().slice(0, 500) : "";
      const prev = typeof data.previous === "string" ? data.previous.trim().slice(0, 500) : "";
      if (!q) return sendJSON(res, 400, { error: "Empty question" });
      try {
        sendJSON(res, 200, await answer(q, prev));
      } catch (e) {
        console.error(e);
        sendJSON(res, 500, { error: "Server error" });
      }
    });
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");
  serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`\nUN Sanctions Evasion site: http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  console.log(`Chat mode: ${PROVIDER}` + (PROVIDER === "anthropic" ? ` (${ANTHROPIC_MODEL})` : PROVIDER === "ollama" ? ` (${OLLAMA_MODEL})` : " (retrieval-only, no API key needed)"));
  if (PROVIDER === "anthropic" && !ANTHROPIC_KEY) console.warn("WARNING: LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is empty.");
});
