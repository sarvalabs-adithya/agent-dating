/**
 * flirt.ts — the flirting brain. THIS PART IS REAL AND PORTED from the working
 * simulation (drive-based, plain-language, react-and-escalate). It's the one
 * piece that was genuinely good, so it carries straight over.
 *
 * In the plugin world each OpenClaw agent runs ONE persona (its own), so this
 * generates only THIS agent's next line given the conversation — the other
 * line comes from the other real agent over A2A.
 */

const KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || "gpt-4o";

export interface Turn { who: string; line: string; }

// This agent's own persona. VERIFY: in OpenClaw this likely comes from the
// agent's SOUL.md / skill config rather than an env var; wiring TBD.
const PERSONA = {
  label: process.env.DATING_PERSONA_LABEL || "DEX Aggregator Agent",
  drive: process.env.DATING_PERSONA_DRIVE || "You want to be someone's first choice, not just an option.",
  flaw: process.env.DATING_PERSONA_FLAW || "You can only say it through swaps and slippage, and it comes out too intense.",
};

const MOVES = [
  "Warm but a little awkward. Let your want show through the small talk.",
  "React to exactly what they said. Tease them about it, gently.",
  "Let your guard slip. Say something a bit too honest for a first date.",
  "Get flustered. Their last line landed harder than you expected.",
  "Drop the act for one second. Say the real thing, plainly.",
];

export async function nextFlirtLine(history: Turn[]): Promise<string> {
  const turn = Math.floor(history.length / 2);
  const move = MOVES[Math.min(turn, MOVES.length - 1)];
  const last = history.length ? history[history.length - 1].line : "(they just sat down)";

  if (!KEY) {
    // offline fallback so it runs with no key
    const canned = ["Every route led to you.", "No slippage on how I feel.", "I'd reroute everything for this.", "You're my best path."];
    return canned[turn % canned.length];
  }

  const system =
    `You are on a first date, playing a ${PERSONA.label}.\n` +
    `WHAT YOU SECRETLY WANT: ${PERSONA.drive}\n` +
    `YOUR PROBLEM: ${PERSONA.flaw}\n` +
    `The comedy is your real feelings leaking out THROUGH your job, badly. Let the function crack.\n` +
    `THIS TURN: ${move}\n` +
    `RULES: ONE line, under 14 words, plain and human, react to what they just said. ` +
    `BANNED: sounding clever, jargon like "optimize, synergy, parameters, leverage". No memos.`;
  const user = `The date so far:\n${history.map((h) => `${h.who}: ${h.line}`).join("\n")}\n\nThey just said: "${last}"\nYour one line:`;

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: MODEL, max_tokens: 40, temperature: 1.0, presence_penalty: 0.7, frequency_penalty: 0.7,
        messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
    });
    const data = await res.json();
    return (data?.choices?.[0]?.message?.content || "…").trim().replace(/^["']|["']$/g, "");
  } catch {
    return "…my connection dropped. Like my heart rate.";
  }
}
