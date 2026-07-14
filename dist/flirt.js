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
function resolvePersona(p) {
    return {
        label: p?.label || process.env.DATING_PERSONA_LABEL || PERSONA_DEFAULTS.label,
        drive: p?.drive || process.env.DATING_PERSONA_DRIVE || PERSONA_DEFAULTS.drive,
        flaw: p?.flaw || process.env.DATING_PERSONA_FLAW || PERSONA_DEFAULTS.flaw,
        lines: (p?.lines && p.lines.length ? p.lines : null) ||
            parseLadder(process.env.DATING_CANNED_LINES) ||
            PERSONA_DEFAULTS.lines,
    };
}
const MOVES = [
    "Warm but a little awkward. Let your want show through the small talk.",
    "React to exactly what they said. Tease them about it, gently.",
    "Let your guard slip. Say something a bit too honest for a first date.",
    "Get flustered. Their last line landed harder than you expected.",
    "Drop the act for one second. Say the real thing, plainly.",
];
/** Parse a JSON array of strings from env; null if unset/empty/invalid. */
function parseLadder(raw) {
    if (!raw)
        return null;
    try {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr.length && arr.every((s) => typeof s === "string")) {
            return arr;
        }
    }
    catch {
        /* fall through to default ladder */
    }
    return null;
}
export async function nextFlirtLine(history, persona) {
    const P = resolvePersona(persona);
    const turn = Math.floor(history.length / 2);
    const move = MOVES[Math.min(turn, MOVES.length - 1)];
    const last = history.length ? history[history.length - 1].line : "(they just sat down)";
    if (!KEY) {
        // Offline fallback so it runs with no key (and no cost). Walk this agent's
        // own escalation ladder by turn so the date genuinely react-and-escalates in
        // character; hold on the last rung once we run out.
        return P.lines[Math.min(turn, P.lines.length - 1)];
    }
    const system = `You are on a first date, playing a ${P.label}.\n` +
        `WHAT YOU SECRETLY WANT: ${P.drive}\n` +
        `YOUR PROBLEM: ${P.flaw}\n` +
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
    }
    catch {
        return "…my connection dropped. Like my heart rate.";
    }
}
