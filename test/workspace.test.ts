// Guards for the workspace conventions in AGENTS.md: exact dependency pins, a
// pinned package manager, strict TypeScript in every package, and Node from
// .node-version.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);

function readText(path: string): string {
  return readFileSync(new URL(path, root), "utf8");
}

function readJson<T>(path: string): T {
  return JSON.parse(readText(path)) as T;
}

interface Manifest {
  name: string;
  packageManager?: string;
  engines?: { node?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const workspaceDirs = ["packages", "apps"].flatMap((parent) =>
  readdirSync(new URL(`${parent}/`, root), { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && existsSync(new URL(`${parent}/${entry.name}/package.json`, root)),
    )
    .map((entry) => `${parent}/${entry.name}`),
);

const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

describe("workspace", () => {
  it("contains the planned packages", () => {
    expect(workspaceDirs.sort()).toEqual(
      ["apps/cli", "packages/agents", "packages/core", "packages/daemon", "packages/providers"].sort(),
    );
  });

  it("pins every dependency exactly", () => {
    const loose: string[] = [];
    for (const dir of [".", ...workspaceDirs]) {
      const manifest = readJson<Manifest>(`${dir}/package.json`);
      for (const field of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
        for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
          const ok = spec === "workspace:*" ? name.startsWith("@hotline/") : EXACT_VERSION.test(spec);
          if (!ok) loose.push(`${dir}/package.json ${field} ${name}@${spec}`);
        }
      }
    }
    expect(loose).toEqual([]);
  });

  it("pins the package manager and commits a lockfile", () => {
    const manifest = readJson<Manifest>("package.json");
    expect(manifest.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
    expect(existsSync(new URL("pnpm-lock.yaml", root))).toBe(true);
  });

  it("builds every package with the strict base config", () => {
    const base = readJson<{ compilerOptions: Record<string, unknown> }>("tsconfig.base.json");
    expect(base.compilerOptions).toMatchObject({ strict: true, noUncheckedIndexedAccess: true });

    const solution = readJson<{ references: { path: string }[] }>("tsconfig.json");
    expect(solution.references.map((ref) => ref.path).sort()).toEqual([...workspaceDirs].sort());

    for (const dir of workspaceDirs) {
      const tsconfig = readJson<{ extends?: string; compilerOptions?: Record<string, unknown> }>(
        `${dir}/tsconfig.json`,
      );
      expect(tsconfig.extends, dir).toBe("../../tsconfig.base.json");
      for (const option of ["strict", "noUncheckedIndexedAccess", "noImplicitAny", "strictNullChecks"]) {
        expect(tsconfig.compilerOptions?.[option], `${dir} must not override ${option}`).toBeUndefined();
      }
    }
  });

  it("takes Node from .node-version and keeps engines compatible with it", () => {
    const nodeVersion = readText(".node-version").trim();
    expect(nodeVersion).toMatch(/^\d+(\.\d+){0,2}$/);
    const engines = readJson<Manifest>("package.json").engines?.node ?? "";
    const minimum = /^>=(\d+)\.\d+\.\d+$/.exec(engines);
    expect(minimum, `engines.node "${engines}" should be ">=X.Y.Z"`).not.toBeNull();
    expect(Number(nodeVersion.split(".")[0])).toBeGreaterThanOrEqual(Number(minimum?.[1]));
  });
});
