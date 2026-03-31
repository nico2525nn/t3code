import * as path from "node:path";

import { defineConfig } from "vite-plus";

const shared = {
  format: "cjs" as const,
  outDir: "dist-electron",
  sourcemap: true,
  outExtensions: () => ({ js: ".js" }),
};

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
  pack: [
    {
      ...shared,
      entry: ["src/main.ts"],
      clean: true,
      noExternal: (id) => id.startsWith("@t3tools/"),
    },
    {
      ...shared,
      entry: ["src/preload.ts"],
    },
  ],
});
