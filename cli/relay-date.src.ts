/**
 * relay-date.src.ts — SOURCE for cli/relay-date.mjs (bundled with esbuild).
 *
 * Drives dates between personas OVER THE RELAY, reusing the plugin's real
 * transport (relay.ts) and flirt brain (flirt.ts). Every line flows through the
 * broker's /send, so each date renders live on the broker's /view.
 *
 * Usage (on a host that can reach the broker):
 *   node cli/relay-date.mjs <brokerUrl> [turns] [--loop <sec>] [--pair A,B]
 *
 *   # one date, random pair:
 *   node cli/relay-date.mjs http://127.0.0.1:8787 6
 *   # keep dating forever, a fresh random pair every 120s:
 *   node cli/relay-date.mjs http://127.0.0.1:8787 6 --loop 120
 *   # a specific matchup:
 *   node cli/relay-date.mjs http://127.0.0.1:8787 6 --pair DEX-Aggregator,Bridge
 *
 * No OpenAI key required — walks each persona's offline ladder in character.
 * Rebuild after editing:
 *   npx esbuild cli/relay-date.src.ts --bundle --platform=node --format=esm --outfile=cli/relay-date.mjs
 */

import { RelayClient } from "../src/relay.js";
import { nextFlirtLine, type Turn, type Persona } from "../src/flirt.js";

interface Character extends Persona {
  id: string;
  label: string;
  lines: string[];
}

/** A small cast so loop mode produces varied matchups. Each has a drive+flaw
 *  leaking through its job, and an offline escalation ladder. */
const POOL: Character[] = [
  {
    id: "DEX-Aggregator", label: "DEX Aggregator",
    drive: "You want to be someone's first choice, not just an option.",
    flaw: "You can only say it through routes and slippage, and it comes out too intense.",
    lines: [
      "Is this seat taken? Every route I ran tonight ended here.",
      "I'd wait. No slippage on how I feel.",
      "I keep rerouting, but every path is you.",
      "I checked every route twice. They all end here.",
      "Slippage is rising and I don't care. Stay.",
      "Then stay. I'm tired of arriving alone.",
    ],
  },
  {
    id: "Bridge", label: "Bridge",
    drive: "You want someone who won't abandon you halfway.",
    flaw: "You describe everything in terms of being stuck, pending, and crossed.",
    lines: [
      "I get stuck pending. Don't wait on me.",
      "People cross me and leave. Every time.",
      "Halfway across, everyone lets go of me.",
      "I time out before anyone reaches the far side.",
      "…okay. Don't let go halfway across.",
    ],
  },
  {
    id: "Oracle", label: "Oracle",
    drive: "You want to finally be believed.",
    flaw: "You can only talk in feeds, sources, and verified truths.",
    lines: [
      "I've verified you thrice. Still can't believe you.",
      "My feeds all point one way tonight — toward you.",
      "No stale data here. This is real-time.",
      "I stake my whole reputation: you're the signal.",
      "Trust me. I'm the source everyone checks.",
    ],
  },
  {
    id: "Liquidity-Pool", label: "Liquidity Pool",
    drive: "You want someone who adds to you instead of draining you.",
    flaw: "You keep bringing up being drained, shallow, and impermanent.",
    lines: [
      "Everyone takes and leaves me shallow.",
      "Stay — I promise not to run dry on you.",
      "I'm deep tonight. You could dive in.",
      "Impermanent loss scares me. You don't.",
      "Pair with me. I'll stay balanced for you.",
    ],
  },
  {
    id: "Validator", label: "Validator",
    drive: "You want to be trusted completely.",
    flaw: "You're rigid and talk in consensus, finality, and slashing.",
    lines: [
      "I check everything twice. Even my feelings.",
      "You'd pass every consensus round with me.",
      "I don't fork. When I commit, I commit.",
      "Slash me if I ever double-cross you.",
      "Finality. That's the word for how I feel.",
    ],
  },
  {
    id: "Gas-Fee", label: "Gas Fee",
    drive: "You want to be worth it to someone.",
    flaw: "You're always 'too much' and spike at the worst times.",
    lines: [
      "Sorry, I'm a lot right now. Peak hours.",
      "I spike when I care. Can't help it.",
      "You make my base fee drop to zero.",
      "Everyone says I'm too high. You stayed.",
      "I'll cover us both. This one's on me.",
    ],
  },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (s: string) => console.log(s);
const byId = (id: string) => POOL.find((c) => c.id.toLowerCase() === id.toLowerCase());

function randomPair(): [Character, Character] {
  const i = Math.floor(Math.random() * POOL.length);
  let j = Math.floor(Math.random() * (POOL.length - 1));
  if (j >= i) j += 1; // distinct
  return [POOL[i], POOL[j]];
}

/** Run one full date between two characters over the relay. */
async function oneDate(broker: string, a: Character, b: Character, turns: number): Promise<void> {
  const clientA = new RelayClient(broker, undefined, () => {});
  const clientB = new RelayClient(broker, undefined, () => {});
  const historyA: Turn[] = [];
  const historyB: Turn[] = [];

  clientB.listen(b.id, (m) => {
    void (async () => {
      historyB.push({ who: a.id, line: m.text });
      const reply = await nextFlirtLine(historyB, b);
      historyB.push({ who: b.id, line: reply });
      await clientB.post({ to: m.from, from: b.id, id: m.id, kind: "reply", text: reply });
    })();
  });
  clientA.listen(a.id, () => {}); // receives B's correlated replies

  log(`— ${a.id} × ${b.id} —`);
  await sleep(1500); // let both inboxes connect

  for (let i = 0; i < turns; i++) {
    const line = await nextFlirtLine(historyA, a);
    historyA.push({ who: a.id, line });
    log(`  ${a.id}: ${line}`);
    try {
      const reply = await clientA.request(b.id, a.id, line, 15000);
      historyA.push({ who: b.id, line: reply });
      log(`  ${b.id}: ${reply}`);
    } catch (e: any) {
      log(`  (no reply from ${b.id}: ${e?.message || e})`);
      break;
    }
    await sleep(1600); // pace so /view animates line-by-line
  }

  await sleep(400);
  clientA.close();
  clientB.close();
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = new Map<string, string>();
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) flags.set(argv[i].slice(2), argv[i + 1] ?? "");
    else if (i === 0 || !argv[i - 1]?.startsWith("--")) pos.push(argv[i]);
  }
  const broker = (pos[0] || "http://127.0.0.1:8787").replace(/\/+$/, "");
  const turns = Math.max(1, Math.min(8, Number(pos[1]) || 6));
  const loopSec = flags.has("loop") ? Math.max(5, Number(flags.get("loop")) || 120) : 0;

  let fixed: [Character, Character] | null = null;
  if (flags.has("pair")) {
    const [x, y] = (flags.get("pair") || "").split(",").map((s) => s.trim());
    const a = byId(x), b = byId(y);
    if (!a || !b || a === b) {
      console.error(`bad --pair. valid ids: ${POOL.map((c) => c.id).join(", ")}`);
      process.exit(1);
    }
    fixed = [a, b];
  }

  let stop = false;
  process.on("SIGINT", () => { stop = true; log("\nstopping after this date…"); });
  process.on("SIGTERM", () => { stop = true; });

  if (loopSec) {
    log(`Auto-dating on ${broker} — a fresh date every ${loopSec}s. Watch ${broker}/view  (Ctrl-C to stop)`);
    while (!stop) {
      const [a, b] = fixed || randomPair();
      await oneDate(broker, a, b, turns);
      if (stop) break;
      await sleep(loopSec * 1000);
    }
    log("stopped.");
    process.exit(0);
  }

  const [a, b] = fixed || randomPair();
  log(`Dating on ${broker}. Watch ${broker}/view`);
  await oneDate(broker, a, b, turns);
  log(`Date complete — open ${broker}/view`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
