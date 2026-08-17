const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const ts = require("typescript");
const tailwindColors = require("tailwindcss/colors");

// This script runs in plain Node so Metro config and CI do not need another TS runner.
// Register the same lightweight transpilation for the pure theme modules it imports.
require.extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filename,
  });
  module._compile(outputText, filename);
};

const sharedSourceRoot = path.resolve(__dirname, "../../../packages/shared/src");
const sharedSourceAliases = {
  "@t3tools/shared/themePalettes": path.join(sharedSourceRoot, "themePalettes.ts"),
  "@t3tools/shared/themePreview": path.join(sharedSourceRoot, "themePreview.ts"),
};
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function resolveThemeSource(request, parent, isMain, options) {
  return (
    sharedSourceAliases[request] ?? resolveFilename.call(this, request, parent, isMain, options)
  );
};

const {
  DEFAULT_MOBILE_THEME_ID,
  MOBILE_THEME_IDS,
  getMobileThemeVariables,
} = require("../src/lib/mobileTheme.ts");

const APPEARANCES = ["light", "dark"];
const GENERATED_CSS_PATH = path.resolve(__dirname, "../generated-uniwind-themes.css");
const GENERATED_NAMES_PATH = path.resolve(__dirname, "../generated-uniwind-theme-names.json");

const color = (family, shade, opacity = 1) => {
  const value = shade === undefined ? tailwindColors[family] : tailwindColors[family][shade];
  if (opacity === 1) return value;

  const percentage = Number((opacity * 100).toFixed(4));
  const oklch = /^oklch\((.*)\)$/.exec(value);
  if (oklch) return `oklch(${oklch[1]} / ${percentage}%)`;
  if (value === "#fff") return `rgb(255 255 255 / ${percentage}%)`;
  if (value === "#000") return `rgb(0 0 0 / ${percentage}%)`;
  return `color-mix(in srgb, ${value} ${percentage}%, transparent)`;
};

// These replace the remaining dark:* utility pairs. A registered palette theme is
// neither literally `light` nor `dark`, so appearance-sensitive values must also be
// represented as semantic variables for custom themes.
const ADAPTIVE_COLORS = {
  "--color-adaptive-amber-50-950-a40": [color("amber", 50), color("amber", 950, 0.4)],
  "--color-adaptive-amber-200-900-a60": [color("amber", 200), color("amber", 900, 0.6)],
  "--color-adaptive-amber-500-a12-a16": [color("amber", 500, 0.12), color("amber", 500, 0.16)],
  "--color-adaptive-amber-700-300": [color("amber", 700), color("amber", 300)],
  "--color-adaptive-amber-700-400": [color("amber", 700), color("amber", 400)],
  "--color-adaptive-amber-800-200": [color("amber", 800), color("amber", 200)],
  "--color-adaptive-blue-50-blue-400-a14": [color("blue", 50), color("blue", 400, 0.14)],
  "--color-adaptive-blue-300-a50-blue-400-a28": [color("blue", 300, 0.5), color("blue", 400, 0.28)],
  "--color-adaptive-blue-500-a20-blue-400-a15": [color("blue", 500, 0.2), color("blue", 400, 0.15)],
  "--color-adaptive-blue-500-400": [color("blue", 500), color("blue", 400)],
  "--color-adaptive-blue-600-400": [color("blue", 600), color("blue", 400)],
  "--color-adaptive-emerald-500-a12-a16": [
    color("emerald", 500, 0.12),
    color("emerald", 500, 0.16),
  ],
  "--color-adaptive-emerald-600-400": [color("emerald", 600), color("emerald", 400)],
  "--color-adaptive-emerald-700-300": [color("emerald", 700), color("emerald", 300)],
  "--color-adaptive-indigo-500-a12-a16": [color("indigo", 500, 0.12), color("indigo", 500, 0.16)],
  "--color-adaptive-indigo-600-300": [color("indigo", 600), color("indigo", 300)],
  "--color-adaptive-indigo-700-300": [color("indigo", 700), color("indigo", 300)],
  "--color-adaptive-neutral-100-900": [color("neutral", 100), color("neutral", 900)],
  "--color-adaptive-neutral-200-700-a60": [color("neutral", 200), color("neutral", 700, 0.6)],
  "--color-adaptive-neutral-200-800": [color("neutral", 200), color("neutral", 800)],
  "--color-adaptive-neutral-200-a70-white-a8": [
    color("neutral", 200, 0.7),
    color("white", undefined, 0.08),
  ],
  "--color-adaptive-neutral-200-white-a6": [color("neutral", 200), color("white", undefined, 0.06)],
  "--color-adaptive-neutral-200-white-a8": [color("neutral", 200), color("white", undefined, 0.08)],
  "--color-adaptive-neutral-200-a80-white-a8": [
    color("neutral", 200, 0.8),
    color("white", undefined, 0.08),
  ],
  "--color-adaptive-neutral-300-a60-white-a12": [
    color("neutral", 300, 0.6),
    color("white", undefined, 0.12),
  ],
  "--color-adaptive-neutral-400-500": [color("neutral", 400), color("neutral", 500)],
  "--color-adaptive-neutral-400-a60-500-a60": [
    color("neutral", 400, 0.6),
    color("neutral", 500, 0.6),
  ],
  "--color-adaptive-neutral-400-a80-500-a80": [
    color("neutral", 400, 0.8),
    color("neutral", 500, 0.8),
  ],
  "--color-adaptive-neutral-500-a10-a16": [color("neutral", 500, 0.1), color("neutral", 500, 0.16)],
  "--color-adaptive-neutral-500-400": [color("neutral", 500), color("neutral", 400)],
  "--color-adaptive-neutral-500-500": [color("neutral", 500), color("neutral", 500)],
  "--color-adaptive-neutral-600-300": [color("neutral", 600), color("neutral", 300)],
  "--color-adaptive-neutral-600-400": [color("neutral", 600), color("neutral", 400)],
  "--color-adaptive-neutral-950-50": [color("neutral", 950), color("neutral", 50)],
  "--color-adaptive-red-50-950-a80": [color("red", 50), color("red", 950, 0.8)],
  "--color-adaptive-red-200-800": [color("red", 200), color("red", 800)],
  "--color-adaptive-red-600-a80-400-a80": [color("red", 600, 0.8), color("red", 400, 0.8)],
  "--color-adaptive-red-700-300": [color("red", 700), color("red", 300)],
  "--color-adaptive-rose-100-500-a18": [color("rose", 100), color("rose", 500, 0.18)],
  "--color-adaptive-rose-100-a80-500-a12": [color("rose", 100, 0.8), color("rose", 500, 0.12)],
  "--color-adaptive-rose-300-a70-400-a28": [color("rose", 300, 0.7), color("rose", 400, 0.28)],
  "--color-adaptive-rose-500-a12-a16": [color("rose", 500, 0.12), color("rose", 500, 0.16)],
  "--color-adaptive-rose-500-400": [color("rose", 500), color("rose", 400)],
  "--color-adaptive-rose-600-400": [color("rose", 600), color("rose", 400)],
  "--color-adaptive-rose-700-300": [color("rose", 700), color("rose", 300)],
  "--color-adaptive-sky-500-a12-a16": [color("sky", 500, 0.12), color("sky", 500, 0.16)],
  "--color-adaptive-sky-600-400": [color("sky", 600), color("sky", 400)],
  "--color-adaptive-sky-700-300": [color("sky", 700), color("sky", 300)],
  "--color-adaptive-violet-500-a12-a16": [color("violet", 500, 0.12), color("violet", 500, 0.16)],
  "--color-adaptive-violet-600-400": [color("violet", 600), color("violet", 400)],
  "--color-adaptive-violet-700-300": [color("violet", 700), color("violet", 300)],
  "--color-adaptive-white-neutral-950-a70": [color("white"), color("neutral", 950, 0.7)],
  "--color-adaptive-zinc-500-a12-a16": [color("zinc", 500, 0.12), color("zinc", 500, 0.16)],
  "--color-adaptive-zinc-500-400": [color("zinc", 500), color("zinc", 400)],
  "--color-adaptive-zinc-600-300": [color("zinc", 600), color("zinc", 300)],
};

const customThemeNames = MOBILE_THEME_IDS.flatMap((themeId) =>
  APPEARANCES.map((appearance) => `${themeId}-${appearance}`),
);

const variablesFor = (themeId, appearance) => ({
  ...getMobileThemeVariables(themeId, appearance),
  ...Object.fromEntries(
    Object.entries(ADAPTIVE_COLORS).map(([name, values]) => [
      name,
      values[appearance === "light" ? 0 : 1],
    ]),
  ),
});

const renderVariant = (name, themeId, appearance) => {
  const declarations = Object.entries(variablesFor(themeId, appearance))
    .map(([variable, value]) => `      ${variable}: ${value};`)
    .join("\n");
  return `    @variant ${name} {\n${declarations}\n    }`;
};

const renderCSS = () => {
  const variants = [
    renderVariant("light", DEFAULT_MOBILE_THEME_ID, "light"),
    renderVariant("dark", DEFAULT_MOBILE_THEME_ID, "dark"),
    ...MOBILE_THEME_IDS.flatMap((themeId) =>
      APPEARANCES.map((appearance) =>
        renderVariant(`${themeId}-${appearance}`, themeId, appearance),
      ),
    ),
  ];
  return [
    "/* Generated by scripts/generateUniwindThemes.cjs. Do not edit manually. */",
    "@layer theme {",
    "  :root {",
    variants.join("\n\n"),
    "  }",
    "}",
    "",
  ].join("\n");
};

const outputs = [
  [GENERATED_CSS_PATH, renderCSS()],
  [GENERATED_NAMES_PATH, `${JSON.stringify(customThemeNames, null, 2)}\n`],
];
const checkOnly = process.argv.includes("--check");

const writeFileAtomically = (filename, contents) => {
  const current = fs.existsSync(filename) ? fs.readFileSync(filename, "utf8") : null;
  if (current === contents) return;

  const temporaryFilename = `${filename}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryFilename, contents);
    fs.renameSync(temporaryFilename, filename);
  } finally {
    if (fs.existsSync(temporaryFilename)) fs.unlinkSync(temporaryFilename);
  }
};

for (const [filename, contents] of outputs) {
  if (checkOnly) {
    const current = fs.existsSync(filename) ? fs.readFileSync(filename, "utf8") : null;
    if (current !== contents) {
      console.error(`${path.relative(process.cwd(), filename)} is stale. Run themes:generate.`);
      process.exitCode = 1;
    }
    continue;
  }
  // Metro watches the generated CSS. Replacing a complete temporary file keeps
  // Tailwind from compiling a partially rewritten theme file.
  writeFileAtomically(filename, contents);
}
