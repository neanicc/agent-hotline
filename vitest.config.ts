import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

const projects = [
  { name: "core", dir: "packages/core" },
  { name: "daemon", dir: "packages/daemon" },
  { name: "providers", dir: "packages/providers" },
  { name: "agents", dir: "packages/agents" },
  { name: "cli", dir: "apps/cli" },
  { name: "workspace", dir: "." },
];

export default defineConfig({
  resolve: {
    // Tests import sibling packages from source, so they never depend on a stale dist/.
    alias: [
      {
        find: /^@hotline\/(core|daemon|providers|agents)$/,
        replacement: `${root}packages/$1/src/index.ts`,
      },
    ],
  },
  test: {
    projects: projects.map(({ name, dir }) => ({
      extends: true,
      test: {
        name,
        root: `${root}${dir}`,
        include: ["test/**/*.test.ts"],
      },
    })),
  },
});
