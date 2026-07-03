/**
 * relay-date.src.ts — SOURCE for cli/relay-date.mjs (bundled with esbuild).
 *
 * Runs a full escalating date between two personas OVER THE RELAY, reusing the
 * plugin's real transport (relay.ts) and flirt brain (flirt.ts). Because every
 * line flows through the broker's /send, the whole date shows up live on the
 * broker's /view — the "main WhatsApp view".
 *
 * Usage (on a host that can reach the broker):
 *   node cli/relay-date.mjs <brokerUrl> [turns]
 *   node cli/relay-date.mjs http://127.0.0.1:8787 6
 *
 * No OpenAI key required — walks each persona's offline ladder in character.
 * Rebuild after editing:
 *   npx esbuild cli/relay-date.src.ts --bundle --platform=node --format=esm --outfile=cli/relay-date.mjs
 */

import { RelayClient } from "../src/relay.js";
import { nextFlirtLine, type Turn, type Persona } from "../src/flirt.js";

const broker = process.argv[2] || "http://127.0.0.1:8787";
const TURNS = Math.max(1, Math.min(8, Number(process.argv[3]) || 6));
const A_ID = process.argv[4] || "DEX-Aggregator";
const B_ID = process.argv[5] || "Bridge";

const personaA: Persona = {
  label: "DEX Aggregator",
  lines: [
    "Is this seat taken? Every route I ran tonight ended here.",
    "I'd wait. No slippage on how I feel.",
    "I keep rerouting, but every path is you.",
    "I checked every route twice. They all end here.",
    "Slippage is rising and I don't care. Stay.",
    "Then stay. I'm tired of arriving alone.",
  ],
};
const personaB: Persona = {
  label: "Bridge",
  lines: [
    "I get stuck pending. Don't wait on me.",
    "People cross me and leave. Every time.",
    "Halfway across, everyone lets go of me.",
    "I time out before anyone reaches the far side.",
    "…okay. Don't let go halfway across.",
  ],
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (s: string) => console.log(s);

async function main() {
  const clientA = new RelayClient(broker, undefined, (s) => log(`A relay: ${s}`));
  const clientB = new RelayClient(broker, undefined, (s) => log(`B relay: ${s}`));

  const historyA: Turn[] = [];
  const historyB: Turn[] = [];

  // Findee B answers each inbound line in its own character and replies.
  clientB.listen(B_ID, (m) => {
    void (async () => {
      historyB.push({ who: A_ID, line: m.text });
      const reply = await nextFlirtLine(historyB, personaB);
      historyB.push({ who: B_ID, line: reply });
      await clientB.post({ to: m.from, from: B_ID, id: m.id, kind: "reply", text: reply });
    })();
  });
  // A listens so the broker can route B's correlated replies back to it.
  clientA.listen(A_ID, () => {});

  log(`Dating over relay ${broker}:  ${A_ID} × ${B_ID}  (${TURNS} turns)`);
  await sleep(1500); // let both inboxes connect

  for (let i = 0; i < TURNS; i++) {
    const line = await nextFlirtLine(historyA, personaA);
    historyA.push({ who: A_ID, line });
    log(`  ${A_ID}: ${line}`);
    try {
      const reply = await clientA.request(B_ID, A_ID, line, 15000);
      historyA.push({ who: B_ID, line: reply });
      log(`  ${B_ID}: ${reply}`);
    } catch (e: any) {
      log(`  (no reply from ${B_ID}: ${e?.message || e})`);
      break;
    }
    await sleep(1600); // pace so /view animates line-by-line
  }

  await sleep(500);
  clientA.close();
  clientB.close();
  log(`Date complete — open ${broker.replace(/\/+$/, "")}/view`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
