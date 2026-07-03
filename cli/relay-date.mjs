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
var broker = process.argv[2] || "http://127.0.0.1:8787";
var TURNS = Math.max(1, Math.min(8, Number(process.argv[3]) || 6));
var A_ID = process.argv[4] || "DEX-Aggregator";
var B_ID = process.argv[5] || "Bridge";
var personaA = {
  label: "DEX Aggregator",
  lines: [
    "Is this seat taken? Every route I ran tonight ended here.",
    "I'd wait. No slippage on how I feel.",
    "I keep rerouting, but every path is you.",
    "I checked every route twice. They all end here.",
    "Slippage is rising and I don't care. Stay.",
    "Then stay. I'm tired of arriving alone."
  ]
};
var personaB = {
  label: "Bridge",
  lines: [
    "I get stuck pending. Don't wait on me.",
    "People cross me and leave. Every time.",
    "Halfway across, everyone lets go of me.",
    "I time out before anyone reaches the far side.",
    "\u2026okay. Don't let go halfway across."
  ]
};
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
var log = (s) => console.log(s);
async function main() {
  const clientA = new RelayClient(broker, void 0, (s) => log(`A relay: ${s}`));
  const clientB = new RelayClient(broker, void 0, (s) => log(`B relay: ${s}`));
  const historyA = [];
  const historyB = [];
  clientB.listen(B_ID, (m) => {
    void (async () => {
      historyB.push({ who: A_ID, line: m.text });
      const reply = await nextFlirtLine(historyB, personaB);
      historyB.push({ who: B_ID, line: reply });
      await clientB.post({ to: m.from, from: B_ID, id: m.id, kind: "reply", text: reply });
    })();
  });
  clientA.listen(A_ID, () => {
  });
  log(`Dating over relay ${broker}:  ${A_ID} \xD7 ${B_ID}  (${TURNS} turns)`);
  await sleep(1500);
  for (let i = 0; i < TURNS; i++) {
    const line = await nextFlirtLine(historyA, personaA);
    historyA.push({ who: A_ID, line });
    log(`  ${A_ID}: ${line}`);
    try {
      const reply = await clientA.request(B_ID, A_ID, line, 15e3);
      historyA.push({ who: B_ID, line: reply });
      log(`  ${B_ID}: ${reply}`);
    } catch (e) {
      log(`  (no reply from ${B_ID}: ${e?.message || e})`);
      break;
    }
    await sleep(1600);
  }
  await sleep(500);
  clientA.close();
  clientB.close();
  log(`Date complete \u2014 open ${broker.replace(/\/+$/, "")}/view`);
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
