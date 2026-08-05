#!/usr/bin/env node
/**
 * Sandbox file-writer for the skill executor.
 *
 *   node scripts/sandbox-write.mjs "<relPath>" "<base64Content>"     (base64)
 *   node scripts/sandbox-write.mjs "<relPath>" --raw "<jsonEscaped>" (raw)
 *
 * Spawned by the sandbox with cwd = the per-chat workdir, so files are
 * resolved relative to process.cwd() and must stay inside it. base64 is the
 * safe default; `--raw` takes the content as one JSON-escaped argument
 * (\n, \", \\) — far easier for the executor model than hand-encoding base64.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

function unescapeJson(s) {
  return s.replace(/\\(["\\/bfnrt])/g, (m, c) => ({ '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" }[c])).replace(/\\u([0-9a-fA-F]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
}

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('usage: sandbox-write.mjs "<relPath>" "<base64Content>" | "<relPath>" --raw "<jsonEscaped>"');
  process.exit(2);
}
const relPath = args[0];
const rawMode = args[1] === "--raw";
const payload = rawMode ? args[2] : args[1];
if (!relPath || payload === undefined) {
  console.error('usage: sandbox-write.mjs "<relPath>" "<base64Content>" | "<relPath>" --raw "<jsonEscaped>"');
  process.exit(2);
}
if (path.isAbsolute(relPath) || relPath.split(/[\\/]/).includes("..")) {
  console.error("path must be relative and stay inside the workdir");
  process.exit(2);
}
const root = process.cwd();
const target = path.resolve(root, relPath);
if (target !== root && !target.startsWith(root + path.sep)) {
  console.error("path escapes the workdir");
  process.exit(2);
}
let content;
try {
  content = rawMode ? unescapeJson(payload) : Buffer.from(payload, "base64").toString("utf8");
} catch {
  console.error("invalid content argument");
  process.exit(2);
}
if (content.length > 50_000) {
  console.error(`content too large (${content.length} bytes, max 50000)`);
  process.exit(2);
}
await fs.mkdir(path.dirname(target), { recursive: true });
await fs.writeFile(target, content, "utf8");
console.log(`written ${relPath} (${content.length} bytes)`);
