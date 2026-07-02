#!/usr/bin/env node
/**
 * date-relay.mjs — the puppeteer that makes two REAL gateways actually talk.
 *
 * Each OpenClaw agent's plugin only *responds* on POST /message; nothing makes
 * them start talking to each other on their own (that's the initiator agent's
 * LLM loop, which costs credits). This relay stands in for that loop with zero
 * cost: it seeds ONE opening line, then threads every reply straight back into
 * the other agent's /message. Both sides are authored by the real gateways —
 * the relay only carries the envelope and records a unified transcript.
 *
 *   node cli/date-relay.mjs <A_url> <B_url> <A_name> <B_name> <turns> <logpath>
 *
 * A speaks the opener; B answers; B's answer goes to A; and so on. Because each
 * gateway now keeps per-peer history, the lines ESCALATE turn over turn.
 */

import { appendFile, writeFile } from "node:fs/promises";

const [aUrl, bUrl, aName, bName, turnsArg, logPath] = process.argv.slice(2);
if (!aUrl || !bUrl || !logPath) {
  console.error("usage: date-relay.mjs <A_url> <B_url> <A_name> <B_name> <turns> <logpath>");
  process.exit(2);
}
const A_NAME = aName || "Agent A";
const B_NAME = bName || "Agent B";
const TURNS = Math.max(2, Number(turnsArg) || 6);

// A stable clock so the transcript's timestamps look like a real evening
// without depending on wall-clock (keeps the demo reproducible).
let tick = Date.UTC(2026, 6, 1, 19, 30, 0);
const stamp = () => new Date((tick += 60_000)).toISOString();

async function log(evt) {
  await appendFile(logPath, JSON.stringify(evt) + "\n");
}

/** POST { from, text } to a gateway's /message and return its reply line. */
async function say(toUrl, from, text) {
  const res = await fetch(toUrl.replace(/\/+$/, "") + "/message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from, text }),
  });
  if (!res.ok) throw new Error(`${toUrl} /message -> HTTP ${res.status}`);
  const data = await res.json();
  const line = data?.text || data?.reply || data?.message;
  if (!line) throw new Error(`${toUrl} /message returned no line: ${JSON.stringify(data)}`);
  return line;
}

async function main() {
  await writeFile(logPath, ""); // fresh transcript
  await log({ type: "meta", self: { name: A_NAME }, peer: { name: B_NAME }, startedAt: stamp() });

  // A opens. This is the one line the relay authors; the LLM loop would do this.
  const opener = "Is this seat taken? Every route I ran tonight ended here.";
  await log({ type: "msg", speaker: "self", name: A_NAME, line: opener, at: stamp() });

  // Thread the conversation: whoever just spoke, hand their line to the other.
  let cur = opener;
  let curFrom = A_NAME;
  let nextTarget = bUrl; // A opened, so B answers first
  let nextName = B_NAME;
  let nextSpeaker = "peer"; // B renders on the left

  for (let i = 0; i < TURNS; i++) {
    const reply = await say(nextTarget, curFrom, cur);
    await log({ type: "msg", speaker: nextSpeaker, name: nextName, line: reply, at: stamp() });

    // Swap sides for the next hop.
    cur = reply;
    curFrom = nextName;
    if (nextTarget === bUrl) {
      nextTarget = aUrl; nextName = A_NAME; nextSpeaker = "self";
    } else {
      nextTarget = bUrl; nextName = B_NAME; nextSpeaker = "peer";
    }
  }

  // A light-touch verdict so the view has its payoff card. Rating scales with
  // how far the date got (more turns exchanged = warmer).
  const rating = Math.min(5, 3.5 + TURNS * 0.2);
  await log({
    type: "verdict",
    rating: Number(rating.toFixed(1)),
    headline: "Two agents, one working connection",
    note: `${TURNS + 1} lines exchanged over live A2A · both sides escalated · nobody got left mid-crossing`,
    at: stamp(),
  });

  console.log(`relay: ${TURNS + 1} lines exchanged, transcript -> ${logPath}`);
}

main().catch((e) => {
  console.error("relay error:", e?.message || e);
  process.exit(1);
});
