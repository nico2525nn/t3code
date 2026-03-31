import * as path from "node:path";

import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: [
      {
        find: /^@t3tools\/contracts$/,
        replacement: path.resolve(import.meta.dirname, "../../packages/contracts/src/index.ts"),
      },
      {
        find: /^@t3tools\/contracts\/settings$/,
        replacement: path.resolve(import.meta.dirname, "../../packages/contracts/src/settings.ts"),
      },
      {
        find: /^@t3tools\/shared\/(.*)$/,
        replacement: path.resolve(import.meta.dirname, "../../packages/shared/src/$1.ts"),
      },
    ],
  },
  pack: {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    checks: {
      legacyCjs: false,
    },
    outDir: "dist",
    sourcemap: true,
    clean: true,
    noExternal: (id) => id.startsWith("@t3tools/"),
    inlineOnly: false,
    banner: {
      js: "#!/usr/bin/env node\n",
    },
  },
  test: {
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
