import * as path from "node:path";

import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@t3tools\/contracts$/,
        replacement: path.resolve(import.meta.dirname, "../contracts/src/index.ts"),
      },
      {
        find: /^@t3tools\/contracts\/settings$/,
        replacement: path.resolve(import.meta.dirname, "../contracts/src/settings.ts"),
      },
    ],
  },
  pack: {
    entry: [
      "src/DrainableWorker.ts",
      "src/KeyedCoalescingWorker.ts",
      "src/Net.ts",
      "src/String.ts",
      "src/Struct.ts",
      "src/git.ts",
      "src/logging.ts",
      "src/model.ts",
      "src/schemaJson.ts",
      "src/shell.ts",
    ],
    format: "esm",
    dts: true,
    outDir: "dist",
    clean: true,
  },
});
