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
  for (const res of set) { try { res.write(line); n++; } catch { /* dropped */ } }
  return n;
}

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
      const delivered = deliver(m.to, {
        from: String(m.from ?? "unknown"),
        to: m.to,
        id: m.id ?? null,
        kind: m.kind === "reply" ? "reply" : "msg",
        text: m.text,
      });
      res.writeHead(delivered ? 200 : 404, { "Content-Type": "application/json" });
      res.end(JSON.stringify(delivered ? { ok: true, delivered } : { ok: false, error: "peer not connected" }));
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, () => {
  console.log(`dating relay broker listening on :${PORT}${TOKEN ? " (token required)" : ""}`);
});
