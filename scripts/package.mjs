#!/usr/bin/env node
// Bundles the built `hotline` CLI (apps/cli/dist, from `pnpm run build`) into a
// self-contained folder that runs with plain Node and no node_modules:
//
//   dist/hotline/
//     bin/hotline                  launcher; symlink it onto your PATH
//     lib/main.mjs, lib/*.mjs      the CLI and its lazily loaded chunks
//     package.json                 name and version (the CLI reads ../package.json)
//     LICENSE, THIRD_PARTY_LICENSES.txt
//
// dist/ is gitignored and nothing is published. scripts/ci/check-package.mjs
// runs the result from a temporary folder outside the workspace.
import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const entry = join(root, "apps/cli/dist/main.js");
const out = join(root, "dist/hotline");

const cli = JSON.parse(await readFile(join(root, "apps/cli/package.json"), "utf8"));
const workspace = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

try {
  await readFile(entry);
} catch {
  console.error(`package: ${relative(root, entry)} is missing; run \`pnpm run build\` first`);
  process.exit(1);
}

await rm(out, { recursive: true, force: true });

const result = await build({
  absWorkingDir: root,
  entryPoints: { main: entry },
  outdir: join(out, "lib"),
  outExtension: { ".js": ".mjs" },
  bundle: true,
  // Keeps every `await import(...)` a separate chunk, so a hook or `--version`
  // never loads Fastify, SQLite or the MCP SDK.
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node22",
  // Bundled CommonJS dependencies (Fastify and its plugins) call require() for
  // Node built-ins, which an ES module has no binding for.
  banner: {
    js: 'import { createRequire as __hotlineCreateRequire } from "node:module";\nconst require = __hotlineCreateRequire(import.meta.url);',
  },
  legalComments: "eof",
  metafile: true,
  logLevel: "warning",
});
if (result.warnings.length > 0) {
  console.error(`package: esbuild reported ${result.warnings.length} warning(s); fix them before packaging`);
  process.exit(1);
}

// Every lib/*.mjs reads its version through createRequire(...)("../package.json"),
// exactly as apps/cli/dist does, so the manifest sits one level above lib/.
// No "type" field: lib/ files are .mjs, and the extensionless launcher is CommonJS.
await writeFile(
  join(out, "package.json"),
  `${JSON.stringify(
    {
      name: "hotline",
      version: cli.version,
      description: "Agent Hotline: your coding agents call you on the phone.",
      private: true,
      license: workspace.license,
      bin: { hotline: "bin/hotline" },
      engines: workspace.engines,
    },
    null,
    2,
  )}\n`,
);

// CommonJS on purpose: an extensionless file is never ambiguous as CommonJS, and
// Node resolves a symlinked launcher to its real path, so ../lib still points here.
await mkdir(join(out, "bin"));
const launcher = join(out, "bin/hotline");
await writeFile(launcher, '#!/usr/bin/env node\n"use strict";\nimport("../lib/main.mjs");\n');
await chmod(launcher, 0o755);

await cp(join(root, "LICENSE"), join(out, "LICENSE"));
await writeFile(join(out, "THIRD_PARTY_LICENSES.txt"), await thirdPartyLicenses(result.metafile));

const files = Object.keys(result.metafile.outputs).length;
console.log(`package: hotline ${cli.version} -> ${relative(root, out)}/ (${files} bundle files)`);

/** The license text of every npm package that ended up in the bundle. */
async function thirdPartyLicenses(metafile) {
  const packages = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    const path = join(root, input);
    const marker = `${sep}node_modules${sep}`;
    const at = path.lastIndexOf(marker);
    if (at === -1) continue;
    const rest = path.slice(at + marker.length).split(sep);
    const name = rest[0]?.startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
    const dir = path.slice(0, at + marker.length) + name;
    if (name !== undefined && !packages.has(dir)) packages.set(dir, name);
  }
  const sections = [];
  for (const [dir, name] of [...packages].sort((a, b) => a[1].localeCompare(b[1]))) {
    const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    const text = await licenseText(dir);
    sections.push(`${name}@${manifest.version} (${manifest.license ?? "see package"})\n\n${text}`.trimEnd());
  }
  const header = "Third-party packages bundled into dist/hotline/lib, with their license text.";
  return `${header}\n\n${sections.join(`\n\n${"-".repeat(72)}\n\n`)}\n`;
}

async function licenseText(dir) {
  for (const file of ["LICENSE", "LICENSE.md", "LICENSE.txt", "license", "license.md", "LICENCE"]) {
    try {
      return await readFile(join(dir, file), "utf8");
    } catch {}
  }
  return `No license file shipped in ${relative(root, dirname(join(dir, "package.json")))}; see its package.json.`;
}
