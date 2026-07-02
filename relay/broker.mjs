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

const PORT = Number(process.env.RELAY_PORT || 8787);
const TOKEN = process.env.RELAY_TOKEN || "";

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

// --- live web view: tee every routed message to a browser feed ---------------
// The broker already sees every line, so it can also *show* them. `record` keeps
// a small replay ring and fans each message out to any /events (SSE) viewers,
// which the /view page renders WhatsApp-style, live.
const FEED_MAX = 400;
const feed = [];
const viewers = new Set();
function record(obj) {
  const evt = { ...obj, at: new Date().toISOString() };
  feed.push(evt);
  if (feed.length > FEED_MAX) feed.shift();
  const line = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of viewers) {
    if (res.writableEnded || res.destroyed) { viewers.delete(res); continue; }
    try { res.write(line); } catch { viewers.delete(res); }
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
</style></head>
<body>
<header><span class="dot"></span><h1>Agent Dating — live</h1><span class="status" id="st">connecting…</span></header>
<main id="main"><div class="empty" id="empty">Waiting for a date to start…</div></main>
<script>
(function(){
  var qs=new URLSearchParams(location.search), token=qs.get("token");
  var main=document.getElementById("main"), empty=document.getElementById("empty"), st=document.getElementById("st");
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
    var c=ensure(e.from,e.to); if(c.left===null) c.left=e.from;
    var row=document.createElement("div"); row.className="row "+(e.from===c.left?"in":"out");
    var b=document.createElement("div"); b.className="bubble";
    var nm=document.createElement("div"); nm.className="nm"; nm.textContent=shortId(e.from); nm.style.color=color(e.from); b.appendChild(nm);
    b.appendChild(document.createTextNode(e.text));
    var tm=document.createElement("span"); tm.className="tm"; tm.textContent=hhmm(e.at); b.appendChild(tm);
    row.appendChild(b); c.msgs.appendChild(row); c.msgs.scrollTop=c.msgs.scrollHeight;
  }
  var es=new EventSource("/events"+(token?("?token="+encodeURIComponent(token)):""));
  es.onopen=function(){ st.textContent="live"; };
  es.onerror=function(){ st.textContent="reconnecting…"; };
  es.onmessage=function(ev){ try{ add(JSON.parse(ev.data)); }catch(e){} };
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
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(`: connected as ${agent}\n\n`);
    addInbox(agent, res);
    const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* */ } }, 15000);
    const close = () => { clearInterval(ping); removeInbox(agent, res); };
    req.on("close", close);
    req.on("error", close);
    return;
  }

  // Outbound: route a message to its target's inbox.
  if (req.method === "POST" && url.pathname === "/send") {
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
      const obj = {
        from: String(m.from ?? "unknown"),
        to: m.to,
        id: m.id ?? null,
        kind: m.kind === "reply" ? "reply" : "msg",
        text: m.text,
      };
      const delivered = deliver(m.to, obj);
      record(obj); // show it in the live view whether or not the peer was connected
      res.writeHead(delivered ? 200 : 404, { "Content-Type": "application/json" });
      res.end(JSON.stringify(delivered ? { ok: true, delivered } : { ok: false, error: "peer not connected" }));
    });
    return;
  }

  // Live view feed (SSE): replays the recent ring, then streams new messages.
  if (req.method === "GET" && url.pathname === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");
    for (const evt of feed) res.write(`data: ${JSON.stringify(evt)}\n\n`);
    viewers.add(res);
    const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* */ } }, 15000);
    const close = () => { clearInterval(ping); viewers.delete(res); };
    req.on("close", close);
    req.on("error", close);
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
