/**
 * Build pipeline: bundles src/host -> lib/index.js (ESM, node) and
 * src/client -> lib/client.js (browser module wrapped in the page's
 * ModuleLoader factory format). All @deepseek-ai/* packages, react, and
 * node builtins stay external — the harness loader resolves them.
 */
import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";

const sharedExternal = ["@deepseek-ai/*", "node:*", "react", "react/jsx-runtime", "react-dom"];

mkdirSync("lib", { recursive: true });

// ---- host half: plain ESM, named exports { name, inject, Config, apply } ----
await build({
  entryPoints: ["src/host/index.ts"],
  outfile: "lib/index.js",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  external: sharedExternal,
  logLevel: "info",
  banner: { js: "/* dsh-sub-providers host half — clean-room build. */" },
});

// ---- client half: CJS bundle wrapped in window.__ModuleLoader__.load ----
const result = await build({
  entryPoints: ["src/client/index.tsx"],
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2022",
  write: false,
  external: sharedExternal,
  jsx: "automatic",
  logLevel: "info",
});
const body = result.outputFiles[0].text;
const wrapped = `/* dsh-sub-providers client half — clean-room build. */
window.__ModuleLoader__.load({
\tid: "dsh-sub-providers/client",
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${body
  .split("\n")
  .map((line) => (line.length > 0 ? `\t\t${line}` : line))
  .join("\n")}
\t\treturn module.exports;
\t}
});
`;
writeFileSync("lib/client.js", wrapped);
console.log("lib/client.js written (module-loader wrapped)");
