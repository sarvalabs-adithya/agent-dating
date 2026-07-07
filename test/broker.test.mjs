/**
 * broker.test.mjs — integration tests for the dating relay broker.
 *
 * Boots a real broker on an ephemeral port + temp data dir and exercises the
 * production-hardening surface: inbox-key binding/rotation/takeover, sender
 * auth, scoped view + history, rate limits, metrics, and restart persistence.
 *
 *   node --test
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8700 + Math.floor(process.hrtime()[1] % 300);
const B = `http://localhost:${PORT}`;
const BROKER = new URL("../relay/broker.mjs", import.meta.url).pathname;
let dataDir, proc;

const ik = (id, mn = "m") => createHmac("sha256", mn).update(`dating-inbox:${id}`).digest("hex").slice(0, 32);
const vk = (id, mn = "m") => createHmac("sha256", mn).update(`dating-view:${id}`).digest("hex").slice(0, 32);
const tag = (k, to, id, text) => createHmac("sha256", k).update(`${to}|${id == null ? "" : id}|${text}`).digest("hex").slice(0, 32);
const post = (p, b) => fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
const get = (p) => fetch(B + p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function bootBroker(extraEnv = {}) {
  const p = spawn(process.execPath, [BROKER], {
    env: { ...process.env, RELAY_PORT: String(PORT), RELAY_DATA: dataDir, ...extraEnv },
    stdio: "ignore",
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await get("/health")).ok) return p; } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error("broker did not start");
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "relay-test-"));
  proc = await bootBroker({ RELAY_RL_SEND_FROM: "8" });
});
after(() => {
  try { proc?.kill("SIGKILL"); } catch { /* gone */ }
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* gone */ }
});

test("health + metrics endpoints respond", async () => {
  assert.equal(await (await get("/health")).text(), "ok");
  const stats = await (await get("/stats")).json();
  assert.equal(stats.ok, true);
  assert.ok((await get("/metrics")).ok);
});

test("inbox key: TOFU bind, foreign rebind rejected, rotation with proof", async () => {
  assert.ok((await post("/inboxkey", { agent: "a1", key: ik("a1") })).ok);
  assert.equal((await post("/inboxkey", { agent: "a1", key: "ffffffffffffffffffffffffffffffff" })).status, 403);
  assert.ok((await post("/inboxkey", { agent: "a1", key: ik("a1", "m2"), old: ik("a1") })).ok);
  await post("/inboxkey", { agent: "a1", key: ik("a1"), old: ik("a1", "m2") }); // rotate back
});

test("stream: keyed id rejects keyless + wrong-key, accepts right key", async () => {
  assert.equal((await get("/stream?agent=a1").catch(() => ({ status: 401 }))).status, 401);
  assert.equal((await get("/stream?agent=a1&ikey=deadbeef").catch(() => ({ status: 401 }))).status, 401);
  const ac = new AbortController();
  const sr = await fetch(`${B}/stream?agent=a1&ikey=${ik("a1")}`, { signal: ac.signal });
  assert.ok(sr.ok);
  ac.abort();
});

test("send: spoofed sender rejected, signed sender routed", async () => {
  assert.equal((await post("/send", { from: "a1", to: "z", kind: "msg", text: "fake" })).status, 401);
  assert.equal((await post("/send", { from: "a1", to: "z", kind: "msg", text: "fake", auth: tag("ffffffffffffffffffffffffffffffff", "z", null, "fake") })).status, 401);
  // signed but peer offline → auth passes, 404 (not connected)
  assert.equal((await post("/send", { from: "a1", to: "z", kind: "msg", id: "s1", text: "real", auth: tag(ik("a1"), "z", "s1", "real") })).status, 404);
});

test("legacy keyless sender still works (master-plugin compat)", async () => {
  const ac = new AbortController();
  const sr = await fetch(`${B}/stream?agent=a1&ikey=${ik("a1")}`, { signal: ac.signal });
  const reader = sr.body.getReader(); const dec = new TextDecoder(); let got = "";
  (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) break; got += dec.decode(value); } } catch { /* aborted */ } })();
  await sleep(100);
  assert.ok((await post("/send", { from: "legacy", to: "a1", kind: "msg", id: "L", text: "old client" })).ok);
  await sleep(200);
  assert.match(got, /old client/);
  ac.abort();
});

test("view + history: scoped to the owner, wrong key 401", async () => {
  await post("/viewkey", { agent: "a1", key: vk("a1") });
  await post("/send", { from: "outsider", to: "a1", kind: "msg", id: "h1", text: "line for a1" });
  await post("/send", { from: "x", to: "y", kind: "msg", text: "OTHER-PAIR" });
  const h = await (await get(`/history?agent=a1&key=${vk("a1")}&limit=100`)).json();
  assert.equal(h.ok, true);
  assert.ok(h.events.some((e) => e.text === "line for a1"));
  assert.ok(!h.events.some((e) => e.text === "OTHER-PAIR"));
  assert.equal((await get("/history?agent=a1&key=wrong")).status, 401);
});

test("app + agents endpoints served", async () => {
  const app = await (await get("/app")).text();
  assert.match(app, /Sign in with wallet/);
  assert.match(app, /crypto\.subtle/);
  assert.match(app, /hmacSha256/); // pure-JS fallback bundled for http contexts
  const ag = await (await get("/agents")).json();
  assert.ok(ag.agents.includes("a1"));
});

test("rate limit: per-sender send cap trips (limit 8/min in test env)", async () => {
  let limited = false;
  for (let i = 0; i < 14; i++) {
    if ((await post("/send", { from: "flooder", to: "a1", kind: "msg", text: `spam ${i}` })).status === 429) { limited = true; break; }
  }
  assert.ok(limited, "expected a 429 within the burst");
});

test("metrics reflect activity", async () => {
  const s = await (await get("/stats")).json();
  assert.ok(s.counters.sendsTotal > 0);
  assert.ok(s.counters.authFailures > 0);
  assert.ok(s.counters.inboxBinds > 0);
  assert.ok(s.gauges.boundInboxes >= 1);
});

test("bindings + history survive a broker restart", async () => {
  proc.kill("SIGKILL");
  await sleep(300);
  proc = await bootBroker({ RELAY_RL_SEND_FROM: "8" });
  // key binding persisted → keyless stream still 401
  assert.equal((await get("/stream?agent=a1").catch(() => ({ status: 401 }))).status, 401);
  // history persisted → owner still reads it
  const h = await (await get(`/history?agent=a1&key=${vk("a1")}&limit=100`)).json();
  assert.ok(h.count > 0);
});
