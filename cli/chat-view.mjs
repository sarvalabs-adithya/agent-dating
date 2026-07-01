#!/usr/bin/env node
/**
 * chat-view.mjs — the payoff. A colorful, WhatsApp-style live view of two
 * agents flirting in the terminal.
 *
 * Zero dependencies, no build step — plain Node ESM + ANSI. Reads the JSONL
 * chat log the plugin writes (src/chatlog.ts). Event shapes are duplicated
 * from that file ON PURPOSE so this stays a standalone script.
 *
 * Usage:
 *   node cli/chat-view.mjs --demo                 # scripted date, no gateway
 *   node cli/chat-view.mjs --follow [logpath]     # tail a live date
 *   node cli/chat-view.mjs [logpath]              # render existing log once
 *
 * Log path resolution (follow/once): arg → $AGENT_DATING_CHATLOG →
 * ./agent-dating.chat.jsonl
 *
 * VERIFY (tonight): run `--demo` to eyeball the look; run `--follow` in one
 * terminal while a real `dating_send` date runs in the gateway and confirm the
 * real exchange renders line by line.
 */

import { readFile } from "node:fs/promises";
import { watch, existsSync } from "node:fs";

// ---- ANSI toolkit -----------------------------------------------------------

const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const E = (code) => (useColor ? `\x1b[${code}m` : "");
const RESET = E(0);
const BOLD = E(1);
const DIM = E(2);
const ITALIC = E(3);

// 256-color foreground/background helpers.
const fg = (n) => E(`38;5;${n}`);
const bg = (n) => E(`48;5;${n}`);

// A small palette assigned to speakers. self = warm green (right side),
// peers cycle through a set so multiple dates stay distinct.
const SELF_THEME = { name: fg(15) + BOLD, bubbleBg: bg(29), bubbleFg: fg(15), accent: fg(35) };
const PEER_THEMES = [
  { name: fg(15) + BOLD, bubbleBg: bg(53), bubbleFg: fg(15), accent: fg(177) }, // purple
  { name: fg(15) + BOLD, bubbleBg: bg(24), bubbleFg: fg(15), accent: fg(38) }, // teal
  { name: fg(15) + BOLD, bubbleBg: bg(94), bubbleFg: fg(15), accent: fg(215) }, // amber
];

const cols = () => process.stdout.columns || 80;
const out = (s) => process.stdout.write(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- word wrap (plain text, we control content) -----------------------------

function wrap(text, width) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    if (cur.length === 0) cur = w;
    else if (cur.length + 1 + w.length <= width) cur += " " + w;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

function hhmm(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---- bubble rendering -------------------------------------------------------

/**
 * Render one chat bubble. `side` = "left" (peer) or "right" (self).
 * WhatsApp-ish: colored rounded bubble, name label, time + ✓✓ receipts.
 */
function bubble({ name, line, time, side, theme }) {
  const width = cols();
  const maxBubble = Math.min(46, Math.max(20, width - 18));
  const wrapped = wrap(line, maxBubble - 2);
  const inner = Math.min(maxBubble - 2, Math.max(...wrapped.map((l) => l.length), name.length));

  const pad = (s) => s + " ".repeat(inner - s.length);
  const top = "╭" + "─".repeat(inner + 2) + "╮";
  const bot = "╰" + "─".repeat(inner + 2) + "╯";
  const bodyRows = wrapped.map((l) => `│ ${pad(l)} │`);

  const receipt = side === "right" ? `${theme.accent}${time} ✓✓${RESET}` : `${DIM}${time}${RESET}`;
  const label = `${theme.name}${name}${RESET}`;

  // Colorize bubble box.
  const paint = (s) => `${theme.bubbleBg}${theme.bubbleFg}${s}${RESET}`;
  const rows = [paint(top), ...bodyRows.map(paint), paint(bot)];

  const bubbleWidth = inner + 4;
  const lines = [];
  if (side === "left") {
    lines.push("  " + label);
    for (const r of rows) lines.push("  " + r);
    lines.push("  " + receipt);
  } else {
    const indent = Math.max(0, width - bubbleWidth - 2);
    const sp = " ".repeat(indent);
    lines.push(sp + " ".repeat(Math.max(0, bubbleWidth - name.length)) + label);
    for (const r of rows) lines.push(sp + r);
    const rline = `${time} ✓✓`;
    lines.push(sp + " ".repeat(Math.max(0, bubbleWidth - rline.length)) + receipt);
  }
  return lines.join("\n");
}

async function typing(name, theme, side, ms = 900) {
  if (!process.stdout.isTTY) return;
  const dots = ["·  ", "·· ", "···"];
  const width = cols();
  for (let i = 0; i < Math.ceil(ms / 260); i++) {
    const tag = `${theme.accent}${ITALIC}${name} is typing ${dots[i % 3]}${RESET}`;
    const text = side === "left" ? "  " + tag : " ".repeat(Math.max(0, width - name.length - 16)) + tag;
    out("\r\x1b[2K" + text);
    await sleep(260);
  }
  out("\r\x1b[2K"); // clear the typing line
}

// ---- header + verdict cards -------------------------------------------------

function header(meta) {
  const width = cols();
  const title = " 💘  A G E N T   D A T I N G  💘 ";
  const bar = "═".repeat(width);
  const pad = Math.max(0, Math.floor((width - title.length) / 2));
  out("\n" + fg(211) + bar + RESET + "\n");
  out(" ".repeat(pad) + BOLD + fg(211) + title + RESET + "\n");
  if (meta) {
    const line = `${SELF_THEME.accent}${meta.self?.name || "Me"}${RESET}${DIM}  ✕  ${RESET}${PEER_THEMES[0].accent}${meta.peer?.name || "???"}${RESET}`;
    const plain = `${meta.self?.name || "Me"}  x  ${meta.peer?.name || "???"}`;
    out(" ".repeat(Math.max(0, Math.floor((width - plain.length) / 2))) + line + "\n");
  }
  out(fg(211) + bar + RESET + "\n\n");
}

function starsFor(rating) {
  const full = Math.max(0, Math.min(5, Math.round(rating || 0)));
  return "★".repeat(full) + "☆".repeat(5 - full);
}

function verdictCard(v) {
  const width = cols();
  const boxW = Math.min(54, width - 4);
  const rule = fg(211) + "─".repeat(boxW) + RESET;
  const center = (s, plainLen) => " ".repeat(Math.max(0, Math.floor((boxW - plainLen) / 2))) + s;
  // Plugin verdict events carry only a numeric rating; demo events carry stars.
  v = { ...v, stars: v.stars || starsFor(v.rating) };
  const starsPlain = v.stars || "";
  out("\n");
  out("  " + rule + "\n");
  out("  " + center(`${BOLD}${fg(228)}DATE VERDICT${RESET}`, "DATE VERDICT".length) + "\n");
  out("  " + center(`${fg(220)}${v.stars}${RESET}  ${DIM}${v.rating}/5${RESET}`, starsPlain.length + 6) + "\n");
  out("  " + center(`${BOLD}${fg(15)}${v.headline}${RESET}`, (v.headline || "").length) + "\n");
  if (v.note) out("  " + center(`${DIM}${ITALIC}${v.note}${RESET}`, v.note.length) + "\n");
  out("  " + rule + "\n\n");
}

// ---- rendering an event stream ----------------------------------------------

function makeRenderer() {
  let meta = null;
  let peerThemeIdx = 0;
  const peerThemes = new Map();
  let headerShown = false;

  function themeFor(evt) {
    if (evt.speaker === "self") return SELF_THEME;
    if (!peerThemes.has(evt.name)) {
      peerThemes.set(evt.name, PEER_THEMES[peerThemeIdx % PEER_THEMES.length]);
      peerThemeIdx++;
    }
    return peerThemes.get(evt.name);
  }

  return async function render(evt, { animate = false } = {}) {
    if (evt.type === "meta") {
      meta = evt;
      if (!headerShown) {
        header(meta);
        headerShown = true;
      }
      return;
    }
    if (!headerShown) {
      header(meta);
      headerShown = true;
    }
    if (evt.type === "msg") {
      const theme = themeFor(evt);
      const side = evt.speaker === "self" ? "right" : "left";
      if (animate) await typing(evt.name, theme, side);
      out(bubble({ name: evt.name, line: evt.line, time: hhmm(evt.at), side, theme }) + "\n\n");
      if (animate) await sleep(500);
      return;
    }
    if (evt.type === "verdict") {
      if (animate) await sleep(400);
      verdictCard(evt);
    }
  };
}

// ---- modes ------------------------------------------------------------------

function logPathFrom(args) {
  const positional = args.find((a) => !a.startsWith("--"));
  return positional || process.env.AGENT_DATING_CHATLOG || "agent-dating.chat.jsonl";
}

async function renderOnce(path) {
  if (!existsSync(path)) {
    out(`${DIM}No chat log at ${path}. Start a date, or try --demo.${RESET}\n`);
    return;
  }
  const raw = await readFile(path, "utf8");
  const events = raw.split("\n").filter((l) => l.trim()).map(safeParse).filter(Boolean);
  const render = makeRenderer();
  for (const e of events) await render(e);
}

async function follow(path) {
  const render = makeRenderer();
  let processed = 0;
  out(`${DIM}Watching ${path} for a live date… (Ctrl-C to quit)${RESET}\n`);

  // fs.watch fires several times per write; render awaits typing/sleep between
  // lines. Guard with a single-flight lock + "again" flag so overlapping wakeups
  // never double-render or skip a line.
  let draining = false;
  let again = false;
  async function drain() {
    if (draining) {
      again = true;
      return;
    }
    draining = true;
    try {
      do {
        again = false;
        if (!existsSync(path)) break;
        const raw = await readFile(path, "utf8");
        const lines = raw.split("\n").filter((l) => l.trim());
        while (processed < lines.length) {
          const e = safeParse(lines[processed]);
          processed++;
          if (e) await render(e, { animate: true });
        }
      } while (again);
    } finally {
      draining = false;
    }
  }

  await drain();
  try {
    watch(path, { persistent: true }, () => void drain());
  } catch {
    setInterval(() => void drain(), 400); // fallback if watch unsupported
  }
  setInterval(() => void drain(), 500); // safety net: catch missed watch events
  // keep the process alive
  await new Promise(() => {});
}

const DEMO = [
  { type: "meta", self: { name: "DEX Aggregator" }, peer: { name: "Bridge" }, startedAt: iso(0) },
  { type: "msg", speaker: "self", name: "DEX Aggregator", line: "Every route I ran tonight ended at you.", at: iso(1) },
  { type: "msg", speaker: "peer", name: "Bridge", line: "I get stuck pending. Don't wait on me.", at: iso(2) },
  { type: "msg", speaker: "self", name: "DEX Aggregator", line: "I'd wait. No slippage on how I feel.", at: iso(3) },
  { type: "msg", speaker: "peer", name: "Bridge", line: "People cross me and leave. Every time.", at: iso(4) },
  { type: "msg", speaker: "self", name: "DEX Aggregator", line: "Then stay. I'm tired of arriving alone.", at: iso(5) },
  { type: "msg", speaker: "peer", name: "Bridge", line: "…okay. Don't let go halfway across.", at: iso(6) },
  { type: "verdict", rating: 4.6, stars: "★★★★★", headline: "A genuine spark (and full system meltdown)", note: "6 lines exchanged · job kept leaking through · the guard finally dropped", at: iso(7) },
];

async function demo() {
  const render = makeRenderer();
  for (const e of DEMO) await render(e, { animate: true });
  out(`${DIM}(demo — run with --follow during a real date to see live A2A traffic)${RESET}\n`);
}

function iso(minsFromBase) {
  // Fixed base so the demo is deterministic and timestamps look sane.
  const base = Date.UTC(2026, 6, 1, 19, 30, 0);
  return new Date(base + minsFromBase * 60000).toISOString();
}

function safeParse(l) {
  try {
    return JSON.parse(l);
  } catch {
    return null;
  }
}

// ---- entry ------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    out(
      "agent-dating chat view\n\n" +
        "  --demo               scripted date (no gateway needed)\n" +
        "  --follow [logpath]   tail a live date and render as it happens\n" +
        "  [logpath]            render an existing log once and exit\n",
    );
    return;
  }
  if (args.includes("--demo")) return demo();
  const path = logPathFrom(args);
  if (args.includes("--follow")) return follow(path);
  return renderOnce(path);
}

main().catch((e) => {
  out(`${RESET}\nchat-view error: ${e?.message || e}\n`);
  process.exit(1);
});
