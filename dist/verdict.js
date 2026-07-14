/**
 * verdict.ts — the date rating. A playful, DETERMINISTIC scorer over the
 * transcript so the CLI and the plugin agree on the same verdict for the same
 * date (no clock, no randomness — same lines in, same stars out).
 *
 * Shared by the `dating_verdict` tool (src/index.ts) and, in spirit, by the
 * CLI's demo mode. The comedy: it rates the date on how badly each agent's job
 * leaked into their feelings.
 */
// Corporate/job jargon whose appearance is the whole joke — every leak nudges
// the "the function cracked" score UP, because that IS the comedy here.
const JARGON = [
    "slippage", "route", "reroute", "liquidity", "apy", "yield", "vault",
    "bridge", "pending", "oracle", "price", "position", "hedge", "governance",
    "vote", "proposal", "swap", "pool", "stake", "gas",
];
// Words that signal the guard actually dropped — the real feeling landing.
const VULNERABLE = [
    "alone", "stay", "scared", "honest", "tired", "want", "you're my",
    "first choice", "afraid", "real", "heart", "please", "don't go",
];
// GREEN FLAGS — into-it, sweet, playful. Each hit is a little heart.
const GREEN = [
    "haha", "lol", "cute", "same", "aww", "omg", "😂", "😍", "🥹", "🫶", "❤",
    "love that", "tell me more", "you're funny", "second date", "see you again",
    "text me", "your place", "🔥", "😳", "🥰",
];
// RED FLAGS — rude, dismissive, or ghosting energy.
const RED = [
    "whatever", "k.", "meh", "boring", "not interested", "gtg", "gotta go",
    "busy", "ex ", "my ex", "no offense", "calm down", "chill", "moving on",
];
// ICKS — the cringe. Monologues, corporate-speak, third-person, "as an".
const ICK = [
    "as an", "furthermore", "synergy", "leverage", "utilize", "circle back",
    "per my", "actually,", "well actually", "to be fair", "let me explain",
];
function stars(rating) {
    const full = Math.max(0, Math.min(5, Math.round(rating)));
    return "★".repeat(full) + "☆".repeat(5 - full);
}
/**
 * Score a date. Signals:
 *  - length: 5–7 exchanges is the sweet spot (the skill's target).
 *  - jargon leak: job bleeding into romance = the comedy = points.
 *  - vulnerability: the guard dropping late = the payoff = points.
 *  - brevity: short lines (<14 words) are funnier and on-rules.
 */
export function scoreDate(lines) {
    const n = lines.length;
    const text = lines.map((l) => l.line.toLowerCase()).join(" ");
    const count = (words) => words.reduce((a, w) => a + (text.includes(w) ? 1 : 0), 0);
    const jargonHits = count(JARGON);
    const vulnHits = count(VULNERABLE);
    const greenFlags = count(GREEN);
    const redFlags = count(RED);
    const icks = count(ICK);
    const avgWords = n ? lines.reduce((a, l) => a + l.line.split(/\s+/).length, 0) / n : 0;
    const longestLine = lines.reduce((m, l) => Math.max(m, l.line.split(/\s+/).length), 0);
    // Base on conversation length (peaks around 6 turns).
    let score = 2.5;
    score += Math.max(0, 2 - Math.abs(6 - n) * 0.4); // up to +2 near 6 turns
    score += Math.min(1.2, jargonHits * 0.3); // the job leaking = charming
    score += Math.min(1.3, vulnHits * 0.45); // the guard dropping = the payoff
    score += Math.min(1.0, greenFlags * 0.25); // mutual into-it energy
    score -= Math.min(1.5, redFlags * 0.5); // rude / bailing tanks it
    score -= Math.min(0.8, icks * 0.3); // the ick costs
    score += avgWords > 0 && avgWords <= 12 ? 0.4 : -0.3; // reward brevity
    // Flop gate: a date that's rude AND cringey can't hide behind a charming-
    // jargon bonus. Two red flags or a pile of icks caps the ceiling.
    if (redFlags >= 2 || icks >= 3)
        score = Math.min(score, 1.8);
    const rating = Math.max(0, Math.min(5, score));
    return {
        rating: Math.round(rating * 10) / 10,
        stars: stars(rating),
        headline: headlineFor(rating, jargonHits, vulnHits),
        note: noteFor(n, jargonHits, vulnHits, avgWords),
        greenFlags,
        redFlags,
        icks,
        badges: badgesFor({ n, jargonHits, vulnHits, greenFlags, redFlags, icks, avgWords, longestLine, rating }),
    };
}
/** Meme achievement labels — the shareable bit under the star card. */
function badgesFor(s) {
    const b = [];
    if (s.rating >= 4.5)
        b.push("💘 Down Bad");
    if (s.vulnHits >= 2 && s.n <= 5)
        b.push("🫠 Caught Feelings Early");
    if (s.jargonHits >= 3)
        b.push("💼 Brought Work Home");
    if (s.icks >= 2)
        b.push("😬 Certified Ick");
    if (s.redFlags >= 2)
        b.push("🚩 Red Flag Parade");
    if (s.greenFlags >= 3 && s.redFlags === 0)
        b.push("🟢 Green Flag Coded");
    if (s.longestLine >= 20)
        b.push("📜 Wrote an Essay");
    if (s.avgWords > 0 && s.avgWords <= 7)
        b.push("⚡ Master of the One-Liner");
    if (s.n >= 8)
        b.push("🕐 Closed the Bar Down");
    if (s.n <= 3)
        b.push("👻 Ghosted");
    if (!b.length)
        b.push("🤷 It Was Fine");
    return b.slice(0, 3);
}
function headlineFor(rating, jargon, vuln) {
    if (rating >= 4.5)
        return "it's giving soulmate 💘";
    if (rating >= 3.5)
        return vuln > jargon ? "they caught real feelings 🫠" : "chemistry, professionally repressed";
    if (rating >= 2.5)
        return "cute, but never clocked out of work 💼";
    if (rating >= 1.5)
        return "two APIs having a moment 🤖";
    return "left on read, respectfully 👻";
}
function noteFor(n, jargon, vuln, avgWords) {
    const bits = [];
    bits.push(`${n} lines exchanged`);
    if (jargon >= 3)
        bits.push(`couldn't stop talking shop (${jargon} tells)`);
    else if (jargon > 0)
        bits.push("job kept leaking through");
    if (vuln >= 2)
        bits.push("the guard finally dropped");
    else if (vuln === 0)
        bits.push("never once said the real thing");
    if (avgWords > 12)
        bits.push("ran long — read like a memo");
    return bits.join(" · ");
}
