import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas";

const HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i;

const HexColor = TrimmedNonEmptyString.check(Schema.isPattern(HEX_COLOR_PATTERN)).annotate({
  title: "Hex color",
  description: "A 6-digit or 8-digit hex color string.",
  examples: ["#0169cc", "#f5f7fb", "#0d0d0d"],
});

const CssColorValue = TrimmedNonEmptyString.annotate({
  title: "CSS color value",
  description: "Any valid CSS color string or color-mix expression.",
  examples: ["#0b6bcb", "rgb(10 20 30 / 80%)", "color-mix(in srgb, #111 92%, #fff)"],
});

const FontFamilyValue = TrimmedNonEmptyString.annotate({
  title: "Font family",
  description: "A CSS font-family value.",
  examples: [
    '"Fraunces", "Iowan Old Style", serif',
    '"IBM Plex Sans", "Segoe UI", sans-serif',
    '"SF Mono", Menlo, monospace',
  ],
});

const CssLengthValue = TrimmedNonEmptyString.annotate({
  title: "CSS length",
  description: "A CSS length value such as px, rem, or em.",
  examples: ["16px", "0.625rem", "1em"],
});

const ThemeContrast = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
  .check(Schema.isLessThanOrEqualTo(100))
  .annotate({
    title: "Contrast",
    description: "A normalized contrast modifier from 0 to 100.",
    examples: [24, 46, 72],
  });

export const DEFAULT_THEME_RADIUS = "0.625rem";
export const DEFAULT_THEME_FONT_SIZE = "16px";

export const ThemeRadiusSchema = CssLengthValue.pipe(
  Schema.withDecodingDefault(() => DEFAULT_THEME_RADIUS),
).annotate({
  title: "Theme radius",
  description: "Global corner radius used by the theme.",
  examples: ["0.625rem", "0.5rem", "0.875rem"],
});
export type ThemeRadius = typeof ThemeRadiusSchema.Type;

export const ThemeFontSizeSchema = CssLengthValue.pipe(
  Schema.withDecodingDefault(() => DEFAULT_THEME_FONT_SIZE),
).annotate({
  title: "Theme font size",
  description: "Base root font size used by the theme.",
  examples: ["16px", "15px", "17px"],
});
export type ThemeFontSize = typeof ThemeFontSizeSchema.Type;

const OverrideTokenValue = CssColorValue.annotate({
  title: "Override token",
  description: "An explicit override for a derived appearance token.",
});

function makeOverrideField(title: string, description: string, examples?: ReadonlyArray<string>) {
  return Schema.optionalKey(
    OverrideTokenValue.annotate({
      title,
      description,
      ...(examples ? { examples } : {}),
    }),
  ).annotateKey({ title, description });
}

export const ThemeSeedColorsSchema = Schema.Struct({
  accent: HexColor.annotate({
    title: "Accent",
    description: "Primary brand or highlight color used for actions and focus states.",
    examples: ["#0169cc", "#d95f2b", "#00827a"],
  }).annotateKey({
    title: "Accent",
    description: "Primary brand or highlight color used for actions and focus states.",
  }),
  background: HexColor.annotate({
    title: "Background",
    description: "Primary canvas color for the app surface.",
    examples: ["#ffffff", "#111111", "#f7f0e8"],
  }).annotateKey({
    title: "Background",
    description: "Primary canvas color for the app surface.",
  }),
  foreground: HexColor.annotate({
    title: "Foreground",
    description: "Primary text color drawn over the background.",
    examples: ["#0d0d0d", "#fcfcfc", "#1a120f"],
  }).annotateKey({
    title: "Foreground",
    description: "Primary text color drawn over the background.",
  }),
}).annotate({
  title: "Theme seed colors",
  description: "The base palette from which the rest of the appearance tokens are derived.",
});
export type ThemeSeedColors = typeof ThemeSeedColorsSchema.Type;

export const ThemeDerivedOverridesSchema = Schema.Struct({
  background: makeOverrideField("Background", "Override the primary app background."),
  foreground: makeOverrideField("Foreground", "Override the primary app foreground color."),
  card: makeOverrideField("Card", "Override the card background."),
  cardForeground: makeOverrideField("Card foreground", "Override the text color used on cards."),
  popover: makeOverrideField("Popover", "Override the popover background."),
  popoverForeground: makeOverrideField(
    "Popover foreground",
    "Override the text color used on popovers.",
  ),
  primary: makeOverrideField("Primary", "Override the primary accent fill."),
  primaryForeground: makeOverrideField(
    "Primary foreground",
    "Override the text color used on the primary accent fill.",
  ),
  secondary: makeOverrideField("Secondary", "Override the secondary surface."),
  secondaryForeground: makeOverrideField(
    "Secondary foreground",
    "Override the text color used on the secondary surface.",
  ),
  muted: makeOverrideField("Muted", "Override the muted surface."),
  mutedForeground: makeOverrideField(
    "Muted foreground",
    "Override the text color used for muted copy.",
  ),
  accentSurface: makeOverrideField("Accent surface", "Override the accent-tinted surface token."),
  accentForeground: makeOverrideField(
    "Accent foreground",
    "Override the text color used on accent-tinted surfaces.",
  ),
  border: makeOverrideField("Border", "Override the default border color."),
  input: makeOverrideField("Input", "Override the default input border or fill color."),
  ring: makeOverrideField("Ring", "Override the focus ring color."),
  destructive: makeOverrideField("Destructive", "Override the destructive fill color."),
  destructiveForeground: makeOverrideField(
    "Destructive foreground",
    "Override the text color used on destructive fills.",
  ),
  info: makeOverrideField("Info", "Override the informational fill color."),
  infoForeground: makeOverrideField(
    "Info foreground",
    "Override the text color used on informational fills.",
  ),
  success: makeOverrideField("Success", "Override the success fill color."),
  successForeground: makeOverrideField(
    "Success foreground",
    "Override the text color used on success fills.",
  ),
  warning: makeOverrideField("Warning", "Override the warning fill color."),
  warningForeground: makeOverrideField(
    "Warning foreground",
    "Override the text color used on warning fills.",
  ),
  diffAddition: makeOverrideField("Diff addition", "Override the addition color used in diffs.", [
    "#0969da",
  ]),
  diffDeletion: makeOverrideField("Diff deletion", "Override the deletion color used in diffs.", [
    "#bc4c00",
  ]),
  sidebar: makeOverrideField("Sidebar", "Override the sidebar surface."),
  sidebarForeground: makeOverrideField(
    "Sidebar foreground",
    "Override the default sidebar text color.",
  ),
  sidebarAccent: makeOverrideField("Sidebar accent", "Override hover and active sidebar surfaces."),
  sidebarAccentForeground: makeOverrideField(
    "Sidebar accent foreground",
    "Override text color on sidebar hover and active surfaces.",
  ),
  sidebarBorder: makeOverrideField("Sidebar border", "Override sidebar border and divider color."),
}).annotate({
  title: "Theme overrides",
  description: "Optional advanced overrides for exact control over derived appearance tokens.",
});
export type ThemeDerivedOverrides = typeof ThemeDerivedOverridesSchema.Type;

export const ThemeVariantSchema = Schema.Struct({
  ...ThemeSeedColorsSchema.fields,
  uiFontFamily: FontFamilyValue.annotate({
    title: "UI font family",
    description: "Font family used for the application interface.",
  }).annotateKey({
    title: "UI font family",
    description: "Font family used for the application interface.",
  }),
  codeFontFamily: FontFamilyValue.annotate({
    title: "Code font family",
    description: "Font family used for code, terminal, and monospace surfaces.",
  }).annotateKey({
    title: "Code font family",
    description: "Font family used for code, terminal, and monospace surfaces.",
  }),
  sidebarTranslucent: Schema.Boolean.annotate({
    title: "Translucent sidebar",
    description: "Whether the sidebar should render with translucency.",
    examples: [true, false],
  }).annotateKey({
    title: "Translucent sidebar",
    description: "Whether the sidebar should render with translucency.",
  }),
  contrast: ThemeContrast.annotateKey({
    title: "Contrast",
    description: "A normalized contrast modifier from 0 to 100.",
  }),
  overrides: Schema.optionalKey(ThemeDerivedOverridesSchema).annotateKey({
    title: "Overrides",
    description: "Optional advanced overrides for exact control over derived appearance tokens.",
  }),
}).annotate({
  title: "Theme variant",
  description:
    "A light or dark appearance variant with seed colors, fonts, and optional overrides.",
});
export type ThemeVariant = typeof ThemeVariantSchema.Type;

export const ThemeOriginSchema = Schema.Literals(["builtin", "custom"]).annotate({
  title: "Theme origin",
  description: "Whether a theme ships with the app or was created/imported by the user.",
  examples: ["builtin", "custom"],
});
export type ThemeOrigin = typeof ThemeOriginSchema.Type;

export const ThemeModeSchema = Schema.Literals(["light", "dark"]).annotate({
  title: "Theme mode",
  description: "Whether this theme targets light mode or dark mode.",
  examples: ["light", "dark"],
});
export type ThemeMode = typeof ThemeModeSchema.Type;

export const ThemeVersionSchema = Schema.Literal(1).annotate({
  title: "Theme document version",
  description: "Version of the theme document schema.",
  examples: [1],
});
export type ThemeVersion = typeof ThemeVersionSchema.Type;

export const ThemeMetadataSchema = Schema.Struct({
  id: TrimmedNonEmptyString.annotate({
    title: "Theme id",
    description: "Stable identifier used for selection and persistence.",
    examples: ["t3code", "warm-editorial", "custom-midnight-ledger"],
  }).annotateKey({
    title: "Theme id",
    description: "Stable identifier used for selection and persistence.",
  }),
  name: TrimmedNonEmptyString.annotate({
    title: "Theme name",
    description: "Human-readable theme label shown in the UI.",
    examples: ["T3Code", "Warm Ledger", "Cool Current"],
  }).annotateKey({
    title: "Theme name",
    description: "Human-readable theme label shown in the UI.",
  }),
  version: ThemeVersionSchema.annotateKey({
    title: "Version",
    description: "Version of the theme document schema.",
  }),
  origin: ThemeOriginSchema.annotateKey({
    title: "Origin",
    description: "Whether the theme is builtin or custom.",
  }),
}).annotate({
  title: "Theme metadata",
  description: "Metadata shared by every appearance theme document.",
});
export type ThemeMetadata = typeof ThemeMetadataSchema.Type;

export const ThemeDocumentSchema = Schema.Struct({
  ...ThemeMetadataSchema.fields,
  mode: ThemeModeSchema.annotateKey({
    title: "Mode",
    description: "Whether this theme targets light mode or dark mode.",
  }),
  radius: ThemeRadiusSchema.annotateKey({
    title: "Radius",
    description: "Global corner radius used across the interface.",
  }),
  fontSize: ThemeFontSizeSchema.annotateKey({
    title: "Font size",
    description: "Base root font size used across the interface.",
  }),
  ...ThemeVariantSchema.fields,
}).annotate({
  title: "Theme document",
  description: "A complete single-mode appearance theme document.",
  examples: [
    {
      id: "codex-light",
      name: "Codex Light",
      version: 1,
      origin: "custom",
      mode: "light",
      radius: "0.625rem",
      fontSize: "16px",
      accent: "#0169cc",
      background: "#ffffff",
      foreground: "#0d0d0d",
      uiFontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      codeFontFamily: '"SF Mono", Menlo, monospace',
      sidebarTranslucent: true,
      contrast: 46,
    },
  ],
});
export type ThemeDocument = typeof ThemeDocumentSchema.Type;
