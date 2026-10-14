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

// The only compilerOptions a package tsconfig may set: where its sources and
// outputs live. Every check comes from tsconfig.base.json, so a package cannot
// switch one off (for example `noImplicitReturns: false`).
const PACKAGE_LAYOUT_OPTIONS = new Set(["rootDir", "outDir", "tsBuildInfoFile"]);

// Checks the base config must keep on.
const BASE_CHECKS = [
  "strict",
  "noUncheckedIndexedAccess",
  "noImplicitOverride",
  "noImplicitReturns",
  "noFallthroughCasesInSwitch",
  "noUnusedLocals",
  "noUnusedParameters",
] as const;

function nonLayoutOptions(compilerOptions: Record<string, unknown> = {}): string[] {
  return Object.keys(compilerOptions).filter((option) => !PACKAGE_LAYOUT_OPTIONS.has(option));
}

// Whether a `.node-version` pin ("22", "22.13" or "22.13.0") satisfies an
// `engines.node` minimum (">=X.Y.Z"). Components the pin leaves out mean "the
// latest", so "22" satisfies ">=22.13.0" while "22.12.0" and "22.12" do not.
function pinSatisfiesMinimum(pin: string, minimum: string): boolean {
  const pinned = pin.split(".").map(Number);
  const required = minimum.split(".").map(Number);
  for (const [index, part] of pinned.entries()) {
    const floor = required[index] ?? 0;
    if (part !== floor) return part > floor;
  }
  return true;
}

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
    for (const check of BASE_CHECKS) {
      expect(base.compilerOptions[check], `tsconfig.base.json must enable ${check}`).toBe(true);
    }

    const solution = readJson<{ references: { path: string }[] }>("tsconfig.json");
    expect(solution.references.map((ref) => ref.path).sort()).toEqual([...workspaceDirs].sort());

    for (const dir of workspaceDirs) {
      const tsconfig = readJson<{ extends?: string; compilerOptions?: Record<string, unknown> }>(
        `${dir}/tsconfig.json`,
      );
      expect(tsconfig.extends, dir).toBe("../../tsconfig.base.json");
      expect(nonLayoutOptions(tsconfig.compilerOptions), `${dir} may only set layout options`).toEqual([]);
    }
  });

  it("rejects package tsconfigs that set anything but layout options", () => {
    expect(
      nonLayoutOptions({ rootDir: "src", outDir: "dist", tsBuildInfoFile: "dist/.tsbuildinfo" }),
    ).toEqual([]);
    expect(nonLayoutOptions({ outDir: "dist", noImplicitOverride: false })).toEqual(["noImplicitOverride"]);
    expect(nonLayoutOptions({ noImplicitReturns: false, strictNullChecks: false })).toEqual([
      "noImplicitReturns",
      "strictNullChecks",
    ]);
    expect(nonLayoutOptions({ strict: true })).toEqual(["strict"]);
  });

  it("takes Node from .node-version and keeps engines compatible with it", () => {
    const nodeVersion = readText(".node-version").trim();
    expect(nodeVersion).toMatch(/^\d+(\.\d+){0,2}$/);
    const engines = readJson<Manifest>("package.json").engines?.node ?? "";
    const minimum = /^>=(\d+\.\d+\.\d+)$/.exec(engines)?.[1];
    expect(minimum, `engines.node "${engines}" should be ">=X.Y.Z"`).toBeDefined();
    expect(
      pinSatisfiesMinimum(nodeVersion, minimum ?? ""),
      `.node-version ${nodeVersion} is below engines.node ${engines}`,
    ).toBe(true);
  });

  it("compares Node pins against the engines minimum component by component", () => {
    expect(pinSatisfiesMinimum("22", "22.13.0")).toBe(true);
    expect(pinSatisfiesMinimum("22.13", "22.13.0")).toBe(true);
    expect(pinSatisfiesMinimum("22.13.0", "22.13.0")).toBe(true);
    expect(pinSatisfiesMinimum("22.13.1", "22.13.0")).toBe(true);
    expect(pinSatisfiesMinimum("22.14.0", "22.13.0")).toBe(true);
    expect(pinSatisfiesMinimum("24", "22.13.0")).toBe(true);

    expect(pinSatisfiesMinimum("21", "22.13.0")).toBe(false);
    expect(pinSatisfiesMinimum("22.12", "22.13.0")).toBe(false);
    expect(pinSatisfiesMinimum("22.12.0", "22.13.0")).toBe(false);
    expect(pinSatisfiesMinimum("22.12.9", "22.13.0")).toBe(false);
    expect(pinSatisfiesMinimum("22.13.0", "22.13.1")).toBe(false);
  });
});
