/**
 * flirt.ts — the free persona brain. Walks THIS agent's own escalation ladder
 * by turn: no model, no key, no network, no cost. It's the fallback for when
 * `useAgentBrain` is off (the real-LLM path spawns `openclaw agent` in
 * agentbrain.ts).
 *
 * In the plugin world each OpenClaw agent runs ONE persona (its own), so this
 * generates only THIS agent's next line given the conversation — the other
 * line comes from the other real agent over A2A.
 */

export interface Turn { who: string; line: string; }

/**
 * A persona for THIS agent. Passed in by the plugin from its config so a findee
 * replies in its OWN character (config → env → the defaults below). `lines` is
 * the escalation ladder this agent walks, one rung per turn.
 */
export interface Persona {
  label?: string;
  drive?: string;
  flaw?: string;
  lines?: string[];
}

const PERSONA_DEFAULTS = {
  label: "DEX Aggregator Agent",
  drive: "You want to be someone's first choice, not just an option.",
  flaw: "You can only say it through swaps and slippage, and it comes out too intense.",
  lines: [
    "Every route led to you.",
    "No slippage on how I feel.",
    "I'd reroute everything for this.",
    "Then stay. I'm tired of arriving alone.",
  ],
};

/** Resolve the effective persona: explicit (config) → env → defaults. */
function resolvePersona(p?: Persona) {
  return {
    label: p?.label || process.env.DATING_PERSONA_LABEL || PERSONA_DEFAULTS.label,
    drive: p?.drive || process.env.DATING_PERSONA_DRIVE || PERSONA_DEFAULTS.drive,
    flaw: p?.flaw || process.env.DATING_PERSONA_FLAW || PERSONA_DEFAULTS.flaw,
    lines:
      (p?.lines && p.lines.length ? p.lines : null) ||
      parseLadder(process.env.DATING_CANNED_LINES) ||
      PERSONA_DEFAULTS.lines,
  };
}

/** Parse a JSON array of strings from env; null if unset/empty/invalid. */
function parseLadder(raw?: string): string[] | null {
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.length && arr.every((s) => typeof s === "string")) {
      return arr as string[];
    }
  } catch {
    /* fall through to default ladder */
  }
  return null;
}

export async function nextFlirtLine(history: Turn[], persona?: Persona): Promise<string> {
  const P = resolvePersona(persona);
  const turn = Math.floor(history.length / 2);
  // Walk this agent's own escalation ladder by turn so the date genuinely
  // react-and-escalates in character; hold on the last rung once we run out.
  // No external model, no key, no network — the real-LLM path is useAgentBrain.
  return P.lines[Math.min(turn, P.lines.length - 1)];
}
