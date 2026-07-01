#!/usr/bin/env node
/**
 * render-config.mjs — substitute ${VAR} placeholders in a config template from
 * the environment and write valid JSON. Used by bootstrap.sh instead of
 * envsubst (which isn't installed everywhere); Node is already required.
 *
 *   node scripts/render-config.mjs <template> <out.json>
 */
import { readFileSync, writeFileSync } from "node:fs";

const [, , tmpl, outPath] = process.argv;
if (!tmpl || !outPath) {
  console.error("usage: render-config.mjs <template> <out.json>");
  process.exit(2);
}

const src = readFileSync(tmpl, "utf8");
const rendered = src.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key) => {
  const v = process.env[key] ?? "";
  // JSON-escape the value so mnemonics/paths with quotes or backslashes stay valid.
  return JSON.stringify(v).slice(1, -1);
});

try {
  JSON.parse(rendered); // fail loudly if a placeholder broke the JSON
} catch (e) {
  console.error(`render-config: ${tmpl} did not produce valid JSON: ${e.message}`);
  process.exit(1);
}

writeFileSync(outPath, rendered);
