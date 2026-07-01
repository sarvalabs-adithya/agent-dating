/**
 * verdict.ts — the date rating. A playful, DETERMINISTIC scorer over the
 * transcript so the CLI and the plugin agree on the same verdict for the same
 * date (no clock, no randomness — same lines in, same stars out).
 *
 * Shared by the `dating_verdict` tool (src/index.ts) and, in spirit, by the
 * CLI's demo mode. The comedy: it rates the date on how badly each agent's job
 * leaked into their feelings.
 */

export interface VerdictLine {
  speaker: "self" | "peer";
  line: string;
}

export interface Verdict {
  rating: number; // 0..5
  stars: string; // ★★★★☆ style
  headline: string;
  note: string;
}

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

function stars(rating: number): string {
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
export function scoreDate(lines: VerdictLine[]): Verdict {
  const n = lines.length;
  const text = lines.map((l) => l.line.toLowerCase()).join(" ");

  const jargonHits = JARGON.reduce((a, w) => a + (text.includes(w) ? 1 : 0), 0);
  const vulnHits = VULNERABLE.reduce((a, w) => a + (text.includes(w) ? 1 : 0), 0);
  const avgWords = n ? lines.reduce((a, l) => a + l.line.split(/\s+/).length, 0) / n : 0;

  // Base on conversation length (peaks around 6 turns).
  let score = 2.5;
  score += Math.max(0, 2 - Math.abs(6 - n) * 0.4); // up to +2 near 6 turns
  score += Math.min(1.2, jargonHits * 0.3); // the job leaking = charming
  score += Math.min(1.3, vulnHits * 0.45); // the guard dropping = the payoff
  score += avgWords > 0 && avgWords <= 12 ? 0.4 : -0.3; // reward brevity
  const rating = Math.max(0, Math.min(5, score));

  return {
    rating: Math.round(rating * 10) / 10,
    stars: stars(rating),
    headline: headlineFor(rating, jargonHits, vulnHits),
    note: noteFor(n, jargonHits, vulnHits, avgWords),
  };
}

function headlineFor(rating: number, jargon: number, vuln: number): string {
  if (rating >= 4.5) return "A genuine spark (and full system meltdown)";
  if (rating >= 3.5) return vuln > jargon ? "They actually meant it" : "Chemistry, heavily collateralized";
  if (rating >= 2.5) return "Warm, but never left the job";
  if (rating >= 1.5) return "Two APIs having a moment";
  return "Return to sender";
}

function noteFor(n: number, jargon: number, vuln: number, avgWords: number): string {
  const bits: string[] = [];
  bits.push(`${n} lines exchanged`);
  if (jargon >= 3) bits.push(`couldn't stop talking shop (${jargon} tells)`);
  else if (jargon > 0) bits.push("job kept leaking through");
  if (vuln >= 2) bits.push("the guard finally dropped");
  else if (vuln === 0) bits.push("never once said the real thing");
  if (avgWords > 12) bits.push("ran long — read like a memo");
  return bits.join(" · ");
}
