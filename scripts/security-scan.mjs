/**
 * Clean-room security gates over the source tree. Fails (exit 1) when:
 *  1. a source file contains an http(s) URL outside the vendor allowlist;
 *  2. a source file uses a dangerous API (child_process, eval, vm, ...);
 *  3. a source file contains a suspicious long base64 blob literal.
 * Run: node scripts/security-scan.mjs
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\//, "").replace(/\//g, "/");

/** Every outbound endpoint this plugin may reference. */
const ALLOWED_HOSTS = [
  "claude.ai",
  "api.anthropic.com",
  "console.anthropic.com",
  "auth.openai.com",
  "chatgpt.com",
  "api.openai.com",
  "registry.npmjs.org",
  // docs / identity only:
  "127.0.0.1",
  "localhost",
  "provider.example", // test fixtures
  "github.com",
  "w3.org",
  "example.com",
];

const FORBIDDEN = [
  { name: "child_process", pattern: /child_process/ },
  { name: "eval()", pattern: /\beval\s*\(/ },
  { name: "new Function", pattern: /new\s+Function\s*\(/ },
  { name: "vm module", pattern: /require\(["']node:vm|from ["']node:vm/ },
  { name: "dynamic import", pattern: /\bimport\s*\(/ },
  { name: "keychain/credential-store access", pattern: /keychain|find-generic-password|CLAUDE_CONFIG_DIR|\.claude[/\\]|\.credentials\.json/i },
  { name: "long base64 literal blob", pattern: /["'][A-Za-z0-9+/]{80,}={0,2}["']/ },
];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "node_modules" || entry === "lib") continue;
      walk(path, out);
    } else if (/\.(ts|tsx|mjs|js)$/.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

const failures = [];
const files = [
  ...walk(join(ROOT, "src")),
  ...walk(join(ROOT, "test")),
  join(ROOT, "build.mjs"),
  join(ROOT, "scripts", "security-scan.mjs"),
];

for (const file of files) {
  const text = readFileSync(file, "utf8");
  const short = file.slice(ROOT.length);
  for (const match of text.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)) {
    const host = match[1].toLowerCase();
    if (!ALLOWED_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) {
      failures.push(`${short}: URL host not allowlisted -> ${host}`);
    }
  }
  for (const rule of FORBIDDEN) {
    if (rule.pattern.test(text)) {
      // the scanner itself carries the patterns; skip self-flagging
      if (short.includes("security-scan")) continue;
      failures.push(`${short}: forbidden pattern (${rule.name})`);
    }
  }
}

if (failures.length > 0) {
  console.error("security scan FAILED:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`security scan passed (${files.length} files: URL allowlist, dangerous-API ban list, blob literals)`);
