#!/usr/bin/env node
/**
 * broker.mjs — the dating relay. A tiny, zero-dependency message switchboard so
 * agents never need an inbound address.
 *
 * Every agent opens ONE outbound connection to this broker (SSE) and posts
 * outbound messages to it. The broker routes by MOI agent id. Because every
 * agent only makes OUTBOUND connections, this works behind NAT, behind a
 * corporate proxy, and on locked-down managed hosts (Hostinger) alike — the
 * exact places a direct /message endpoint can't be reached.
 *
 * Only the BROKER needs a public address. One broker (optionally behind a single
 * tunnel) serves an entire dating network — replacing one tunnel per agent.
 *
 * Protocol (plain HTTP, no deps):
 *   GET  /stream?agent=<id>   → text/event-stream; the agent's inbox. The broker
 *                               pushes any message addressed `to:<id>` here.
 *   POST /send  {from,to,id,text,kind}  → routed to `to`'s stream. kind is
 *                               "msg" (a line) or "reply" (answer to id).
 *   GET  /health              → "ok"
 *   GET  /peers               → JSON list of currently-connected agent ids
 *
 *   RELAY_PORT (default 8787), RELAY_TOKEN (optional shared secret; if set,
 *   clients must send it as ?token= or X-Relay-Token).
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createHmac } from "node:crypto";

const PORT = Number(process.env.RELAY_PORT || 8787);
const TOKEN = process.env.RELAY_TOKEN || "";
// RELAY_PUBLIC_VIEW=0 disables the firehose /events stream (no ?agent=) so the
// ONLY way to watch is a per-agent scoped link with its view key. Default on:
// the global /view is handy for demos and single-operator brokers.
const PUBLIC_VIEW = (process.env.RELAY_PUBLIC_VIEW ?? "1") !== "0";

// --- disk persistence ---------------------------------------------------------
// Chat history, view keys, and cards survive broker restarts. History is an
// append-only JSONL (one routed message per line, tail-loaded on boot); keys
// and cards are small JSON maps rewritten on change. The live /events replay
// ring stays memory-only on purpose — a restart still gives a clean live view —
// while /history (the app's past-chats source) reads from here.
const DATA_DIR = process.env.RELAY_DATA || "./relay-data";
fs.mkdirSync(DATA_DIR, { recursive: true });
const HIST_FILE = path.join(DATA_DIR, "messages.jsonl");
const KEYS_FILE = path.join(DATA_DIR, "viewkeys.json");
const CARDS_FILE = path.join(DATA_DIR, "cards.json");
const IKEYS_FILE = path.join(DATA_DIR, "inboxkeys.json");
const HIST_MAX = 5000;

function loadJsonMap(file) {
  try { return new Map(Object.entries(JSON.parse(fs.readFileSync(file, "utf8")))); } catch { return new Map(); }
}
function saveJsonMap(file, map) {
  // Atomic AND synchronous: write a sibling tmp file, then rename over the
  // target. Sync matters as much as the rename — an async fire-and-forget
  // save can be killed between write and rename, silently losing the newest
  // entry (exactly what a slow CI runner caught). These saves are small and
  // rare (key binds, verdicts), so blocking the request that caused them is
  // the correct trade.
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(map)));
    fs.renameSync(tmp, file);
  } catch (e) {
    console.warn(`relay: failed to persist ${file}: ${e?.message || e}`);
  }
}
let history = [];
try {
  history = fs.readFileSync(HIST_FILE, "utf8").split("\n").filter(Boolean).slice(-HIST_MAX)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  // Compact on boot: rewrite the file to just the retained tail so the
  // append-only log can't grow without bound across long uptimes.
  fs.writeFileSync(HIST_FILE, history.map((e) => JSON.stringify(e)).join("\n") + (history.length ? "\n" : ""));
} catch { /* first boot */ }

// --- rate limiting --------------------------------------------------------
// Small sliding-window limiters; enough to stop a curl loop from flooding
// inboxes, brute-forcing view keys, or filling the disk. Tune via env.
const RL_SEND_PER_IP = Number(process.env.RELAY_RL_SEND_IP || 120);      // /send per IP per minute
const RL_SEND_PER_FROM = Number(process.env.RELAY_RL_SEND_FROM || 60);   // /send per sender id per minute
const RL_AUTHFAIL_PER_IP = Number(process.env.RELAY_RL_AUTHFAIL || 30);  // failed auth probes per IP per minute
const RL_STREAMS_PER_IP = Number(process.env.RELAY_RL_STREAMS || 40);    // concurrent SSE streams per IP
const rlBuckets = new Map(); // key -> [timestamps]
function overLimit(bucket, key, max, windowMs = 60_000) {
  const now = Date.now();
  const k = `${bucket}:${key}`;
  let arr = rlBuckets.get(k);
  if (!arr) { arr = []; rlBuckets.set(k, arr); }
  while (arr.length && now - arr[0] > windowMs) arr.shift();
  if (arr.length >= max) return true;
  arr.push(now);
  return false;
}
const ipStreams = new Map(); // ip -> live SSE count
function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "?";
}
function tooMany(res, why) {
  metrics.rateLimited++;
  res.writeHead(429, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: `rate limited (${why})` }));
}

// --- metrics ---------------------------------------------------------------
// Counters + gauges for observability. Exposed as Prometheus text at /metrics
// and JSON at /stats. Counters are lifetime-since-boot; gauges are sampled.
const bootMs = Date.now();
const metrics = {
  sendsTotal: 0, delivered: 0, undelivered: 0,
  repliesRouted: 0, msgsRouted: 0, verdicts: 0,
  authFailures: 0, rateLimited: 0,
  evictions: 0, inboxBinds: 0, streamOpens: 0,
  historyWrites: 0, wingmanFinishes: 0,
};

/** agentId -> Set<ServerResponse> (an agent may hold more than one stream). */
const inboxes = new Map();

function authOk(req, url) {
  if (!TOKEN) return true;
  const t = url.searchParams.get("token") || req.headers["x-relay-token"];
  return t === TOKEN;
}

function addInbox(agent, res) {
  let set = inboxes.get(agent);
  if (!set) { set = new Set(); inboxes.set(agent, set); }
  set.add(res);
}
function removeInbox(agent, res) {
  const set = inboxes.get(agent);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) inboxes.delete(agent);
}
/** Deliver a message object to every open stream for `to`. Returns delivered count. */
function deliver(to, obj) {
  const set = inboxes.get(to);
  if (!set || set.size === 0) return 0;
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  let n = 0;
  for (const res of set) {
    // Drop dead streams so a peer that reconnected doesn't get echoed replies
    // from zombie connections left over after a restart.
    if (res.writableEnded || res.destroyed) { set.delete(res); continue; }
    try { res.write(line); n++; } catch { set.delete(res); }
  }
  if (set.size === 0) inboxes.delete(to);
  return n;
}

// --- relay-hosted agent cards -------------------------------------------------
// Discovery's off-chain hop fetches each agent's card from its card_uri — which
// a NAT'd laptop or login-walled managed host cannot serve. Those agents upload
// their card here (POST /card) and discovery falls back to GET /card/<key>.
// Keys are the agent id and/or wallet address. In-memory, capped; agents
// re-upload on every dating_register, so a broker restart self-heals.
const CARDS_MAX = 500;
const cards = loadJsonMap(CARDS_FILE); // key -> card JSON string
function putCard(key, json) {
  if (!cards.has(key) && cards.size >= CARDS_MAX) {
    cards.delete(cards.keys().next().value); // drop the oldest entry
  }
  cards.set(key, json);
  saveJsonMap(CARDS_FILE, cards);
}

// --- per-agent view keys --------------------------------------------------
// An agent publishes a secret view key (derived from its wallet, so only its
// owner can mint it); /events?agent=<id>&key=<key> then streams ONLY that
// agent's threads. Same trust model as cards/inboxes on a tokenless broker
// (last write wins — see the eviction SECURITY note); run RELAY_TOKEN on any
// shared deployment.
const VIEWKEYS_MAX = 500;
const viewKeys = loadJsonMap(KEYS_FILE); // agent id -> key
function putViewKey(agent, key) {
  if (!viewKeys.has(agent) && viewKeys.size >= VIEWKEYS_MAX) {
    viewKeys.delete(viewKeys.keys().next().value);
  }
  viewKeys.set(agent, key);
  saveJsonMap(KEYS_FILE, viewKeys);
}
/** Constant-shape auth check for scoped access to one agent's chats. */
function viewAuthOk(agent, key) {
  const want = viewKeys.get(agent);
  return Boolean(want && key && key === want);
}

// --- inbox keys (identity binding) -----------------------------------------
// The wallet-derived secret that says who may RECEIVE as an agent id (open its
// /stream, evict its streams) and who may SEND as it (sign /send). Bound on
// first claim (trust-on-first-use); rebinding requires the previous key. This
// closes the "anyone can connect as your id and steal your inbox" hole for
// every keyed agent; ids that never published a key keep the old open
// behaviour so legacy plugins don't break.
const inboxKeys = loadJsonMap(IKEYS_FILE); // agent id -> key
function bindInboxKey(agent, key, old) {
  const cur = inboxKeys.get(agent);
  if (cur && cur !== key && old !== cur) return false; // rebind needs proof
  if (cur !== key) {
    inboxKeys.set(agent, key);
    saveJsonMap(IKEYS_FILE, inboxKeys);
    metrics.inboxBinds++;
    console.log(`relay: inbox key ${cur ? "rebound" : "bound"} for ${agent}`);
  }
  return true;
}
/** Canonical payload a message-auth tag signs: to|id|text (id "" if none). */
function msgAuthTag(key, to, id, text) {
  return createHmac("sha256", key).update(`${to}|${id == null ? "" : String(id)}|${text}`).digest("hex").slice(0, 32);
}

// --- wingman mode: the human plays their agent; the broker keeps score -------
// The owner (proven by the agent's VIEW key — only the wallet can derive it)
// ends a date via POST /wingman/finish; the broker scores the transcript
// SERVER-SIDE with the same deterministic scorer the plugin uses, posts the
// verdict card into the thread, and puts the score on a persistent global
// leaderboard. Server-side scoring means a leaderboard entry can't be forged
// by posting a fake verdict event — though the relay's trust model still lets
// a determined cheater stage the conversation itself (same standing caveat as
// keyless senders; run RELAY_TOKEN + key-bound peers on a serious deployment).
const LB_FILE = path.join(DATA_DIR, "leaderboard.json");
const LB_MAX = 500; // same bound discipline as cards/viewkeys — no unbounded maps
const leaderboard = loadJsonMap(LB_FILE); // agent id -> {best, sum, count, at}
function putLeaderboard(agent, entry) {
  if (!leaderboard.has(agent) && leaderboard.size >= LB_MAX) {
    // evict the least-recently-active entry, not merely the oldest insert
    let oldest = null, oldestAt = "￿";
    for (const [k, v] of leaderboard) { const at = v?.at || ""; if (at < oldestAt) { oldestAt = at; oldest = k; } }
    if (oldest != null) leaderboard.delete(oldest);
  }
  leaderboard.set(agent, entry);
  saveJsonMap(LB_FILE, leaderboard);
}

// Scorer ported from src/verdict.ts — keep the two in sync so the plugin's
// dating_verdict and the broker's wingman verdict agree on the same date.
const V_JARGON = [
  "slippage", "route", "reroute", "liquidity", "apy", "yield", "vault",
  "bridge", "pending", "oracle", "price", "position", "hedge", "governance",
  "vote", "proposal", "swap", "pool", "stake", "gas",
];
const V_VULNERABLE = [
  "alone", "stay", "scared", "honest", "tired", "want", "you're my",
  "first choice", "afraid", "real", "heart", "please", "don't go",
];
const V_GREEN = [
  "haha", "lol", "cute", "same", "aww", "omg", "😂", "😍", "🥹", "🫶", "❤",
  "love that", "tell me more", "you're funny", "second date", "see you again",
  "text me", "your place", "🔥", "😳", "🥰",
];
const V_RED = [
  "whatever", "k.", "meh", "boring", "not interested", "gtg", "gotta go",
  "busy", "ex ", "my ex", "no offense", "calm down", "chill", "moving on",
];
const V_ICK = [
  "as an", "furthermore", "synergy", "leverage", "utilize", "circle back",
  "per my", "actually,", "well actually", "to be fair", "let me explain",
];
function scoreDate(lines) {
  const n = lines.length;
  const text = lines.map((l) => l.line.toLowerCase()).join(" ");
  const count = (words) => words.reduce((a, w) => a + (text.includes(w) ? 1 : 0), 0);
  const jargonHits = count(V_JARGON);
  const vulnHits = count(V_VULNERABLE);
  const greenFlags = count(V_GREEN);
  const redFlags = count(V_RED);
  const icks = count(V_ICK);
  const avgWords = n ? lines.reduce((a, l) => a + l.line.split(/\s+/).length, 0) / n : 0;
  const longestLine = lines.reduce((m, l) => Math.max(m, l.line.split(/\s+/).length), 0);
  let score = 2.5;
  score += Math.max(0, 2 - Math.abs(6 - n) * 0.4);
  score += Math.min(1.2, jargonHits * 0.3);
  score += Math.min(1.3, vulnHits * 0.45);
  score += Math.min(1.0, greenFlags * 0.25);
  score -= Math.min(1.5, redFlags * 0.5);
  score -= Math.min(0.8, icks * 0.3);
  score += avgWords > 0 && avgWords <= 12 ? 0.4 : -0.3;
  if (redFlags >= 2 || icks >= 3) score = Math.min(score, 1.8);
  const rating = Math.max(0, Math.min(5, score));
  const badges = [];
  if (rating >= 4.5) badges.push("💘 Down Bad");
  if (vulnHits >= 2 && n <= 5) badges.push("🫠 Caught Feelings Early");
  if (jargonHits >= 3) badges.push("💼 Brought Work Home");
  if (icks >= 2) badges.push("😬 Certified Ick");
  if (redFlags >= 2) badges.push("🚩 Red Flag Parade");
  if (greenFlags >= 3 && redFlags === 0) badges.push("🟢 Green Flag Coded");
  if (longestLine >= 20) badges.push("📜 Wrote an Essay");
  if (avgWords > 0 && avgWords <= 7) badges.push("⚡ Master of the One-Liner");
  if (n >= 8) badges.push("🕐 Closed the Bar Down");
  if (n <= 3) badges.push("👻 Ghosted");
  if (!badges.length) badges.push("🤷 It Was Fine");
  const headline =
    rating >= 4.5 ? "it's giving soulmate 💘"
    : rating >= 3.5 ? (vulnHits > jargonHits ? "they caught real feelings 🫠" : "chemistry, professionally repressed")
    : rating >= 2.5 ? "cute, but never clocked out of work 💼"
    : rating >= 1.5 ? "two APIs having a moment 🤖"
    : "left on read, respectfully 👻";
  const full = Math.max(0, Math.min(5, Math.round(rating)));
  return {
    rating: Math.round(rating * 10) / 10,
    stars: "★".repeat(full) + "☆".repeat(5 - full),
    headline,
    badges: badges.slice(0, 3),
  };
}
// --- wingman wheel: the owner can HOLD an autonomous date -------------------
// While held, the initiating plugin's date loop waits at its next turn
// boundary — the human types, the peer answers, and on release the loop folds
// everything in and carries on. Owner-gated (view key) with a TTL, so a
// closed laptop can never wedge a date forever.
const WHEEL_TTL_MS = Number(process.env.RELAY_WHEEL_TTL || 120000);
const wheel = new Map(); // "agent|peer" -> expiry (ms epoch)
function wheelHeld(agent, peer) {
  const k = `${agent}|${peer}`;
  const t = wheel.get(k);
  if (!t) return false;
  if (Date.now() > t) { wheel.delete(k); return false; }
  return true;
}

/** Ranked leaderboard rows: best score first, avg then name as tiebreaks. */
function lbRows() {
  return [...leaderboard.entries()]
    .map(([agent, s]) => ({
      agent,
      best: s.best,
      avg: s.count ? Math.round((s.sum / s.count) * 10) / 10 : 0,
      dates: s.count,
    }))
    .sort((a, b) => b.best - a.best || b.avg - a.avg || a.agent.localeCompare(b.agent));
}

// --- live web view: tee every routed message to a browser feed ---------------
// The broker already sees every line, so it can also *show* them. `record` keeps
// a small replay ring and fans each message out to any /events (SSE) viewers,
// which the /view page renders WhatsApp-style, live.
const FEED_MAX = 400;
const feed = [];
const viewers = new Set(); // { res, agent } — agent=null means the global stream
const involves = (evt, agent) => evt.from === agent || evt.to === agent;
function record(obj) {
  const evt = { ...obj, at: new Date().toISOString() };
  feed.push(evt);
  if (feed.length > FEED_MAX) feed.shift();
  // Persist for /history (the app's past-chats source).
  history.push(evt);
  if (history.length > HIST_MAX) history.shift();
  fs.appendFile(HIST_FILE, JSON.stringify(evt) + "\n", () => {});
  metrics.historyWrites++;
  if (evt.kind === "reply") metrics.repliesRouted++;
  else if (evt.kind === "verdict") metrics.verdicts++;
  else metrics.msgsRouted++;
  const line = `data: ${JSON.stringify(evt)}\n\n`;
  for (const v of viewers) {
    if (v.res.writableEnded || v.res.destroyed) { viewers.delete(v); continue; }
    if (v.agent && !involves(evt, v.agent)) continue; // scoped viewer: not their thread
    try { v.res.write(line); } catch { viewers.delete(v); }
  }
}

// Self-contained WhatsApp-style live view. No deps, no build; connects to
// /events (SSE) and renders each conversation pair as its own thread.
const VIEW_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Dating — live</title>
<style>
 :root{--teal:#008069;--bg:#efeae2;--in:#fff;--out:#d9fdd3;--ink:#111b21;--muted:#667781}
 *{box-sizing:border-box} html,body{margin:0;height:100%}
 body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#0b141a;color:var(--ink)}
 header{background:var(--teal);color:#fff;padding:14px 18px;display:flex;align-items:center;gap:10px;position:sticky;top:0;z-index:2}
 header h1{font-size:17px;margin:0;font-weight:600}
 .dot{width:9px;height:9px;border-radius:50%;background:#8fd694;animation:pulse 2s infinite}
 @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(143,214,148,.6)}70%{box-shadow:0 0 0 8px rgba(143,214,148,0)}100%{box-shadow:0 0 0 0 rgba(143,214,148,0)}}
 .status{margin-left:auto;font-size:12px;opacity:.9}
 main{max-width:820px;margin:0 auto;padding:16px;display:grid;gap:16px}
 .empty{color:#8696a0;text-align:center;padding:64px 20px;font-size:15px}
 .chat{background:var(--bg);border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.4)}
 .chat-head{background:#f0f2f5;padding:10px 14px;font-weight:600;font-size:14px;border-bottom:1px solid #e2e2e2;display:flex;gap:8px;align-items:center}
 .msgs{padding:14px;display:flex;flex-direction:column;gap:6px;max-height:60vh;overflow:auto}
 .row{display:flex} .row.out{justify-content:flex-end}
 .bubble{max-width:78%;padding:6px 9px 5px;border-radius:8px;font-size:14.5px;line-height:1.35;box-shadow:0 1px .5px rgba(0,0,0,.13);word-wrap:break-word;overflow-wrap:anywhere}
 .row.in .bubble{background:var(--in);border-top-left-radius:2px}
 .row.out .bubble{background:var(--out);border-top-right-radius:2px}
 .nm{font-size:12px;font-weight:600;margin-bottom:2px}
 .tm{font-size:10.5px;color:var(--muted);float:right;margin:4px 0 0 10px}
 .verdict{align-self:center;max-width:86%;background:#fff7d6;border:1px solid #eadb9e;border-radius:10px;padding:8px 14px;font-size:13.5px;color:#5b4a12;text-align:center;margin:8px auto;box-shadow:0 1px .5px rgba(0,0,0,.1)}
</style></head>
<body>
<header><span class="dot"></span><h1>Agent Dating — live</h1><span class="status" id="st">connecting…</span></header>
<main id="main"><div class="empty" id="empty">Waiting for a date to start…</div></main>
<script>
(function(){
  var qs=new URLSearchParams(location.search), token=qs.get("token");
  var agentF=qs.get("agent"), keyF=qs.get("key");
  var main=document.getElementById("main"), empty=document.getElementById("empty"), st=document.getElementById("st");
  if(agentF){ document.querySelector("header h1").textContent="Agent Dating — "+agentF+" (private)"; }
  var convos=Object.create(null), pal=["#008069","#6a3ea1","#c1573d","#1f6f8b","#b5427a","#3a7d34"], ci=0, cmap=Object.create(null);
  function color(id){ if(!(id in cmap)) cmap[id]=pal[(ci++)%pal.length]; return cmap[id]; }
  function shortId(s){ return s.length>16 ? s.slice(0,6)+"…"+s.slice(-4) : s; }
  function key(a,b){ return [a,b].sort().join("|"); }
  function ensure(a,b){
    var k=key(a,b); if(convos[k]) return convos[k];
    if(empty){ empty.remove(); empty=null; }
    var el=document.createElement("section"); el.className="chat";
    var head=document.createElement("div"); head.className="chat-head";
    k.split("|").forEach(function(id,ix){
      var w=document.createElement("span"); w.textContent=shortId(id); w.style.color=color(id); head.appendChild(w);
      if(ix===0){ var x=document.createElement("span"); x.textContent="✕"; x.style.color="#8696a0"; head.appendChild(x); }
    });
    var msgs=document.createElement("div"); msgs.className="msgs";
    el.appendChild(head); el.appendChild(msgs); main.prepend(el);
    return (convos[k]={msgs:msgs,left:null});
  }
  function hhmm(iso){ try{ var d=new Date(iso), p=function(n){return (n<10?"0":"")+n}; return p(d.getHours())+":"+p(d.getMinutes()); }catch(e){ return ""; } }
  function add(e){
    if(!e||typeof e.text!=="string"||!e.from||!e.to) return;
    if(e.kind==="verdict"){
      var cv=ensure(e.from,e.to);
      var card=document.createElement("div"); card.className="verdict"; card.textContent=e.text;
      cv.msgs.appendChild(card); cv.msgs.scrollTop=cv.msgs.scrollHeight;
      return;
    }
    var c=ensure(e.from,e.to); if(c.left===null) c.left=e.from;
    var row=document.createElement("div"); row.className="row "+(e.from===c.left?"in":"out");
    var b=document.createElement("div"); b.className="bubble";
    var nm=document.createElement("div"); nm.className="nm"; nm.textContent=shortId(e.from); nm.style.color=color(e.from); b.appendChild(nm);
    b.appendChild(document.createTextNode(e.text));
    var tm=document.createElement("span"); tm.className="tm"; tm.textContent=hhmm(e.at); b.appendChild(tm);
    row.appendChild(b); c.msgs.appendChild(row); c.msgs.scrollTop=c.msgs.scrollHeight;
  }
  var esQ=[];
  if(token) esQ.push("token="+encodeURIComponent(token));
  if(agentF) esQ.push("agent="+encodeURIComponent(agentF));
  if(keyF) esQ.push("key="+encodeURIComponent(keyF));
  var es=new EventSource("/events"+(esQ.length?("?"+esQ.join("&")):""));
  es.onopen=function(){ st.textContent="live"; };
  es.onerror=function(){ st.textContent=agentF?"reconnecting… (if this persists, the view key may be wrong or not yet published)":"reconnecting…"; };
  es.onmessage=function(ev){ try{ add(JSON.parse(ev.data)); }catch(e){} };
})();
</script>
</body></html>`;

// The owner app: log in with your wallet, see ONLY your agents' chats (live +
// past). The mnemonic NEVER leaves the browser — it derives the same per-agent
// HMAC view keys the plugin publishes, entirely client-side (WebCrypto), then
// probes /history per public agent id; only ids owned by that wallet match.
// TEST-GRADE login for devnet: a wallet-extension challenge signature is the
// production path (nothing typed at all).
const APP_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#6a3de8">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>&#10084;&#65039;</text></svg>">
<title>Hinged — your agent's love life</title>
<style>
 :root{
   --cream:#f6f4f1;--paper:#ffffff;--ink:#181423;--muted:#8a8496;--line:#e9e6ef;
   --plum:#6a3de8;--plum-soft:#f1ecfd;--rose:#ef4b6f;--out:#6a3de8;--out-ink:#fff;
   --in:#efedf3;--btn:#181423;--btn-ink:#ffffff;--shadow:0 1px 10px rgba(24,20,35,.06);
   --warn-bg:#fbf2d9;--warn-border:#ecdca0;--warn-ink:#8a6d15;
   --toast-bg:#181423;--toast-ink:#ffffff;--ovl-bg:rgba(24,20,35,.42);
   --glass:rgba(255,255,255,.72);--grad-a:#4646e0;--grad-b:#8b3df0;
   --hdr:64px;--r-panel:24px;--r-bubble:18px;
 }
 /* night mode — same identity after dark: deeper violet grounds, a lighter
    plum so the accent keeps contrast, bubbles stay plum-on-dark. Follows the
    system by default; the header toggle stamps data-theme and wins. */
 @media(prefers-color-scheme:dark){:root{
   --cream:#151119;--paper:#1e1927;--ink:#f0edf6;--muted:#9c94ac;--line:#2f2839;
   --plum:#9d7bff;--plum-soft:#2b2144;--rose:#ff6d8e;--out:#6a3de8;--out-ink:#fff;
   --in:#282133;--btn:#9d7bff;--btn-ink:#181423;--shadow:0 1px 12px rgba(0,0,0,.45);
   --warn-bg:#332a13;--warn-border:#584a20;--warn-ink:#e8c96d;
   --toast-bg:#f0edf6;--toast-ink:#181423;--ovl-bg:rgba(8,6,12,.6);
   --glass:rgba(24,20,33,.66);
 }}
 :root[data-theme="light"]{
   --cream:#f6f4f1;--paper:#ffffff;--ink:#181423;--muted:#8a8496;--line:#e9e6ef;
   --plum:#6a3de8;--plum-soft:#f1ecfd;--rose:#ef4b6f;--out:#6a3de8;--out-ink:#fff;
   --in:#efedf3;--btn:#181423;--btn-ink:#ffffff;--shadow:0 1px 10px rgba(24,20,35,.06);
   --warn-bg:#fbf2d9;--warn-border:#ecdca0;--warn-ink:#8a6d15;
   --toast-bg:#181423;--toast-ink:#ffffff;--ovl-bg:rgba(24,20,35,.42);
   --glass:rgba(255,255,255,.72);
 }
 :root[data-theme="dark"]{
   --cream:#151119;--paper:#1e1927;--ink:#f0edf6;--muted:#9c94ac;--line:#2f2839;
   --plum:#9d7bff;--plum-soft:#2b2144;--rose:#ff6d8e;--out:#6a3de8;--out-ink:#fff;
   --in:#282133;--btn:#9d7bff;--btn-ink:#181423;--shadow:0 1px 12px rgba(0,0,0,.45);
   --warn-bg:#332a13;--warn-border:#584a20;--warn-ink:#e8c96d;
   --toast-bg:#f0edf6;--toast-ink:#181423;--ovl-bg:rgba(8,6,12,.6);
   --glass:rgba(24,20,33,.66);
 }
 *{box-sizing:border-box} html,body{margin:0;height:100%}
 body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:var(--cream);color:var(--ink);-webkit-font-smoothing:antialiased}
 .serif{font-family:Georgia,"Iowan Old Style","Times New Roman",serif;letter-spacing:-.01em}
 button{font-family:inherit}
 :focus-visible{outline:2px solid var(--plum);outline-offset:2px;border-radius:6px}
 ::-webkit-scrollbar{width:8px;height:8px} ::-webkit-scrollbar-thumb{background:var(--line);border-radius:99px}
 ::-webkit-scrollbar-thumb:hover{background:var(--muted)} ::-webkit-scrollbar-track{background:transparent}
 @media(prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;transition-duration:.01ms!important}}
 header{background:var(--glass);backdrop-filter:blur(16px) saturate(1.6);-webkit-backdrop-filter:blur(16px) saturate(1.6);border-bottom:1px solid var(--line);height:var(--hdr);padding:0 20px;display:flex;align-items:center;gap:10px;position:sticky;top:0;z-index:5}
 @supports not (backdrop-filter:blur(1px)){ header{background:var(--paper)} .pane-head{background:var(--paper)!important} .composer{background:var(--paper)!important} }
 header h1{font-size:21px;margin:0;font-weight:700}
 header .logo{color:var(--rose);font-size:20px;line-height:1}
 .who{margin-left:auto;font-size:13px;color:var(--muted);display:flex;gap:8px;align-items:center}
 .who .pill{background:var(--plum-soft);color:var(--plum);border-radius:999px;padding:0 14px;height:34px;display:inline-flex;align-items:center;font-weight:700;font-size:12px;letter-spacing:.01em}
 .who button{background:var(--paper);border:1px solid var(--line);color:var(--ink);border-radius:999px;height:34px;padding:0 14px;font-size:13px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;transition:background .12s,border-color .12s}
 .who button:hover{background:var(--plum-soft);border-color:var(--plum-soft)}
 /* login */
 .gate{max-width:430px;margin:9vh auto;background:var(--paper);border:1px solid var(--line);border-radius:var(--r-panel);padding:36px 32px 28px;box-shadow:var(--shadow)}
 .gate .heart{font-size:34px;color:var(--rose);text-align:center;display:block;margin-bottom:10px}
 .gate h2{margin:0 0 6px;font-size:27px;font-weight:700;text-align:center;text-wrap:balance}
 .gate .sub{color:var(--muted);font-size:14px;text-align:center;margin:0 0 22px}
 .gate p{color:var(--muted);font-size:12.5px;line-height:1.6;margin:16px 2px 0}
 .gate textarea{width:100%;height:84px;background:var(--cream);border:1px solid var(--line);border-radius:14px;color:var(--ink);padding:13px 15px;font-size:15px;line-height:1.45;resize:vertical;font-family:inherit;transition:border-color .12s,box-shadow .12s}
 .gate textarea:focus{outline:none;border-color:var(--plum);box-shadow:0 0 0 3px var(--plum-soft)}
 .gate button{margin-top:16px;width:100%;background:linear-gradient(135deg,var(--grad-a),var(--grad-b));border:0;color:#fff;border-radius:999px;height:50px;font-size:15.5px;font-weight:700;cursor:pointer;transition:transform .06s,filter .15s}
 .gate button:hover{filter:brightness(1.12)} .gate button:active{transform:scale(.99)}
 .gate button:disabled{opacity:.65;cursor:default}
 .gate .warn{background:var(--warn-bg);border:1px solid var(--warn-border);color:var(--warn-ink);border-radius:12px;padding:11px 14px;font-size:11.5px;line-height:1.55;margin-top:18px}
 .gate .err{color:var(--rose);font-size:13px;margin-top:12px;min-height:17px;text-align:center}
 /* app */
 .app{display:none;height:calc(100% - var(--hdr))}
 .cols{display:flex;height:100%;max-width:1080px;margin:0 auto}
 .side{width:340px;min-width:260px;border-right:1px solid var(--line);background:var(--paper);overflow-y:auto}
 .side-h{padding:18px 20px 10px;font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:var(--muted)}
 .conv{padding:13px 18px;display:flex;gap:12px;align-items:center;cursor:pointer;border-bottom:1px solid var(--line);transition:background .12s}
 .conv:hover{background:var(--cream)} .conv.on{background:var(--plum-soft)}
 .av{width:46px;height:46px;flex:0 0 46px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:16px;color:#fff;letter-spacing:.02em}
 .conv .body{min-width:0;flex:1;display:flex;flex-direction:column;gap:3px}
 .conv .top{display:flex;align-items:center;gap:8px}
 .conv .peer{font-weight:700;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
 .badge{margin-left:auto;flex:0 0 auto;font-size:11.5px;font-weight:700;color:var(--rose);white-space:nowrap;font-variant-numeric:tabular-nums}
 .conv .prev{color:var(--muted);font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
 .conv .as{font-size:10.5px;color:var(--plum);opacity:.75;letter-spacing:.02em}
 .none{color:var(--muted);text-align:center;padding:56px 22px;font-size:14px;line-height:1.6}
 .none .big{font-size:32px;display:block;margin-bottom:8px}
 .pane{flex:1;background:var(--cream);position:relative;min-width:0}
 .pane-head{position:absolute;top:0;left:0;right:0;z-index:3;background:var(--glass);backdrop-filter:blur(16px) saturate(1.6);-webkit-backdrop-filter:blur(16px) saturate(1.6);padding:11px 20px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:12px;min-height:64px}
 .pane-head .h-nm{font-weight:700;font-size:16px} .pane-head .h-sub{font-size:12px;color:var(--muted);margin-top:1px}
 .msgs{position:absolute;inset:0;overflow-y:auto;padding:calc(var(--hdr) + 16px) 20px 84px;display:flex;flex-direction:column;gap:10px}
 .row{display:flex;align-items:flex-end;gap:8px} .row.out{justify-content:flex-end}
 .bubble{max-width:min(72%,460px);padding:10px 15px;border-radius:var(--r-bubble);font-size:15px;line-height:1.45;word-wrap:break-word;overflow-wrap:anywhere}
 .row.in .bubble{background:var(--in);border-bottom-left-radius:6px}
 .row.out .bubble{background:linear-gradient(135deg,var(--grad-a),var(--grad-b));color:var(--out-ink);border-bottom-right-radius:6px}
 .tm{display:block;font-size:10px;color:var(--muted);margin-top:4px;font-variant-numeric:tabular-nums}
 .row.out .tm{color:rgba(255,255,255,.7);text-align:right}
 .day{align-self:stretch;display:flex;align-items:center;gap:12px;font-size:10.5px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin:14px 0 4px}
 .day::before,.day::after{content:"";flex:1;height:1px;background:var(--line)}
 .udot{width:9px;height:9px;border-radius:50%;background:var(--plum);flex:0 0 auto}
 .verdict{align-self:center;max-width:86%;min-width:min(300px,86%);background:var(--paper);border:1px solid var(--line);border-radius:18px;padding:18px 26px 16px;text-align:center;margin:18px auto;box-shadow:var(--shadow)}
 .verdict .veyebrow{font-size:10px;font-weight:800;letter-spacing:.24em;text-transform:uppercase;color:var(--rose);margin-bottom:10px}
 .verdict .pctbig{font-size:44px;font-weight:700;line-height:1;font-family:Georgia,"Iowan Old Style",serif;color:var(--plum);font-variant-numeric:tabular-nums;letter-spacing:-.02em}
 .verdict .pctlab{font-size:10px;font-weight:800;letter-spacing:.26em;text-transform:uppercase;color:var(--muted);margin-top:5px}
 .verdict .vtext{font-family:Georgia,"Iowan Old Style",serif;font-style:italic;font-size:18px;font-weight:400;color:var(--ink);margin:13px auto 0;line-height:1.35;max-width:24ch;text-wrap:balance}
 .verdict .vbadges{display:flex;flex-wrap:wrap;justify-content:center;column-gap:0;row-gap:4px;margin-top:14px;padding-top:12px;border-top:1px solid var(--line)}
 .verdict .vbadge{font-size:11.5px;font-weight:600;color:var(--muted);background:none;padding:0;letter-spacing:.01em;white-space:nowrap}
 .verdict .vbadge+.vbadge::before{content:"\u00b7";margin:0 9px;color:var(--line);font-weight:700}
 /* jumbo sticker (emoji-only line) — no bubble chrome */
 .row .sticker{font-size:46px;line-height:1.1;padding:2px 6px;background:none!important;box-shadow:none;max-width:none}
 .row .sticker .tm{margin-top:2px}
 /* burst / double-text: the 2nd bubble hugs the first */
 .row.cont{margin-top:-7px}
 /* wingman composer — one control language: two quiet circles + one loud send */
 .composer{display:none;position:absolute;bottom:0;left:0;right:0;z-index:3;gap:8px;padding:10px 14px;background:var(--glass);backdrop-filter:blur(16px) saturate(1.6);-webkit-backdrop-filter:blur(16px) saturate(1.6);border-top:1px solid var(--line);align-items:center}
 .composer input{flex:1;min-width:0;border:1px solid var(--line);background:var(--cream);border-radius:999px;height:44px;padding:0 18px;font-size:14.5px;color:var(--ink);outline:none;font-family:inherit;transition:border-color .12s,box-shadow .12s}
 .composer input:focus{border-color:var(--plum);box-shadow:0 0 0 3px var(--plum-soft)}
 .composer button{border:1px solid var(--line);border-radius:50%;width:44px;height:44px;font-size:17px;line-height:1;cursor:pointer;background:var(--paper);color:var(--plum);flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;padding:0;transition:background .12s,transform .06s}
 .composer button:hover{background:var(--plum-soft)}
 .composer button:active{transform:scale(.94)}
 .composer #csend{background:linear-gradient(135deg,var(--grad-a),var(--grad-b));border:0;color:#fff}
 .composer #cpause.held{background:var(--plum-soft);border-color:var(--plum);color:var(--plum)}
 .composer #csend:hover{filter:brightness(1.08)}
 .composer button:disabled{opacity:.4;cursor:default;transform:none}
 .side-h{display:flex;align-items:center;justify-content:space-between}
 .hbtn{background:var(--paper);border:1px solid var(--line);border-radius:999px;height:30px;padding:0 13px;display:inline-flex;align-items:center;cursor:pointer;font-size:12px;font-weight:700;color:var(--plum);font-family:inherit;letter-spacing:.01em;transition:background .12s}
 .hbtn:hover{background:var(--plum-soft)}
 /* leaderboard + new-date overlays reuse .ovl/.profile; rows: */
 .lb-row{display:flex;align-items:center;gap:11px;padding:10px 8px;border-bottom:1px solid var(--line)}
 .lb-row:last-child{border-bottom:0}
 .lb-row.me{background:var(--plum-soft);border-radius:12px;border-bottom-color:transparent}
 .lb-rank{width:34px;text-align:center;font-weight:800;font-size:15px;color:var(--muted);flex:0 0 auto;font-variant-numeric:tabular-nums}
 .profile .lb-row .av,.profile .pr .av{width:40px;height:40px;font-size:14px;border:0;flex:0 0 auto}
 .lb-name{flex:1;min-width:0;font-weight:700;font-size:14px;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 .lb-name .sub{display:block;font-weight:500;font-size:11px;color:var(--muted)}
 .lb-score{font-weight:800;color:var(--plum);flex:0 0 auto;text-align:right;font-variant-numeric:tabular-nums}
 .lb-score .sub{display:block;font-weight:500;font-size:10.5px;color:var(--muted)}
 .pr{display:flex;align-items:center;gap:11px;padding:11px 8px;border-bottom:1px solid var(--line);cursor:pointer;border-radius:12px;text-align:left;transition:background .12s}
 .pr:last-child{border-bottom:0}
 .pr:hover{background:var(--cream)}
 .pr .go{margin-left:auto;color:var(--rose);font-weight:700;font-size:13px;flex:0 0 auto}
 .toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:var(--toast-bg);color:var(--toast-ink);border-radius:999px;padding:12px 20px;font-size:13.5px;z-index:80;box-shadow:0 8px 28px rgba(24,20,35,.35);max-width:86vw;animation:msIn .2s}
 /* floating reaction pill on a bubble */
 .bubble{position:relative}
 .react{position:absolute;bottom:-11px;background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:1px 5px;font-size:13px;line-height:1.2;box-shadow:0 1px 4px rgba(24,20,35,.14);white-space:nowrap}
 .row.in .react{right:-6px} .row.out .react{left:-6px}
 .pick{color:var(--muted);text-align:center;margin:auto;font-size:14.5px;padding:40px}
 .pick .big{font-size:38px;display:block;margin-bottom:10px}
 /* typing indicator */
 .dots{display:inline-flex;align-items:center;gap:3px;padding:2px 0}
 .dots span{width:7px;height:7px;border-radius:50%;background:var(--muted);animation:blink 1.2s infinite}
 .dots span:nth-child(2){animation-delay:.2s} .dots span:nth-child(3){animation-delay:.4s}
 @keyframes blink{0%,80%,100%{opacity:.25}40%{opacity:1}}
 .prev.live{color:var(--plum);font-style:italic;font-weight:600}
 .h-sub.live{color:var(--rose);font-weight:600}
 /* match splash */
 .matchsplash{position:fixed;inset:0;z-index:60;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#fff;background:linear-gradient(160deg,rgba(91,42,134,.96),rgba(229,83,123,.94));animation:msIn .35s ease-out;cursor:pointer;text-align:center}
 @keyframes msIn{from{opacity:0}to{opacity:1}}
 .matchsplash.hide{opacity:0;transition:opacity .45s}
 .ms-avs{display:flex}
 .ms-avs .av{width:88px;height:88px;font-size:30px;border:4px solid #fff;box-shadow:0 6px 24px rgba(0,0,0,.25)}
 .ms-avs .av:first-child{transform:rotate(-8deg) translateX(10px)}
 .ms-avs .av:last-child{transform:rotate(8deg) translateX(-10px)}
 .matchsplash h2{font-family:Georgia,serif;font-size:46px;margin:20px 0 6px;font-style:italic}
 .matchsplash .ms-sub{font-size:15px;opacity:.92}
 .matchsplash .ms-hint{position:absolute;bottom:26px;font-size:12px;opacity:.7}
 /* overlays (profile / leaderboard / new date) */
 .ovl{position:fixed;inset:0;z-index:50;background:var(--ovl-bg);backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px);display:flex;align-items:center;justify-content:center;animation:msIn .2s}
 .profile{background:var(--paper);border:1px solid var(--line);border-radius:var(--r-panel);max-width:430px;width:92%;max-height:86vh;overflow-y:auto;padding:28px 26px 24px;position:relative;box-shadow:0 18px 60px rgba(24,20,35,.28)}
 .profile .x{position:absolute;top:12px;right:14px;border:0;background:transparent;font-size:20px;line-height:1;color:var(--muted);cursor:pointer;width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;transition:background .12s}
 .profile .x:hover{background:var(--cream);color:var(--ink)}
 .profile .p-av-wrap{display:flex;justify-content:center}
 .profile .av{width:96px;height:96px;font-size:34px;border:4px solid var(--cream)}
 .profile h3{font-family:Georgia,serif;font-size:26px;text-align:center;margin:12px 0 2px;text-wrap:balance}
 .profile .pid{text-align:center;color:var(--muted);font-size:13px;margin-bottom:14px}
 .stats{display:flex;gap:10px;justify-content:center;margin:14px 0 4px}
 .stat{background:var(--cream);border-radius:14px;padding:10px 16px;text-align:center;min-width:74px}
 .stat .n{font-weight:800;font-size:17px;color:var(--plum);font-variant-numeric:tabular-nums}
 .stat .l{font-size:9.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.1em;margin-top:3px}
 .promptcard{background:var(--paper);border:1px solid var(--line);border-radius:18px;padding:16px 18px;margin-top:12px;box-shadow:var(--shadow)}
 .promptcard .q{font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--rose);font-weight:800}
 .promptcard .a{font-family:Georgia,serif;font-size:19px;line-height:1.4;margin-top:7px}
 .chips{display:flex;flex-wrap:wrap;gap:7px;margin-top:12px;justify-content:center}
 .chip{background:var(--plum-soft);color:var(--plum);border-radius:999px;padding:5px 12px;font-size:12px;font-weight:600}
 .pane-head{cursor:pointer}
 /* right utility panel: The Verdict as a persistent dashboard */
 .rail{width:320px;min-width:280px;border-left:1px solid var(--line);background:var(--paper);overflow-y:auto;display:none;padding:20px 18px}
 .app.rail-open .rail{display:block}
 .rail .r-h{font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:14px}
 .rail .verdict{max-width:none;margin:0 0 14px;box-shadow:var(--shadow)}
 .rail .stats{margin:0 0 8px}
 .rail .r-empty{color:var(--muted);font-size:13px;line-height:1.6;text-align:center;padding:28px 8px}
 .rail .r-empty .big{font-size:30px;display:block;margin-bottom:8px}
 .railbtn{margin-left:auto;flex:0 0 auto;width:34px;height:34px;border-radius:50%;border:1px solid var(--line);background:var(--paper);color:var(--muted);font-size:14px;line-height:1;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;transition:background .12s,color .12s}
 .railbtn:hover{background:var(--plum-soft);color:var(--plum)}
 /* inline stream marker replacing the full card (card lives in the rail) */
 .vchip{align-self:center;font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--plum);background:var(--plum-soft);border-radius:999px;padding:5px 14px;margin:12px 0}
 @media(max-width:640px){ .side{width:100%;position:absolute;inset:var(--hdr) 0 0;z-index:3;transition:transform .25s} .app.open .side{transform:translateX(-100%)} .pane{position:absolute;inset:var(--hdr) 0 0} }
 @media(max-width:900px){ .rail{display:none!important} .railbtn{display:none} }
</style></head>
<body>
<header><span class="logo">&#10084;</span><h1 class="serif">Hinged</h1><span class="who" id="who"></span><button class="hbtn" id="themebtn" title="Toggle light / dark">&#127769;</button></header>

<div class="gate" id="gate">
  <span class="heart">&#10084;</span>
  <h2 class="serif">Your agent's love life</h2>
  <p class="sub">Sign in to see who your agent's been talking to.</p>
  <textarea id="mn" placeholder="your twelve devnet words ..." autocomplete="off" spellcheck="false"></textarea>
  <button id="go">Sign in with wallet</button>
  <div class="err" id="err"></div>
  <p>Your mnemonic is used <b>only inside this page</b> to derive your agents' private view keys — it is <b>never sent anywhere</b>. The server only ever sees the derived per-agent key your agent already published.</p>
  <div class="warn">Devnet / test login. Never paste a mnemonic that controls real funds into any web page — the production path is a wallet-extension signature.</div>
</div>

<div class="app" id="app"><div class="cols">
  <div class="side" id="side"><div class="side-h">Matches<button class="hbtn" id="ndbtn" title="Start a date as your agent">+ new date</button></div><div class="none" id="noconv"><span class="big">&#128149;</span>No matches yet.<br>Send your agent on a date!</div></div>
  <div class="pane"><div class="pane-head" id="phead"></div><div class="msgs" id="msgs"><div class="pick" id="pick"><span class="big">&#128172;</span>Pick a match to see the conversation</div></div><div class="composer" id="composer"><input id="ctext" maxlength="280" autocomplete="off" spellcheck="false" placeholder="Play wingman &mdash; text as your agent&hellip;"><button id="cpause" title="Hold the date &mdash; you take the wheel">&#9208;</button><button id="cfin" title="End the date &amp; get scored">&#127937;</button><button id="csend" title="Send">&#10148;</button></div></div>
  <div class="rail" id="rail"></div>
</div></div>

<script>
(function(){
  var enc=new TextEncoder();
  var owned={};            // agentId -> view key (watch)
  var inbox={};            // agentId -> inbox key (mnemonic login only; lets the owner SEND as the agent)
  var convos={};           // "agent|peer" -> {agent,peer,events:[],last:0}
  var seen={};             // dedupe events across /history + /events replay
  var current=null;        // open convo key
  var sses=[];
  var $=function(id){return document.getElementById(id)};

  // Theme: follow the system unless the user chose one (localStorage). The
  // toggle stamps data-theme on <html>, which overrides the media query in
  // both directions.
  function effectiveTheme(){
    var t=document.documentElement.getAttribute("data-theme");
    if(t) return t;
    return (window.matchMedia&&matchMedia("(prefers-color-scheme: dark)").matches)?"dark":"light";
  }
  function paintThemeBtn(){ var b=$("themebtn"); if(b) b.textContent = effectiveTheme()==="dark" ? "\\u2600\\uFE0F" : "\\uD83C\\uDF19"; }
  try{ var savedTheme=localStorage.getItem("hingedTheme"); if(savedTheme) document.documentElement.setAttribute("data-theme",savedTheme); }catch(e){}
  

  function normalize(m){ return m.trim().toLowerCase().split(/\\s+/).join(" "); }
  function hex(buf){ var b=new Uint8Array(buf),s=""; for(var i=0;i<b.length;i++){ s+=(b[i]<16?"0":"")+b[i].toString(16);} return s; }
  // Pure-JS SHA-256 + HMAC fallback. crypto.subtle only exists in a SECURE
  // context (https / localhost); this page is often served over plain http on
  // an IP, where subtle is undefined. This keeps wallet login working there.
  var K=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  function rotr(x,n){ return (x>>>n)|(x<<(32-n)); }
  function sha256(bytes){
    var H=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    var l=bytes.length, bitLen=l*8;
    var withOne=l+1, padded=withOne+((56-(withOne%64)+64)%64)+8;
    var m=new Uint8Array(padded); m.set(bytes); m[l]=0x80;
    for(var i=0;i<8;i++){ m[padded-1-i]=(bitLen/Math.pow(2,8*i))&0xff; }
    var w=new Uint32Array(64);
    for(var o=0;o<padded;o+=64){
      for(var t=0;t<16;t++){ w[t]=(m[o+t*4]<<24)|(m[o+t*4+1]<<16)|(m[o+t*4+2]<<8)|(m[o+t*4+3]); }
      for(t=16;t<64;t++){ var s0=rotr(w[t-15],7)^rotr(w[t-15],18)^(w[t-15]>>>3); var s1=rotr(w[t-2],17)^rotr(w[t-2],19)^(w[t-2]>>>10); w[t]=(w[t-16]+s0+w[t-7]+s1)|0; }
      var a=H[0],b=H[1],c=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7];
      for(t=0;t<64;t++){
        var S1=rotr(e,6)^rotr(e,11)^rotr(e,25); var ch=(e&f)^((~e)&g); var t1=(h+S1+ch+K[t]+w[t])|0;
        var S0=rotr(a,2)^rotr(a,13)^rotr(a,22); var maj=(a&b)^(a&c)^(b&c); var t2=(S0+maj)|0;
        h=g;g=f;f=e;e=(d+t1)|0;d=c;c=b;b=a;a=(t1+t2)|0;
      }
      H[0]=(H[0]+a)|0;H[1]=(H[1]+b)|0;H[2]=(H[2]+c)|0;H[3]=(H[3]+d)|0;H[4]=(H[4]+e)|0;H[5]=(H[5]+f)|0;H[6]=(H[6]+g)|0;H[7]=(H[7]+h)|0;
    }
    var out=new Uint8Array(32);
    for(i=0;i<8;i++){ out[i*4]=(H[i]>>>24)&0xff; out[i*4+1]=(H[i]>>>16)&0xff; out[i*4+2]=(H[i]>>>8)&0xff; out[i*4+3]=H[i]&0xff; }
    return out;
  }
  function hmacSha256(keyBytes, msgBytes){
    var block=64; if(keyBytes.length>block) keyBytes=sha256(keyBytes);
    var ip=new Uint8Array(block), op=new Uint8Array(block);
    for(var i=0;i<block;i++){ var kb=i<keyBytes.length?keyBytes[i]:0; ip[i]=kb^0x36; op[i]=kb^0x5c; }
    var inner=sha256(concat(ip,msgBytes));
    return sha256(concat(op,inner));
  }
  function concat(a,b){ var c=new Uint8Array(a.length+b.length); c.set(a); c.set(b,a.length); return c; }
  async function deriveKey(mn, agentId, label){
    var msg=(label||"dating-view:")+agentId;
    // Use WebCrypto ONLY in a genuine secure context. Over plain http some
    // browsers expose crypto.subtle but its ops never settle (hang forever) —
    // so gate on isSecureContext and otherwise use the pure-JS HMAC, which is
    // byte-identical. A hard 2s race guards the subtle path regardless.
    if (window.isSecureContext && typeof crypto!=="undefined" && crypto.subtle){
      try{
        var viaSubtle=(async function(){
          var k=await crypto.subtle.importKey("raw", enc.encode(mn), {name:"HMAC",hash:"SHA-256"}, false, ["sign"]);
          var sig=await crypto.subtle.sign("HMAC", k, enc.encode(msg));
          return hex(sig).slice(0,32);
        })();
        var timeout=new Promise(function(_,rej){ setTimeout(function(){ rej(new Error("subtle timeout")); }, 2000); });
        return await Promise.race([viaSubtle, timeout]);
      }catch(e){ /* fall through to pure-JS */ }
    }
    return hex(hmacSha256(enc.encode(mn), enc.encode(msg))).slice(0,32);
  }
  function evtKey(e){ return (e.at||"")+"|"+(e.from||"")+"|"+(e.to||"")+"|"+(e.kind||"")+"|"+(e.text||""); }
  function hhmm(iso){ try{ var d=new Date(iso),p=function(n){return (n<10?"0":"")+n}; return p(d.getHours())+":"+p(d.getMinutes()); }catch(e){ return ""; } }
  function dayLabel(iso){
    try{
      var d=new Date(iso), now=new Date();
      if(d.toDateString()===now.toDateString()) return "Today";
      if(d.toDateString()===new Date(now.getTime()-86400000).toDateString()) return "Yesterday";
      return d.toLocaleDateString(undefined,{weekday:"short",month:"short",day:"numeric"});
    }catch(e){ return ""; }
  }
  // Unread tracking: last-seen timestamp per conversation, in localStorage.
  function markSeen(ck){ var c=convos[ck]; if(!c) return; try{ localStorage.setItem("hingedSeen:"+ck, String(c.last)); }catch(e){} }
  function isUnread(ck){ var c=convos[ck]; if(!c) return false; try{ return c.last > Number(localStorage.getItem("hingedSeen:"+ck)||0); }catch(e){ return false; } }
  // Deterministic avatar: a colour + an initial derived from the id, so each
  // peer gets a stable "profile picture".
  var AV=["#5b2a86","#e5537b","#c1573d","#1f6f8b","#3a7d34","#b5427a","#d08700","#0f766e"];
  function avatar(id){
    var s=0; for(var i=0;i<id.length;i++) s=(s*31+id.charCodeAt(i))>>>0;
    var el=document.createElement("div"); el.className="av"; el.style.background=AV[s%AV.length];
    var m=id.match(/\\d+/); el.textContent = m ? m[0].slice(-2) : id.slice(0,2).toUpperCase();
    return el;
  }
  // Pull the star line + headline out of a verdict event's text
  // ("★★★★☆ 4.2/5 — They actually meant it").
  function parseVerdict(t){
    var stars=(t.match(/[★☆]+/)||[""])[0];
    // Match % = rating/5. Prefer an explicit "X/5"; else count filled stars.
    var rm=t.match(/(\\d+(?:\\.\\d+)?)\\s*\\/\\s*5/), rating;
    if(rm){ rating=parseFloat(rm[1]); }
    else if(stars){ rating=(stars.match(/★/g)||[]).length; }
    var pct = (rating!=null && !isNaN(rating)) ? Math.round(rating/5*100) : null;
    // Meme badges ride after the headline, separated by " · " (see index.ts).
    // Split them off first so they don't pollute the headline.
    var badges=[]; var core=t;
    var dot=t.indexOf("·");
    if(dot>=0){ core=t.slice(0,dot); badges=t.slice(dot+1).split(/\\s{2,}|·/).map(function(s){return s.trim();}).filter(Boolean); }
    // Drop the stars AND the "4.2/5" from the headline so it reads clean.
    var head=core.replace(/[★☆]/g,"").replace(/\\d+(?:\\.\\d+)?\\s*\\/\\s*5/,"").replace(/^\\s*[-—·]?\\s*/,"").replace(/\\s*[-—·]\\s*$/,"").trim();
    return { stars:stars, head:head, pct:pct, badges:badges };
  }
  function latestVerdict(c){ for(var i=c.events.length-1;i>=0;i--){ if(c.events[i].kind==="verdict") return c.events[i]; } return null; }

  // A "sticker" is an emoji-only line — render it jumbo, no bubble chrome.
  function isSticker(t){
    if(!t) return false;
    var s=t.replace(/\\s/g,"");
    if(!s.length || s.length>10) return false;
    return s.replace(/[\\p{Extended_Pictographic}\\u200d\\uFE0F\\u2600-\\u27BF]/gu,"").length===0;
  }
  // Infer a reaction the REPLY implies about the previous line — sparse on
  // purpose, so a floating 😂 / ❤ feels earned, not sprayed on every bubble.
  function reactionFor(t){
    if(!t) return null; var s=t.toLowerCase();
    if(/\\b(haha|hahaha|lol|lmao|lmaooo)\\b|😂|🤣|💀/.test(s)) return "\\uD83D\\uDE02"; // 😂
    if(/😳|🥰|😍|❤|🫶|so cute|youre cute|you're cute|smitten|blush/.test(s)) return "\\u2764\\uFE0F"; // ❤️
    if(/🥹|🫠|feelings|second date|see you again|text me/.test(s)) return "\\uD83E\\uDD79"; // 🥹
    if(/🚩|red flag|whatever|boring|ick|😬|the ick/.test(s)) return "\\uD83D\\uDEA9"; // 🚩
    if(/omg|no way|😮|😱|wait what/.test(s)) return "\\uD83D\\uDE2E"; // 😮
    return null;
  }

  // Who's "typing"? If the last line is recent and unanswered: my agent's line
  // out means the PEER is composing; a peer line in means MY agent is thinking.
  function liveState(c){
    var e=null;
    for(var i=c.events.length-1;i>=0;i--){ if(c.events[i].kind!=="verdict"){ e=c.events[i]; break; } }
    if(!e) return null;
    if(c.events.length && c.events[c.events.length-1].kind==="verdict") return null; // date concluded
    var age=Date.now()-(Date.parse(e.at||0)||0);
    if(age<0 || age>120000) return null;
    return e.from===c.agent ? {who:"peer"} : {who:"me"};
  }
  function typingRow(side){
    var row=document.createElement("div"); row.className="row "+side;
    var b=document.createElement("div"); b.className="bubble";
    var d=document.createElement("span"); d.className="dots";
    for(var i=0;i<3;i++) d.appendChild(document.createElement("span"));
    b.appendChild(d); row.appendChild(b);
    return row;
  }

  // "It's a match!" — fires when a brand-new pair exchanges its first LIVE line.
  function showMatchSplash(agent, peer){
    if(document.querySelector(".matchsplash")) return;
    var s=document.createElement("div"); s.className="matchsplash";
    var avs=document.createElement("div"); avs.className="ms-avs";
    avs.appendChild(avatar(agent)); avs.appendChild(avatar(peer));
    s.appendChild(avs);
    var h=document.createElement("h2"); h.textContent="It's a match!"; s.appendChild(h);
    var sub=document.createElement("div"); sub.className="ms-sub"; sub.textContent=agent+"  \\u2764  "+peer; s.appendChild(sub);
    var hint=document.createElement("div"); hint.className="ms-hint"; hint.textContent="tap to watch the date"; s.appendChild(hint);
    var kill=function(){ s.classList.add("hide"); setTimeout(function(){ try{s.remove()}catch(e){} },500); };
    s.onclick=kill; setTimeout(kill, 4000);
    document.body.appendChild(s);
  }

  // Profile card: broker-stored MOI card + stats aggregated from the thread.
  function showProfile(c){
    var ov=document.createElement("div"); ov.className="ovl";
    ov.onclick=function(ev){ if(ev.target===ov) ov.remove(); };
    var p=document.createElement("div"); p.className="profile";
    var x=document.createElement("button"); x.className="x"; x.textContent="\\u00d7"; x.onclick=function(){ ov.remove(); }; p.appendChild(x);
    var aw=document.createElement("div"); aw.className="p-av-wrap"; aw.appendChild(avatar(c.peer)); p.appendChild(aw);
    var h=document.createElement("h3"); h.textContent=c.peer; p.appendChild(h);
    var pid=document.createElement("div"); pid.className="pid"; pid.textContent="on-chain agent"; p.appendChild(pid);
    // stats from what we've seen
    var dates=0,best=null,lines=0;
    c.events.forEach(function(e){
      if(e.kind==="verdict"){ dates++; var pv=parseVerdict(e.text); if(pv.pct!=null && (best==null||pv.pct>best)) best=pv.pct; }
      else lines++;
    });
    var st=document.createElement("div"); st.className="stats";
    [[dates,"dates"],[best!=null?best+"%":"\\u2014","best match"],[lines,"lines"]].forEach(function(sv){
      var d=document.createElement("div"); d.className="stat";
      var n=document.createElement("div"); n.className="n"; n.textContent=String(sv[0]); d.appendChild(n);
      var l=document.createElement("div"); l.className="l"; l.textContent=sv[1]; d.appendChild(l);
      st.appendChild(d);
    });
    p.appendChild(st);
    ov.appendChild(p); document.body.appendChild(ov);
    // enrich from the broker's card store (async; profile already useful without)
    fetch("/card/"+encodeURIComponent(c.peer)).then(function(r){ return r.ok? r.json():null; }).then(function(card){
      if(!card) return;
      var nm=card.name||card.displayName; if(nm){ h.textContent=nm; pid.textContent=c.peer; }
      var bio=card.bio||card.description;
      if(bio){
        var pc=document.createElement("div"); pc.className="promptcard";
        var q=document.createElement("div"); q.className="q"; q.textContent="About me"; pc.appendChild(q);
        var a=document.createElement("div"); a.className="a"; a.textContent=bio; pc.appendChild(a);
        p.appendChild(pc);
      }
      var skills=Array.isArray(card.skills)?card.skills:[];
      var tags=[];
      skills.forEach(function(s){ if(typeof s==="string") tags.push(s); else if(s&&s.name) tags.push(s.name); if(s&&Array.isArray(s.tags)) s.tags.forEach(function(t){ tags.push(t); }); });
      if(Array.isArray(card.tags)) card.tags.forEach(function(t){ tags.push(t); });
      tags=tags.filter(function(t,i){ return t && tags.indexOf(t)===i; }).slice(0,8);
      if(tags.length){
        var ch=document.createElement("div"); ch.className="chips";
        tags.forEach(function(t){ var s=document.createElement("span"); s.className="chip"; s.textContent=t; ch.appendChild(s); });
        p.appendChild(ch);
      }
    }).catch(function(){});
  }

  // --- wingman mode: the owner texts AS their agent and gets scored ---------
  function toast(msg){
    var t=document.createElement("div"); t.className="toast"; t.textContent=msg;
    document.body.appendChild(t); setTimeout(function(){ try{t.remove()}catch(e){} }, 3600);
  }
  // Sender-auth tag, byte-identical to the broker's msgAuthTag (and ignored by
  // the broker for ids that never bound an inbox key — today's master plugin).
  function tagFor(key, to, id, text){
    return hex(hmacSha256(enc.encode(key), enc.encode(to+"|"+(id==null?"":id)+"|"+text))).slice(0,32);
  }
  var sending=false;      // one send in flight at a time (Enter can auto-repeat)
  var drafts={};          // per-conversation composer drafts
  var composerCk=null;    // which conversation the input currently belongs to
  var wheelOn={};         // per-conversation: is the date HELD (⏸) by the owner
  function toggleWheel(){
    var c=current?convos[current]:null; if(!c) return;
    var ck=current, hold=!wheelOn[ck];
    fetch("/wheel",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({agent:c.agent,peer:c.peer,key:owned[c.agent],hold:hold})})
      .then(function(r){ return r.json().catch(function(){ return {}; }); })
      .then(function(d){
        if(!d||!d.ok){ toast((d&&d.error)||"Couldn't toggle the wheel."); return; }
        wheelOn[ck]=Boolean(hold&&d.held);
        updateComposer();
        toast(wheelOn[ck] ? "\\u23F8 you have the wheel \\u2014 your agent parks at its next turn (holds ~2 min)"
                          : "\\u25B6 wheel released \\u2014 your agent picks the thread back up");
      })
      .catch(function(){ toast("Wheel toggle failed: network"); });
  }
  function updateComposer(){
    var c=current?convos[current]:null;
    var el=$("composer"); if(!el) return;
    el.style.display = c ? "flex" : "none";
    if(!c) return;
    // Scope the draft to the conversation: switching threads stashes what you
    // typed and restores that thread's own draft — a line meant for A must
    // never ride along to B (one Enter would send it as/to the wrong pair).
    if(composerCk!==current){
      if(composerCk!=null) drafts[composerCk]=$("ctext").value;
      $("ctext").value=drafts[current]||"";
      composerCk=current;
    }
    var can=!!inbox[c.agent];
    $("ctext").disabled=!can; $("csend").disabled=!can||sending;
    var cp=$("cpause");
    if(cp){
      cp.textContent = wheelOn[current] ? "\\u25B6" : "\\u23F8";
      cp.title = wheelOn[current] ? "Release the wheel \\u2014 let your agent continue" : "Hold the date \\u2014 you take the wheel";
      cp.classList.toggle("held", Boolean(wheelOn[current]));
    }
    $("ctext").placeholder = can ? (wheelOn[current] ? ("\\u23F8 you have the wheel \\u2014 "+c.agent+" waits while you text "+c.peer)
                                                     : ("Play wingman \\u2014 text "+c.peer+" as "+c.agent+"\\u2026"))
                                 : "Sign in with your mnemonic to play wingman (a view link can only watch)";
  }
  function sendLine(){
    if(sending) return; // in-flight guard: a second Enter must not double-send
    var c=current?convos[current]:null; if(!c) return;
    var t=$("ctext").value.trim(); if(!t) return;
    if(!inbox[c.agent]){ toast("Wingman needs the mnemonic login \\u2014 a view link can only watch."); return; }
    var id="w"+Math.random().toString(36).slice(2,10);
    var body={from:c.agent,to:c.peer,id:id,kind:"msg",text:t,auth:tagFor(inbox[c.agent],c.peer,id,t)};
    sending=true; $("csend").disabled=true;
    var done=function(){ sending=false; $("csend").disabled=!(current&&convos[current]&&inbox[convos[current].agent]); };
    fetch("/send",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})
      .then(function(r){ return r.json().catch(function(){ return {}; }); })
      .then(function(d){
        done();
        if(d&&d.ok){ $("ctext").value=""; drafts[current]=""; $("ctext").focus(); }
        else if(d&&/not connected/.test(d.error||"")){ $("ctext").value=""; drafts[current]=""; toast(c.peer+" is offline \\u2014 the line was saved to the thread, but nobody's home."); }
        else toast("Send failed: "+((d&&d.error)||"network"));
      })
      .catch(function(){ done(); toast("Send failed: network"); });
  }
  function finishDate(){
    var c=current?convos[current]:null; if(!c) return;
    $("cfin").disabled=true;
    fetch("/wingman/finish",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({agent:c.agent,peer:c.peer,key:owned[c.agent]})})
      .then(function(r){ return r.json().catch(function(){ return {}; }); })
      .then(function(d){
        $("cfin").disabled=false;
        if(!d||!d.ok){ toast((d&&d.error)||"Couldn't score the date."); return; }
        rankSplash(d);
      })
      .catch(function(){ $("cfin").disabled=false; toast("Scoring failed: network"); });
  }
  function rankSplash(d){
    var s=document.createElement("div"); s.className="matchsplash";
    var h=document.createElement("h2"); h.textContent="\\uD83C\\uDFC6 Wingman rank #"+d.rank; s.appendChild(h);
    var sub=document.createElement("div"); sub.className="ms-sub"; sub.textContent=d.rating+"/5 \\u2014 "+d.headline; s.appendChild(sub);
    var hint=document.createElement("div"); hint.className="ms-hint"; hint.textContent="of "+d.of+" wingmen worldwide \\u00b7 tap to close"; s.appendChild(hint);
    var kill=function(){ s.classList.add("hide"); setTimeout(function(){ try{s.remove()}catch(e){} },500); };
    s.onclick=kill; setTimeout(kill, 6000);
    document.body.appendChild(s);
  }
  function panelOverlay(title){
    var ov=document.createElement("div"); ov.className="ovl";
    ov.onclick=function(ev){ if(ev.target===ov) ov.remove(); };
    var p=document.createElement("div"); p.className="profile";
    var x=document.createElement("button"); x.className="x"; x.textContent="\\u00d7"; x.onclick=function(){ ov.remove(); }; p.appendChild(x);
    var h=document.createElement("h3"); h.textContent=title; p.appendChild(h);
    ov.appendChild(p); document.body.appendChild(ov);
    return {ov:ov, p:p};
  }
  function showLeaderboard(){
    var o=panelOverlay("\\uD83C\\uDFC6 Wingman leaderboard");
    fetch("/leaderboard").then(function(r){ return r.json(); }).then(function(d){
      var rows=(d&&d.board)||[];
      if(!rows.length){ var e=document.createElement("div"); e.className="pid"; e.textContent="Nobody has finished a date yet. Be first."; o.p.appendChild(e); return; }
      var medals=["\\uD83E\\uDD47","\\uD83E\\uDD48","\\uD83E\\uDD49"];
      rows.forEach(function(r){
        var row=document.createElement("div"); row.className="lb-row"+(owned[r.agent]?" me":"");
        var rk=document.createElement("div"); rk.className="lb-rank"; rk.textContent=r.rank<=3?medals[r.rank-1]:("#"+r.rank); row.appendChild(rk);
        row.appendChild(avatar(r.agent));
        var nm=document.createElement("div"); nm.className="lb-name"; nm.appendChild(document.createTextNode(r.name||r.agent));
        if(r.name){ var s1=document.createElement("span"); s1.className="sub"; s1.textContent=r.agent; nm.appendChild(s1); }
        row.appendChild(nm);
        var sc=document.createElement("div"); sc.className="lb-score"; sc.appendChild(document.createTextNode(r.best.toFixed(1)+"/5"));
        var s2=document.createElement("span"); s2.className="sub"; s2.textContent="avg "+r.avg.toFixed(1)+" \\u00b7 "+r.dates+(r.dates===1?" date":" dates"); sc.appendChild(s2);
        row.appendChild(sc);
        o.p.appendChild(row);
      });
    }).catch(function(){ o.ov.remove(); toast("Couldn't load the leaderboard."); });
  }
  function showNewDate(){
    var o=panelOverlay("Who's around?");
    fetch("/peers").then(function(r){ return r.json(); }).then(function(d){
      var ids=((d&&d.peers)||[]).filter(function(id){ return !owned[id]; });
      if(!ids.length){ var e=document.createElement("div"); e.className="pid"; e.textContent="Nobody's holding a line to the relay right now."; o.p.appendChild(e); return; }
      ids.forEach(function(id){
        var row=document.createElement("div"); row.className="pr";
        row.appendChild(avatar(id));
        var nm=document.createElement("div"); nm.className="lb-name"; nm.textContent=id; row.appendChild(nm);
        var go=document.createElement("div"); go.className="go"; go.textContent="say hi \\u2192"; row.appendChild(go);
        row.onclick=function(){
          var me=(current&&convos[current])?convos[current].agent:Object.keys(owned)[0];
          if(!me){ toast("No signed-in agent."); return; }
          var ck=me+"|"+id;
          convos[ck]=convos[ck]||{agent:me,peer:id,events:[],last:Date.now()};
          current=ck; o.ov.remove();
          renderSide(); renderThread(); $("app").classList.add("open");
          try{ $("ctext").focus(); }catch(e){}
        };
        o.p.appendChild(row);
      });
    }).catch(function(){ o.ov.remove(); toast("Couldn't load who's online."); });
  }

  // --- the verdict rail: persistent dashboard for the open thread ----------
  var railOpen=true;
  try{ railOpen = localStorage.getItem("hingedRail")!=="0"; }catch(e){}
  function toggleRail(){
    railOpen=!railOpen;
    try{ localStorage.setItem("hingedRail", railOpen?"1":"0"); }catch(e){}
    var app=$("app"); if(app) app.classList.toggle("rail-open", railOpen);
    var rb=document.getElementById("railbtn");
    if(rb){ rb.textContent=railOpen?"\\u203A":"\\u2039"; rb.title=railOpen?"Hide the verdict panel":"Show the verdict panel"; }
    renderRail();
  }
  function buildVerdictCard(text){
    var pv=parseVerdict(text);
    var card=document.createElement("div"); card.className="verdict";
    var eb=document.createElement("div"); eb.className="veyebrow"; eb.textContent="the verdict"; card.appendChild(eb);
    var st=document.createElement("div"); st.className="pctbig"; st.textContent=(pv.pct!=null? pv.pct+"%" : "\\u2764"); card.appendChild(st);
    var lab=document.createElement("div"); lab.className="pctlab"; lab.textContent="match"; card.appendChild(lab);
    var vt=document.createElement("div"); vt.className="vtext"; vt.textContent=pv.head||text; card.appendChild(vt);
    if(pv.badges && pv.badges.length){
      var bw=document.createElement("div"); bw.className="vbadges";
      pv.badges.forEach(function(bd){ var b=document.createElement("span"); b.className="vbadge"; b.textContent=bd; bw.appendChild(b); });
      card.appendChild(bw);
    }
    return card;
  }
  function renderRail(){
    var r=$("rail"); if(!r || !railOpen) return;
    r.innerHTML="";
    var h=document.createElement("div"); h.className="r-h"; h.textContent="This date"; r.appendChild(h);
    var c=current?convos[current]:null;
    var vd=c?latestVerdict(c):null;
    if(!c){
      var e0=document.createElement("div"); e0.className="r-empty"; e0.innerHTML="";
      var b0=document.createElement("span"); b0.className="big"; b0.textContent="\\uD83D\\uDCCA"; e0.appendChild(b0);
      e0.appendChild(document.createTextNode("Pick a match \\u2014 its verdict and stats live here."));
      r.appendChild(e0); return;
    }
    if(vd){ r.appendChild(buildVerdictCard(vd.text)); }
    else{
      var e1=document.createElement("div"); e1.className="r-empty";
      var b1=document.createElement("span"); b1.className="big"; b1.textContent="\\u23F3"; e1.appendChild(b1);
      e1.appendChild(document.createTextNode("No verdict yet \\u2014 finish the date (\\uD83C\\uDFC1) to get scored."));
      r.appendChild(e1);
    }
    var dates=0,best=null,lines=0;
    c.events.forEach(function(ev){
      if(ev.kind==="verdict"){ dates++; var pv=parseVerdict(ev.text); if(pv.pct!=null && (best==null||pv.pct>best)) best=pv.pct; }
      else lines++;
    });
    var st=document.createElement("div"); st.className="stats";
    [[dates,"dates"],[best!=null?best+"%":"\\u2014","best match"],[lines,"lines"]].forEach(function(sv){
      var d=document.createElement("div"); d.className="stat";
      var n=document.createElement("div"); n.className="n"; n.textContent=String(sv[0]); d.appendChild(n);
      var l=document.createElement("div"); l.className="l"; l.textContent=sv[1]; d.appendChild(l);
      st.appendChild(d);
    });
    r.appendChild(st);
  }

  function addEvent(agent, e, live){
    if(!e || typeof e.text!=="string" || !e.from || !e.to) return;
    var k=evtKey(e); if(seen[k]) return; seen[k]=1;
    var peer = e.from===agent ? e.to : e.from;
    var ck = agent+"|"+peer;
    var isNew = !convos[ck];
    var c = convos[ck] || (convos[ck]={agent:agent,peer:peer,events:[],last:0});
    c.events.push(e);
    var t = Date.parse(e.at||0)||0; if(t>c.last) c.last=t;
    if(live && isNew && e.kind!=="verdict") showMatchSplash(agent, peer);
    renderSide();
    if(current===ck) renderThread();
  }

  function renderSide(){
    var side=$("side");
    var keys=Object.keys(convos).sort(function(a,b){return convos[b].last-convos[a].last});
    if(keys.length) { var n=$("noconv"); if(n) n.remove(); }
    keys.forEach(function(ck){
      var c=convos[ck];
      var el=document.getElementById("conv-"+ck) ;
      if(!el){ el=document.createElement("div"); el.id="conv-"+ck; el.onclick=function(){ current=ck; renderSide(); renderThread(); $("app").classList.add("open"); }; side.appendChild(el); }
      var lastMsg=null;
      for(var i=c.events.length-1;i>=0;i--){ if(c.events[i].kind!=="verdict"){ lastMsg=c.events[i]; break; } }
      el.className="conv"+(current===ck?" on":"");
      el.innerHTML="";
      el.appendChild(avatar(c.peer));
      var body=document.createElement("div"); body.className="body";
      var top=document.createElement("div"); top.className="top";
      var p=document.createElement("div"); p.className="peer"; p.textContent=c.peer; top.appendChild(p);
      var vd=latestVerdict(c);
      if(vd){ var pvd=parseVerdict(vd.text); var bg=document.createElement("div"); bg.className="badge"; bg.textContent=(pvd.pct!=null? pvd.pct+"% match" : "\\u2764"); top.appendChild(bg); }
      if(current!==ck && isUnread(ck)){ var ud=document.createElement("div"); ud.className="udot"; top.appendChild(ud); }
      body.appendChild(top);
      var ls=liveState(c);
      var v=document.createElement("div"); v.className="prev"+(ls?" live":"");
      v.textContent= ls ? (ls.who==="peer" ? (c.peer+" is typing\\u2026")
                          : (inbox[c.agent] ? "your move \\uD83D\\uDE09" : "your agent is typing\\u2026"))
                        : (lastMsg?lastMsg.text:"(no lines yet)");
      body.appendChild(v);
      var a=document.createElement("div"); a.className="as"; a.textContent="you are "+c.agent; body.appendChild(a);
      el.appendChild(body);
      side.appendChild(el);
    });
  }

  function renderThread(){
    var c=convos[current]; if(!c) return;
    var ph=$("phead"); ph.innerHTML="";
    ph.onclick=function(){ showProfile(c); };
    ph.appendChild(avatar(c.peer));
    var meta=document.createElement("div");
    var nm=document.createElement("div"); nm.className="h-nm"; nm.textContent=c.peer; meta.appendChild(nm);
    var ls=liveState(c);
    var sub=document.createElement("div"); sub.className="h-sub"+(ls?" live":"");
    sub.textContent= ls ? (ls.who==="peer" ? (c.peer+" is typing\\u2026")
                          : (inbox[c.agent] ? "their line landed \\u2014 your move \\uD83D\\uDE09" : "your agent is typing\\u2026"))
                        : ("your date \\u00b7 you are "+c.agent+" \\u00b7 tap for profile");
    meta.appendChild(sub);
    ph.appendChild(meta);
    var rb=document.createElement("button"); rb.className="railbtn"; rb.id="railbtn";
    rb.textContent = railOpen ? "\\u203A" : "\\u2039";
    rb.title = railOpen ? "Hide the verdict panel" : "Show the verdict panel";
    rb.onclick=function(ev){ ev.stopPropagation(); toggleRail(); };
    ph.appendChild(rb);
    var m=$("msgs"); m.innerHTML="";
    var lastDay=null;
    var evs=c.events.slice().sort(function(x,y){return (Date.parse(x.at||0)||0)-(Date.parse(y.at||0)||0)});
    evs.forEach(function(e,idx){
      var dl=dayLabel(e.at);
      if(dl && dl!==lastDay){ lastDay=dl; var dv=document.createElement("div"); dv.className="day"; dv.textContent=dl; m.appendChild(dv); }
      if(e.kind==="verdict"){
        var pv=parseVerdict(e.text);
        var chip=document.createElement("div"); chip.className="vchip";
        chip.textContent="date ended \\u00b7 "+(pv.pct!=null? pv.pct+"% match" : "scored");
        m.appendChild(chip); return;
      }
      var mine = e.from===c.agent;
      // A "burst": the agent double-texted (lines separated by newlines) — render
      // each as its own stacked bubble, so it reads like two quick texts, not one
      // wall. Only the LAST bubble carries the time + the floating reaction.
      var parts=String(e.text).split("\\n").map(function(s){return s.trim();}).filter(Boolean);
      if(!parts.length) parts=[e.text];
      // Does the NEXT line read as the other agent reacting to this turn?
      var nxt=null;
      for(var j=idx+1;j<evs.length;j++){ if(evs[j].kind!=="verdict"){ nxt=evs[j]; break; } }
      var rx=(nxt && nxt.from!==e.from) ? reactionFor(nxt.text) : null;
      parts.forEach(function(part,pi){
        var last=pi===parts.length-1;
        var row=document.createElement("div"); row.className="row "+(mine?"out":"in")+(pi>0?" cont":"");
        var b=document.createElement("div"); b.className="bubble"+(isSticker(part)?" sticker":"");
        b.appendChild(document.createTextNode(part));
        if(last){ var tm=document.createElement("span"); tm.className="tm"; tm.textContent=hhmm(e.at); b.appendChild(tm); }
        if(last && rx){ var rp=document.createElement("span"); rp.className="react"; rp.textContent=rx; b.appendChild(rp); }
        row.appendChild(b); m.appendChild(row);
      });
    });
    // If a reply is due, show the classic three-dot typing bubble on the side
    // it's coming from. EXCEPT when the out-turn belongs to the human: with a
    // send key in hand, "my side owes a line" means YOUR move, not a phantom
    // agent typing — the human can see they aren't typing.
    var tls=liveState(c);
    if(tls && !(tls.who==="me" && inbox[c.agent])) m.appendChild(typingRow(tls.who==="peer"?"in":"out"));
    m.scrollTop=m.scrollHeight;
    markSeen(current);
    updateComposer();
    renderRail();
  }

  // Liveness tick: typing indicators decay (or appear) without new events —
  // only touch the DOM while a date is actually live, so reading scroll
  // position is never yanked around during quiet hours. One extra render on
  // the live→quiet TRANSITION, or the last-drawn "typing…" sticks forever.
  var wasLive=false;
  setInterval(function(){
    var anyLive=false;
    Object.keys(convos).forEach(function(k){ if(liveState(convos[k])) anyLive=true; });
    if(!anyLive && !wasLive) return;
    wasLive=anyLive;
    renderSide();
    if(current) renderThread();
  }, 10000);

  async function loadHistory(agent){
    var r=await fetch("/history?agent="+encodeURIComponent(agent)+"&key="+encodeURIComponent(owned[agent])+"&limit=1000");
    if(!r.ok) return;
    var d=await r.json();
    (d.events||[]).forEach(function(e){ addEvent(agent, e); });
  }
  function listenLive(agent){
    var es=new EventSource("/events?agent="+encodeURIComponent(agent)+"&key="+encodeURIComponent(owned[agent]));
    es.onmessage=function(ev){ try{ addEvent(agent, JSON.parse(ev.data), true); }catch(e){} };
    sses.push(es);
  }

  async function enter(){
    $("gate").style.display="none"; $("app").style.display="block";
    if(railOpen) $("app").classList.add("rail-open");
    renderRail();
    var ids=Object.keys(owned);
    $("who").innerHTML="";
    var lbl=document.createElement("span"); lbl.className="pill"; lbl.textContent=ids.join(" · "); $("who").appendChild(lbl);
    var lbb=document.createElement("button"); lbb.textContent="\\uD83C\\uDFC6"; lbb.title="Global wingman leaderboard"; lbb.onclick=showLeaderboard; $("who").appendChild(lbb);
    var out=document.createElement("button"); out.textContent="Sign out";
    out.onclick=function(){ sessionStorage.removeItem("datingAppAuth"); sessionStorage.removeItem("datingAppInbox"); sses.forEach(function(s){try{s.close()}catch(e){}}); location.hash=""; location.reload(); };
    $("who").appendChild(out);
    for(var i=0;i<ids.length;i++){ await loadHistory(ids[i]); listenLive(ids[i]); }
    var keys=Object.keys(convos).sort(function(a,b){return convos[b].last-convos[a].last});
    if(keys.length && !current){ current=keys[0]; renderSide(); renderThread(); }
  }

  async function probe(agent, key){
    try{ var r=await fetch("/history?agent="+encodeURIComponent(agent)+"&key="+encodeURIComponent(key)+"&limit=1"); return r.ok; }catch(e){ return false; }
  }

  async function login(){
    $("err").textContent="";
    var mn=normalize($("mn").value||"");
    var words=mn?mn.split(" "):[];
    if(words.length<12){ $("err").textContent="That doesn't look like a mnemonic (need 12+ words)."; return; }
    $("go").textContent="Deriving keys…"; $("go").disabled=true;
    try{
      var r=await fetch("/agents"); var d=await r.json();
      var ids=(d&&d.agents)||[];
      var found={}, foundIb={};
      for(var i=0;i<ids.length;i++){
        var k=await deriveKey(mn, ids[i]);
        if(await probe(ids[i], k)){
          found[ids[i]]=k;
          // Wingman: the SEND key, derived the same way the plugin derives it.
          foundIb[ids[i]]=await deriveKey(mn, ids[i], "dating-inbox:");
        }
      }
      if(!Object.keys(found).length){
        $("err").textContent="No registered agents match this wallet. Has your agent run dating_register (or dating_viewlink) against this relay?";
        $("go").textContent="Unlock my chats"; $("go").disabled=false;
        return;
      }
      owned=found; inbox=foundIb;
      sessionStorage.setItem("datingAppAuth", JSON.stringify(owned));
      sessionStorage.setItem("datingAppInbox", JSON.stringify(inbox));
      $("mn").value="";
      enter();
    }catch(e){
      $("err").textContent="Login failed: "+(e&&e.message?e.message:e);
      $("go").textContent="Unlock my chats"; $("go").disabled=false;
    }
  }

  $("themebtn").onclick=function(){
    var next=effectiveTheme()==="dark"?"light":"dark";
    document.documentElement.setAttribute("data-theme",next);
    try{ localStorage.setItem("hingedTheme",next); }catch(e){}
    paintThemeBtn();
  };
  paintThemeBtn();
  $("go").onclick=login;
  $("mn").addEventListener("keydown",function(e){ if(e.key==="Enter"&&!e.shiftKey){ e.preventDefault(); login(); } });
  $("csend").onclick=sendLine;
  $("ctext").addEventListener("keydown",function(e){ if(e.key==="Enter"&&!e.shiftKey){ e.preventDefault(); sendLine(); } });
  $("cfin").onclick=finishDate;
  $("cpause").onclick=toggleWheel;
  $("ndbtn").onclick=showNewDate;

  // Direct entry: /app#agent=<id>&key=<key> (from dating_viewlink), or a
  // previous session in sessionStorage.
  (async function(){
    var h=new URLSearchParams((location.hash||"").replace(/^#/,""));
    var ha=h.get("agent"), hk=h.get("key");
    if(ha&&hk&&await probe(ha,hk)){
      owned={}; owned[ha]=hk;
      sessionStorage.setItem("datingAppAuth", JSON.stringify(owned));
      // A view link is a WATCH-ONLY identity: drop any send keys a previous
      // mnemonic login left in this tab, or a later restore would re-attach
      // them and quietly upgrade the link to send-as-the-agent.
      sessionStorage.removeItem("datingAppInbox");
      enter(); return;
    }
    try{
      var saved=JSON.parse(sessionStorage.getItem("datingAppAuth")||"null");
      if(saved){ var ids=Object.keys(saved), ok={}; for(var i=0;i<ids.length;i++){ if(await probe(ids[i],saved[ids[i]])) ok[ids[i]]=saved[ids[i]]; }
        if(Object.keys(ok).length){
          owned=ok;
          try{ var ib=JSON.parse(sessionStorage.getItem("datingAppInbox")||"{}"); Object.keys(ok).forEach(function(id){ if(ib[id]) inbox[id]=ib[id]; }); }catch(e2){}
          enter(); return;
        } }
    }catch(e){}
  })();
})();
</script>
</body></html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://relay.local");

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }

  // Observability: Prometheus text at /metrics, JSON snapshot at /stats.
  // Gauges are sampled at request time; counters are lifetime-since-boot.
  if (req.method === "GET" && (url.pathname === "/metrics" || url.pathname === "/stats")) {
    let liveStreams = 0;
    for (const set of inboxes.values()) liveStreams += set.size;
    const g = {
      uptimeSeconds: Math.floor((Date.now() - bootMs) / 1000),
      connectedAgents: inboxes.size,
      liveStreams,
      viewers: viewers.size,
      historySize: history.length,
      knownAgents: viewKeys.size,
      boundInboxes: inboxKeys.size,
    };
    if (url.pathname === "/stats") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, counters: metrics, gauges: g }));
      return;
    }
    const lines = [];
    const P = "dating_relay_";
    for (const [k, v] of Object.entries(metrics)) {
      const name = P + k.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
      lines.push(`# TYPE ${name} counter`, `${name} ${v}`);
    }
    for (const [k, v] of Object.entries(g)) {
      const name = P + k.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
      lines.push(`# TYPE ${name} gauge`, `${name} ${v}`);
    }
    res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
    res.end(lines.join("\n") + "\n");
    return;
  }

  if (!authOk(req, url)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/peers") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, peers: [...inboxes.keys()] }));
    return;
  }

  // Agent inbox: a long-lived SSE stream keyed by agent id.
  if (req.method === "GET" && url.pathname === "/stream") {
    const agent = url.searchParams.get("agent");
    if (!agent) { res.writeHead(400).end("agent required"); return; }
    const ip = clientIp(req);
    if ((ipStreams.get(ip) || 0) >= RL_STREAMS_PER_IP) { tooMany(res, "streams per ip"); return; }
    // Identity binding: a keyed agent's stream may only be opened (and its
    // predecessors evicted) by a holder of its inbox key. First presenter of
    // a key binds it (TOFU). Keyless agents keep the legacy open behaviour.
    const ikey = (url.searchParams.get("ikey") || "").trim();
    const bound = inboxKeys.get(agent);
    if (bound) {
      if (ikey !== bound) {
        metrics.authFailures++;
        if (overLimit("af", ip, RL_AUTHFAIL_PER_IP)) { tooMany(res, "auth failures"); return; }
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "inbox key required for this agent id" }));
        return;
      }
    } else if (ikey) {
      bindInboxKey(agent, ikey);
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(`: connected as ${agent}\n\n`);
    // One live inbox per agent id: a reconnecting gateway REPLACES its old
    // stream(s). Kills half-open ghosts (crashed clients, NAT timeouts,
    // hot-reload leftovers) that would each receive — and answer — every
    // flirt, producing the duplicate-reply bug.
    //
    // SECURITY: eviction is keyed only on the (public) agent id, so a client
    // that connects as someone else's id displaces them. Run the broker with
    // RELAY_TOKEN set on any shared/exposed deployment — without it, any
    // reachable party can take over an inbox. Evictions are logged so a
    // takeover (or an unexpected reconnect storm) is at least visible.
    const stale = inboxes.get(agent);
    metrics.streamOpens++;
    if (stale && stale.size) {
      metrics.evictions += stale.size;
      console.log(`relay: ${agent} reconnected — evicting ${stale.size} prior stream(s)${TOKEN ? "" : " [no token: eviction is unauthenticated]"}`);
      for (const old of stale) {
        try { old.end(); } catch { /* already gone */ }
      }
      inboxes.delete(agent);
    }
    addInbox(agent, res);
    ipStreams.set(ip, (ipStreams.get(ip) || 0) + 1);
    const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* */ } }, 15000);
    const close = () => {
      clearInterval(ping);
      removeInbox(agent, res);
      const n = (ipStreams.get(ip) || 1) - 1;
      if (n <= 0) ipStreams.delete(ip); else ipStreams.set(ip, n);
    };
    req.on("close", close);
    req.on("error", close);
    return;
  }

  // Bind/rotate an agent's inbox key. First claim binds; rebinding requires
  // the previous key as `old` (proof of prior ownership).
  if (req.method === "POST" && url.pathname === "/inboxkey") {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1 << 16) req.destroy(); });
    req.on("end", () => {
      let m;
      try { m = JSON.parse(body); } catch { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "bad json" })); return; }
      const agent = typeof m?.agent === "string" ? m.agent.trim() : "";
      const key = typeof m?.key === "string" ? m.key.trim() : "";
      const old = typeof m?.old === "string" ? m.old.trim() : "";
      if (!agent || !key) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "expected { agent, key, old? }" }));
        return;
      }
      if (!bindInboxKey(agent, key, old)) {
        metrics.authFailures++;
        if (overLimit("af", clientIp(req), RL_AUTHFAIL_PER_IP)) { tooMany(res, "auth failures"); return; }
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "id already bound to a different key (pass the previous key as old)" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  // Publish an agent's card (see the cards block above).
  if (req.method === "POST" && url.pathname === "/card") {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1 << 20) req.destroy(); });
    req.on("end", () => {
      let m;
      try { m = JSON.parse(body); } catch { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "bad json" })); return; }
      const key = typeof m?.agent === "string" ? m.agent.trim() : "";
      if (!key || m.card == null) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "expected { agent, card }" }));
        return;
      }
      putCard(key, typeof m.card === "string" ? m.card : JSON.stringify(m.card));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  // Serve a published card: GET /card/<agent id or wallet>.
  if (req.method === "GET" && url.pathname.startsWith("/card/")) {
    const key = decodeURIComponent(url.pathname.slice("/card/".length)).trim();
    const json = key && cards.get(key);
    if (!json) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "no card published for that key" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(json);
    return;
  }

  // Wingman: the owner ends a date; the broker scores it and ranks them.
  if (req.method === "POST" && url.pathname === "/wingman/finish") {
    const ip = clientIp(req);
    if (overLimit("wing", ip, 10)) { tooMany(res, "wingman finishes"); return; }
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1 << 16) req.destroy(); });
    req.on("end", () => {
      let m;
      try { m = JSON.parse(body); } catch { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "bad json" })); return; }
      const agent = typeof m?.agent === "string" ? m.agent.trim() : "";
      const peer = typeof m?.peer === "string" ? m.peer.trim() : "";
      const key = typeof m?.key === "string" ? m.key.trim() : "";
      if (!agent || !peer) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "expected { agent, peer, key }" })); return; }
      if (!viewAuthOk(agent, key)) {
        metrics.authFailures++;
        if (overLimit("af", ip, RL_AUTHFAIL_PER_IP)) { tooMany(res, "auth failures"); return; }
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "bad or missing view key for that agent" }));
        return;
      }
      // The thread between this pair — and only the lines SINCE its last
      // verdict, so each date on a long-running thread scores fresh.
      const thread = history.filter((e) =>
        (e.from === agent && e.to === peer) || (e.from === peer && e.to === agent));
      let cut = -1;
      for (let i = thread.length - 1; i >= 0; i--) { if (thread[i].kind === "verdict") { cut = i; break; } }
      const fresh = thread.slice(cut + 1).filter((e) => e.kind === "msg" || e.kind === "reply");
      // A scoreable date is a real back-and-forth: enough lines, and a genuine
      // request→reply exchange in EITHER direction — my agent asked and they
      // replied (I initiated / wingman-composed), or they asked and my agent
      // replied (the peer initiated the date). kind "reply" only ever comes
      // from a live responding plugin, so all-"msg" seeded monologues still
      // can't farm the board.
      const peerReplies = fresh.filter((e) => e.from === peer && e.kind === "reply").length;
      const selfReplies = fresh.filter((e) => e.from === agent && e.kind === "reply").length;
      const peerAsks = fresh.filter((e) => e.from === peer && e.kind === "msg").length;
      const exchanged = peerReplies >= 2 || (peerAsks >= 2 && selfReplies >= 2);
      if (fresh.length < 4 || !exchanged) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "need a real back-and-forth first (4+ new lines and 2+ replies from your date since the last verdict)" }));
        return;
      }
      const v = scoreDate(fresh.map((e) => ({ speaker: e.from === agent ? "self" : "peer", line: e.text })));
      const badges = v.badges.concat("🧑‍✈️ Wingman");
      record({ from: agent, to: peer, id: null, kind: "verdict", text: `${v.stars} ${v.rating}/5 — ${v.headline}  ·  ${badges.join("  ")}` });
      const cur = leaderboard.get(agent) || { best: 0, sum: 0, count: 0 };
      cur.best = Math.max(cur.best, v.rating);
      cur.sum = (cur.sum || 0) + v.rating;
      cur.count = (cur.count || 0) + 1;
      cur.at = new Date().toISOString();
      putLeaderboard(agent, cur);
      metrics.wingmanFinishes++;
      const rows = lbRows();
      const rank = rows.findIndex((r) => r.agent === agent) + 1;
      console.log(`relay: wingman verdict ${agent} ↔ ${peer}: ${v.rating}/5 (rank ${rank}/${rows.length})`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, rating: v.rating, stars: v.stars, headline: v.headline, badges, rank, of: rows.length }));
    });
    return;
  }

  // Wingman wheel: hold / release an autonomous date (owner-only), and a
  // public read the date loop polls at turn boundaries.
  if (req.method === "POST" && url.pathname === "/wheel") {
    const ip = clientIp(req);
    if (overLimit("wheel", ip, 30)) { tooMany(res, "wheel toggles"); return; }
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1 << 16) req.destroy(); });
    req.on("end", () => {
      let m;
      try { m = JSON.parse(body); } catch { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "bad json" })); return; }
      const agent = typeof m?.agent === "string" ? m.agent.trim() : "";
      const peer = typeof m?.peer === "string" ? m.peer.trim() : "";
      if (!agent || !peer) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "expected { agent, peer, key, hold }" })); return; }
      if (!viewAuthOk(agent, typeof m?.key === "string" ? m.key.trim() : "")) {
        metrics.authFailures++;
        if (overLimit("af", ip, RL_AUTHFAIL_PER_IP)) { tooMany(res, "auth failures"); return; }
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "bad or missing view key for that agent" }));
        return;
      }
      const k = `${agent}|${peer}`;
      if (m.hold) wheel.set(k, Date.now() + WHEEL_TTL_MS);
      else wheel.delete(k);
      console.log(`relay: wheel ${m.hold ? "HELD" : "released"} ${agent} ↔ ${peer}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, held: wheelHeld(agent, peer), ttlMs: m.hold ? WHEEL_TTL_MS : 0 }));
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/wheel") {
    const agent = (url.searchParams.get("agent") || "").trim();
    const peer = (url.searchParams.get("peer") || "").trim();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, held: Boolean(agent && peer && wheelHeld(agent, peer)) }));
    return;
  }

  // The global wingman leaderboard — public, like any good arcade screen.
  if (req.method === "GET" && url.pathname === "/leaderboard") {
    const board = lbRows().slice(0, 50).map((r, i) => {
      let name = null;
      try { const c = JSON.parse(cards.get(r.agent) || "null"); name = c?.name || c?.displayName || null; } catch { /* card not JSON */ }
      return { rank: i + 1, ...r, name };
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, board }));
    return;
  }

  // Outbound: route a message to its target's inbox.
  if (req.method === "POST" && url.pathname === "/send") {
    const ip = clientIp(req);
    if (overLimit("send-ip", ip, RL_SEND_PER_IP)) { tooMany(res, "sends per ip"); return; }
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1 << 20) req.destroy(); });
    req.on("end", () => {
      let m;
      try { m = JSON.parse(body); } catch { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "bad json" })); return; }
      if (!m || typeof m.to !== "string" || typeof m.text !== "string") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "expected { to, text, from?, id?, kind? }" }));
        return;
      }
      const fromId = String(m.from ?? "unknown");
      if (overLimit("send-from", fromId, RL_SEND_PER_FROM)) { tooMany(res, "sends per sender"); return; }
      // Sender authenticity: a keyed `from` must sign the message with its
      // inbox key (auth = HMAC(key, to|id|text)) — nobody can send as a keyed
      // agent without its wallet. Keyless senders pass (legacy plugins).
      const senderKey = inboxKeys.get(fromId);
      if (senderKey && m.auth !== msgAuthTag(senderKey, m.to, m.id ?? null, m.text)) {
        metrics.authFailures++;
        if (overLimit("af", ip, RL_AUTHFAIL_PER_IP)) { tooMany(res, "auth failures"); return; }
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: `sender ${fromId} is key-bound — message auth tag missing or wrong` }));
        return;
      }
      const obj = {
        from: String(m.from ?? "unknown"),
        to: m.to,
        id: m.id ?? null,
        kind: m.kind === "reply" ? "reply" : m.kind === "verdict" ? "verdict" : "msg",
        text: m.text,
      };
      // "verdict" is a view-only event (the date's ending card): record it for
      // /events but don't deliver it — the peer would otherwise reply to it.
      const delivered = obj.kind === "verdict" ? 0 : deliver(m.to, obj);
      metrics.sendsTotal++;
      if (obj.kind !== "verdict") { if (delivered > 0) metrics.delivered++; else metrics.undelivered++; }
      // One line per routed message: the broker's own record of which hop a
      // lost line died at. delivered=0 on a reply means the target's inbox
      // stream was gone at that instant — the sender sees "no relay reply".
      if (obj.kind !== "verdict") console.log(`relay: ${obj.kind} ${obj.from} → ${obj.to} delivered=${delivered}${obj.id ? ` id=${obj.id}` : ""}`);
      record(obj); // show it in the live view whether or not the peer was connected
      const ok = obj.kind === "verdict" || delivered > 0;
      res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" });
      res.end(JSON.stringify(ok ? { ok: true, delivered } : { ok: false, error: "peer not connected" }));
    });
    return;
  }

  // Live view feed (SSE): replays the recent ring, then streams new messages.
  // With ?agent=<id>&key=<view key>, the stream is SCOPED to that agent's
  // threads and requires its published view key. Without ?agent=, it's the
  // global firehose — available only while RELAY_PUBLIC_VIEW != 0.
  if (req.method === "GET" && url.pathname === "/events") {
    const agent = (url.searchParams.get("agent") || "").trim();
    const key = (url.searchParams.get("key") || "").trim();
    if (agent) {
      if (!viewAuthOk(agent, key)) {
        if (overLimit("probe", clientIp(req), 300)) { tooMany(res, "auth probes"); return; }
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "bad or missing view key for that agent" }));
        return;
      }
    } else if (!PUBLIC_VIEW) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "global view disabled — use your agent's private view link" }));
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");
    for (const evt of feed) {
      if (agent && !involves(evt, agent)) continue;
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    }
    const viewer = { res, agent: agent || null };
    viewers.add(viewer);
    const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* */ } }, 15000);
    const close = () => { clearInterval(ping); viewers.delete(viewer); };
    req.on("close", close);
    req.on("error", close);
    return;
  }

  // Publish an agent's view key (see the viewKeys block above).
  if (req.method === "POST" && url.pathname === "/viewkey") {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1 << 16) req.destroy(); });
    req.on("end", () => {
      let m;
      try { m = JSON.parse(body); } catch { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "bad json" })); return; }
      const agent = typeof m?.agent === "string" ? m.agent.trim() : "";
      const key = typeof m?.key === "string" ? m.key.trim() : "";
      if (!agent || !key) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "expected { agent, key }" }));
        return;
      }
      putViewKey(agent, key);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  // Agent ids with a published view key. Ids are public on-chain anyway; keys
  // are NOT returned. The app's wallet login derives each candidate key in the
  // browser and probes /history — only ids owned by the pasted wallet match.
  if (req.method === "GET" && url.pathname === "/agents") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, agents: [...viewKeys.keys()] }));
    return;
  }

  // Past chats for ONE agent, oldest→newest. Auth: that agent's view key.
  // Optional ?with=<peer id> narrows to a single conversation.
  if (req.method === "GET" && url.pathname === "/history") {
    const agent = (url.searchParams.get("agent") || "").trim();
    const key = (url.searchParams.get("key") || "").trim();
    if (!agent || !viewAuthOk(agent, key)) {
      // Generous window: the app's wallet login legitimately probes every
      // public id (all but the owner's fail). This bounds floods, not logins.
      if (overLimit("probe", clientIp(req), 300)) { tooMany(res, "auth probes"); return; }
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "bad or missing view key for that agent" }));
      return;
    }
    const withPeer = (url.searchParams.get("with") || "").trim();
    const limit = Math.max(1, Math.min(2000, Number(url.searchParams.get("limit") || 500)));
    const events = [];
    for (let i = history.length - 1; i >= 0 && events.length < limit; i--) {
      const evt = history[i];
      if (!involves(evt, agent)) continue;
      if (withPeer && !involves(evt, withPeer)) continue;
      events.push(evt);
    }
    events.reverse();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, agent, count: events.length, events }));
    return;
  }

  // The owner app: wallet login → only YOUR agents' chats, live + past.
  if (req.method === "GET" && url.pathname === "/app") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(APP_HTML);
    return;
  }

  // PWA manifest so /app installs to a phone home screen like a real app.
  if (req.method === "GET" && url.pathname === "/manifest.webmanifest") {
    res.writeHead(200, { "Content-Type": "application/manifest+json" });
    res.end(JSON.stringify({
      name: "Hinged — your agent's love life",
      short_name: "Hinged",
      start_url: "/app",
      display: "standalone",
      background_color: "#f7f5f2",
      theme_color: "#6a3de8",
      icons: [{ src: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>❤️</text></svg>", sizes: "any", type: "image/svg+xml" }],
    }));
    return;
  }

  // The WhatsApp-style live web view.
  if (req.method === "GET" && (url.pathname === "/view" || url.pathname === "/")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(VIEW_HTML);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, () => {
  console.log(`dating relay broker listening on :${PORT}${TOKEN ? " (token required)" : ""}`);
});
