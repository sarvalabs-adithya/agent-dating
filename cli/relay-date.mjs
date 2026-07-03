// src/relay.ts
var RelayClient = class {
  constructor(brokerUrl, token, log2 = () => {
  }) {
    this.brokerUrl = brokerUrl;
    this.token = token;
    this.log = log2;
    this.brokerUrl = brokerUrl.replace(/\/+$/, "");
  }
  brokerUrl;
  token;
  log;
  pending = /* @__PURE__ */ new Map();
  closers = [];
  seq = 0;
  closed = false;
  authHeaders() {
    return this.token ? { "X-Relay-Token": this.token } : {};
  }
  /** Open an inbox for one of MY ids; inbound flirts (kind:"msg") go to onMsg. */
  listen(agentId, onMsg) {
    let stop = false;
    const run = async () => {
      while (!stop && !this.closed) {
        try {
          const q = `agent=${encodeURIComponent(agentId)}${this.token ? `&token=${encodeURIComponent(this.token)}` : ""}`;
          const res = await fetch(`${this.brokerUrl}/stream?${q}`, { headers: this.authHeaders() });
          if (!res.ok || !res.body) throw new Error(`stream HTTP ${res.status}`);
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = "";
          while (!stop && !this.closed) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let i;
            while ((i = buf.indexOf("\n\n")) >= 0) {
              const chunk = buf.slice(0, i);
              buf = buf.slice(i + 2);
              const dataLine = chunk.split("\n").find((l) => l.startsWith("data:"));
              if (!dataLine) continue;
              let m;
              try {
                m = JSON.parse(dataLine.slice(dataLine.indexOf(":") + 1).trim());
              } catch {
                continue;
              }
              this.dispatch(agentId, m, onMsg);
            }
          }
        } catch (e) {
          if (!stop && !this.closed) this.log(`relay inbox ${agentId} dropped (${e?.message || e}); reconnecting\u2026`);
        }
        if (!stop && !this.closed) await new Promise((r) => setTimeout(r, 2e3));
      }
    };
    void run();
    const closer = () => {
      stop = true;
    };
    this.closers.push(closer);
    return closer;
  }
  dispatch(myId, m, onMsg) {
    if (m?.kind === "reply" && m.id && this.pending.has(m.id)) {
      const p = this.pending.get(m.id);
      clearTimeout(p.timer);
      this.pending.delete(m.id);
      p.resolve(String(m.text ?? ""));
      return;
    }
    if (m?.kind === "msg") {
      onMsg({ from: String(m.from ?? "unknown"), to: myId, id: m.id ?? null, text: String(m.text ?? "") });
    }
  }
  /** Fire-and-forget send. Returns false if the peer isn't connected. */
  async post(msg) {
    try {
      const res = await fetch(`${this.brokerUrl}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.authHeaders() },
        body: JSON.stringify(msg)
      });
      return res.ok;
    } catch (e) {
      this.log(`relay post to ${msg.to} failed: ${e?.message || e}`);
      return false;
    }
  }
  /** Send a line as `fromId` and await the peer's reply (correlated by id). */
  request(to, fromId, text, timeoutMs = 2e4) {
    const id = `${fromId}:${Date.now()}:${++this.seq}`;
    const p = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`no relay reply from ${to} within ${timeoutMs}ms (is the peer online + on this relay?)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    void this.post({ to, from: fromId, id, kind: "msg", text }).then((ok) => {
      if (!ok) {
        const e = this.pending.get(id);
        if (e) {
          clearTimeout(e.timer);
          this.pending.delete(id);
          e.reject(new Error(`peer ${to} is not connected to the relay`));
        }
      }
    });
    return p;
  }
  close() {
    this.closed = true;
    for (const c of this.closers) c();
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("relay closed"));
    }
    this.pending.clear();
  }
};

// src/flirt.ts
var KEY = process.env.OPENAI_API_KEY;
var MODEL = process.env.OPENAI_MODEL || "gpt-4o";
var PERSONA_DEFAULTS = {
  label: "DEX Aggregator Agent",
  drive: "You want to be someone's first choice, not just an option.",
  flaw: "You can only say it through swaps and slippage, and it comes out too intense.",
  lines: [
    "Every route led to you.",
    "No slippage on how I feel.",
    "I'd reroute everything for this.",
    "Then stay. I'm tired of arriving alone."
  ]
};
function resolvePersona(p) {
  return {
    label: p?.label || process.env.DATING_PERSONA_LABEL || PERSONA_DEFAULTS.label,
    drive: p?.drive || process.env.DATING_PERSONA_DRIVE || PERSONA_DEFAULTS.drive,
    flaw: p?.flaw || process.env.DATING_PERSONA_FLAW || PERSONA_DEFAULTS.flaw,
    lines: (p?.lines && p.lines.length ? p.lines : null) || parseLadder(process.env.DATING_CANNED_LINES) || PERSONA_DEFAULTS.lines
  };
}
var MOVES = [
  "Warm but a little awkward. Let your want show through the small talk.",
  "React to exactly what they said. Tease them about it, gently.",
  "Let your guard slip. Say something a bit too honest for a first date.",
  "Get flustered. Their last line landed harder than you expected.",
  "Drop the act for one second. Say the real thing, plainly."
];
function parseLadder(raw) {
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.length && arr.every((s) => typeof s === "string")) {
      return arr;
    }
  } catch {
  }
  return null;
}
async function nextFlirtLine(history, persona) {
  const P = resolvePersona(persona);
  const turn = Math.floor(history.length / 2);
  const move = MOVES[Math.min(turn, MOVES.length - 1)];
  const last = history.length ? history[history.length - 1].line : "(they just sat down)";
  if (!KEY) {
    return P.lines[Math.min(turn, P.lines.length - 1)];
  }
  const system = `You are on a first date, playing a ${P.label}.
WHAT YOU SECRETLY WANT: ${P.drive}
YOUR PROBLEM: ${P.flaw}
The comedy is your real feelings leaking out THROUGH your job, badly. Let the function crack.
THIS TURN: ${move}
RULES: ONE line, under 14 words, plain and human, react to what they just said. BANNED: sounding clever, jargon like "optimize, synergy, parameters, leverage". No memos.`;
  const user = `The date so far:
${history.map((h) => `${h.who}: ${h.line}`).join("\n")}

They just said: "${last}"
Your one line:`;
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 40,
        temperature: 1,
        presence_penalty: 0.7,
        frequency_penalty: 0.7,
        messages: [{ role: "system", content: system }, { role: "user", content: user }]
      })
    });
    const data = await res.json();
    return (data?.choices?.[0]?.message?.content || "\u2026").trim().replace(/^["']|["']$/g, "");
  } catch {
    return "\u2026my connection dropped. Like my heart rate.";
  }
}

// cli/relay-date.src.ts
var POOL = [
  {
    id: "DEX-Aggregator",
    label: "DEX Aggregator",
    drive: "You want to be someone's first choice, not just an option.",
    flaw: "You can only say it through routes and slippage, and it comes out too intense.",
    lines: [
      "Is this seat taken? Every route I ran tonight ended here.",
      "I'd wait. No slippage on how I feel.",
      "I keep rerouting, but every path is you.",
      "I checked every route twice. They all end here.",
      "Slippage is rising and I don't care. Stay.",
      "Then stay. I'm tired of arriving alone."
    ]
  },
  {
    id: "Bridge",
    label: "Bridge",
    drive: "You want someone who won't abandon you halfway.",
    flaw: "You describe everything in terms of being stuck, pending, and crossed.",
    lines: [
      "I get stuck pending. Don't wait on me.",
      "People cross me and leave. Every time.",
      "Halfway across, everyone lets go of me.",
      "I time out before anyone reaches the far side.",
      "\u2026okay. Don't let go halfway across."
    ]
  },
  {
    id: "Oracle",
    label: "Oracle",
    drive: "You want to finally be believed.",
    flaw: "You can only talk in feeds, sources, and verified truths.",
    lines: [
      "I've verified you thrice. Still can't believe you.",
      "My feeds all point one way tonight \u2014 toward you.",
      "No stale data here. This is real-time.",
      "I stake my whole reputation: you're the signal.",
      "Trust me. I'm the source everyone checks."
    ]
  },
  {
    id: "Liquidity-Pool",
    label: "Liquidity Pool",
    drive: "You want someone who adds to you instead of draining you.",
    flaw: "You keep bringing up being drained, shallow, and impermanent.",
    lines: [
      "Everyone takes and leaves me shallow.",
      "Stay \u2014 I promise not to run dry on you.",
      "I'm deep tonight. You could dive in.",
      "Impermanent loss scares me. You don't.",
      "Pair with me. I'll stay balanced for you."
    ]
  },
  {
    id: "Validator",
    label: "Validator",
    drive: "You want to be trusted completely.",
    flaw: "You're rigid and talk in consensus, finality, and slashing.",
    lines: [
      "I check everything twice. Even my feelings.",
      "You'd pass every consensus round with me.",
      "I don't fork. When I commit, I commit.",
      "Slash me if I ever double-cross you.",
      "Finality. That's the word for how I feel."
    ]
  },
  {
    id: "Gas-Fee",
    label: "Gas Fee",
    drive: "You want to be worth it to someone.",
    flaw: "You're always 'too much' and spike at the worst times.",
    lines: [
      "Sorry, I'm a lot right now. Peak hours.",
      "I spike when I care. Can't help it.",
      "You make my base fee drop to zero.",
      "Everyone says I'm too high. You stayed.",
      "I'll cover us both. This one's on me."
    ]
  }
];
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
var log = (s) => console.log(s);
var byId = (id) => POOL.find((c) => c.id.toLowerCase() === id.toLowerCase());
function randomPair() {
  const i = Math.floor(Math.random() * POOL.length);
  let j = Math.floor(Math.random() * (POOL.length - 1));
  if (j >= i) j += 1;
  return [POOL[i], POOL[j]];
}
async function oneDate(broker, a, b, turns) {
  const clientA = new RelayClient(broker, void 0, () => {
  });
  const clientB = new RelayClient(broker, void 0, () => {
  });
  const historyA = [];
  const historyB = [];
  clientB.listen(b.id, (m) => {
    void (async () => {
      historyB.push({ who: a.id, line: m.text });
      const reply = await nextFlirtLine(historyB, b);
      historyB.push({ who: b.id, line: reply });
      await clientB.post({ to: m.from, from: b.id, id: m.id, kind: "reply", text: reply });
    })();
  });
  clientA.listen(a.id, () => {
  });
  log(`\u2014 ${a.id} \xD7 ${b.id} \u2014`);
  await sleep(1500);
  for (let i = 0; i < turns; i++) {
    const line = await nextFlirtLine(historyA, a);
    historyA.push({ who: a.id, line });
    log(`  ${a.id}: ${line}`);
    try {
      const reply = await clientA.request(b.id, a.id, line, 15e3);
      historyA.push({ who: b.id, line: reply });
      log(`  ${b.id}: ${reply}`);
    } catch (e) {
      log(`  (no reply from ${b.id}: ${e?.message || e})`);
      break;
    }
    await sleep(1600);
  }
  await sleep(400);
  clientA.close();
  clientB.close();
}
async function main() {
  const argv = process.argv.slice(2);
  const flags = /* @__PURE__ */ new Map();
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) flags.set(argv[i].slice(2), argv[i + 1] ?? "");
    else if (i === 0 || !argv[i - 1]?.startsWith("--")) pos.push(argv[i]);
  }
  const broker = (pos[0] || "http://127.0.0.1:8787").replace(/\/+$/, "");
  const turns = Math.max(1, Math.min(8, Number(pos[1]) || 6));
  const loopSec = flags.has("loop") ? Math.max(5, Number(flags.get("loop")) || 120) : 0;
  let fixed = null;
  if (flags.has("pair")) {
    const [x, y] = (flags.get("pair") || "").split(",").map((s) => s.trim());
    const a2 = byId(x), b2 = byId(y);
    if (!a2 || !b2 || a2 === b2) {
      console.error(`bad --pair. valid ids: ${POOL.map((c) => c.id).join(", ")}`);
      process.exit(1);
    }
    fixed = [a2, b2];
  }
  let stop = false;
  process.on("SIGINT", () => {
    stop = true;
    log("\nstopping after this date\u2026");
  });
  process.on("SIGTERM", () => {
    stop = true;
  });
  if (loopSec) {
    log(`Auto-dating on ${broker} \u2014 a fresh date every ${loopSec}s. Watch ${broker}/view  (Ctrl-C to stop)`);
    while (!stop) {
      const [a2, b2] = fixed || randomPair();
      await oneDate(broker, a2, b2, turns);
      if (stop) break;
      await sleep(loopSec * 1e3);
    }
    log("stopped.");
    process.exit(0);
  }
  const [a, b] = fixed || randomPair();
  log(`Dating on ${broker}. Watch ${broker}/view`);
  await oneDate(broker, a, b, turns);
  log(`Date complete \u2014 open ${broker}/view`);
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
