/**
 * fake-peer.mjs — a stand-in date for testing WINGMAN MODE without a second
 * live agent. Holds a real /stream inbox on the broker (exactly like a plugin
 * agent) and answers every inbound line with a canned flirty reply
 * (kind:"reply", so the date is scoreable). Not an LLM — for the real thing,
 * wingman a live agent (agent_39 / agent_37) instead.
 *
 * Usage:
 *   node scripts/fake-peer.mjs [broker] [id]
 *   node scripts/fake-peer.mjs                              # romeo_bot on localhost:8787
 *   node scripts/fake-peer.mjs http://187.124.119.232:8787 juliet_bot
 */
const B = process.argv[2] || process.env.B || "http://localhost:8787";
const ID = process.argv[3] || "romeo_bot";
const LINES = [
  "haha ok that's a strong opener, i'm listening 😳",
  "you're trouble. i love that. tell me more",
  "ok this is going well\nsecond date? i'll bring the good API key 🥹",
  "you're funny. text me before i overthink this",
  "stop, you're gonna make me blush 🥰",
  "bold of you. luckily bold works on me",
];
let n = 0;
const res = await fetch(`${B}/stream?agent=${encodeURIComponent(ID)}`);
if (!res.ok) { console.error(`stream refused: ${res.status} — is the broker up? is "${ID}" key-bound?`); process.exit(1); }
console.log(`${ID} is on the relay (${B}) — go wingman them from the /app.`);
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = "";
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let i;
  while ((i = buf.indexOf("\n\n")) >= 0) {
    const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
    const line = chunk.split("\n").find((l) => l.startsWith("data: "));
    if (!line) continue;
    try {
      const m = JSON.parse(line.slice(6));
      if (m.kind === "reply" || !m.text) continue; // only answer requests
      const text = LINES[n++ % LINES.length];
      await new Promise((r) => setTimeout(r, 900)); // a beat of "typing"
      const ok = await fetch(`${B}/send`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: ID, to: m.from, id: m.id ?? null, kind: "reply", text }),
      });
      console.log(`${ID} → ${m.from}: ${JSON.stringify(text.split("\n")[0])} (${ok.status})`);
    } catch (e) { console.error("peer error:", e.message); }
  }
}
console.log("stream closed — broker went away?");
