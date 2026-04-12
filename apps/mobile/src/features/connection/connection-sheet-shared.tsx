import { SymbolView } from "expo-symbols";
import { Platform, Pressable } from "react-native";

import { AppText as Text } from "../../components/AppText";

export function parsePairingUrl(url: string): { host: string; code: string } {
  const trimmed = url.trim();
  if (!trimmed) return { host: "", code: "" };

  try {
    const parsed = new URL(trimmed);
    const hashParams = new URLSearchParams(parsed.hash.slice(1));
    const hashToken = hashParams.get("token");
    const queryToken = parsed.searchParams.get("token");
    const code = hashToken || queryToken || "";

    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = "/";
    return { host: parsed.toString().replace(/\/$/, ""), code };
  } catch {
    return { host: trimmed, code: "" };
  }
}

export function buildPairingUrl(host: string, code: string): string {
  const h = host.trim();
  const c = code.trim();
  if (!h) return "";
  if (!c) return h;

  try {
    const url = new URL(h.includes("://") ? h : `https://${h}`);
    url.hash = new URLSearchParams([["token", c]]).toString();
    return url.toString();
  } catch {
    return `${h}#token=${c}`;
  }
}

export function makeConnectionSheetPalette(isDarkMode: boolean) {
  if (isDarkMode) {
    return {
      sheet: "rgba(18,20,23,0.98)",
      card: "#1f2329",
      cardAlt: "#242a31",
      border: "rgba(255,255,255,0.06)",
      text: "#f8fafc",
      muted: "#94a3b8",
      subtle: "#cbd5e1",
      accent: "#f59e0b",
      accentSubtle: "rgba(245,158,11,0.12)",
      iconBg: "rgba(245,158,11,0.10)",
      inputBackground: "#171b20",
      inputBorder: "rgba(255,255,255,0.06)",
      primaryButton: "#f8fafc",
      primaryButtonText: "#171717",
      secondaryButton: "rgba(255,255,255,0.05)",
      secondaryButtonText: "#f8fafc",
      dangerButton: "rgba(190,24,93,0.14)",
      dangerBorder: "rgba(244,114,182,0.18)",
      dangerText: "#fda4af",
      placeholder: "#64748b",
      cardShadow: {
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.18,
        shadowRadius: 8,
        elevation: 4,
      } as const,
      separator: "rgba(255,255,255,0.04)",
    };
  }

  return {
    sheet: "rgba(246,244,239,0.98)",
    card: "#fffdf9",
    cardAlt: "#f8f4ec",
    border: "rgba(23,23,23,0.06)",
    text: "#171717",
    muted: "#78716c",
    subtle: "#57534e",
    accent: "#a16207",
    accentSubtle: "rgba(161,98,7,0.08)",
    iconBg: "rgba(161,98,7,0.07)",
    inputBackground: "#ffffff",
    inputBorder: "rgba(23,23,23,0.06)",
    primaryButton: "#171717",
    primaryButtonText: "#fafaf9",
    secondaryButton: "#f1ece3",
    secondaryButtonText: "#171717",
    dangerButton: "#fff1f2",
    dangerBorder: "rgba(225,29,72,0.10)",
    dangerText: "#be123c",
    placeholder: "#94a3b8",
    cardShadow: {
      shadowColor: "rgba(23,23,23,0.08)",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 1,
      shadowRadius: 16,
      elevation: 3,
    } as const,
    separator: "rgba(23,23,23,0.04)",
  };
}

export type ConnectionSheetPalette = ReturnType<typeof makeConnectionSheetPalette>;

export function ConnectionSheetButton(props: {
  readonly icon: React.ComponentProps<typeof SymbolView>["name"];
  readonly label: string;
  readonly disabled?: boolean;
  readonly tone?: "primary" | "secondary" | "danger";
  readonly compact?: boolean;
  readonly palette: ConnectionSheetPalette;
  readonly onPress: () => void;
}) {
  const tone = props.tone ?? "secondary";
  const colors =
    tone === "primary"
      ? {
          backgroundColor: props.palette.primaryButton,
          borderColor: "transparent",
          textColor: props.palette.primaryButtonText,
        }
      : tone === "danger"
        ? {
            backgroundColor: props.palette.dangerButton,
            borderColor: props.palette.dangerBorder,
            textColor: props.palette.dangerText,
          }
        : {
            backgroundColor: props.palette.secondaryButton,
            borderColor: props.palette.border,
            textColor: props.palette.secondaryButtonText,
          };

  const primaryShadow =
    tone === "primary"
      ? Platform.select({
          ios: {
            shadowColor: "#000",
            shadowOffset: { width: 0, height: 3 },
            shadowOpacity: 0.14,
            shadowRadius: 6,
          },
          android: { elevation: 3 },
        })
      : undefined;

  return (
    <Pressable
      className={
        props.compact
          ? "min-h-[42px] flex-row items-center justify-center gap-1.5 rounded-[14px] px-3.5 py-2.5"
          : "min-h-[48px] flex-row items-center justify-center gap-2 rounded-[16px] px-4 py-3"
      }
      disabled={props.disabled}
      onPress={props.onPress}
      style={[
        {
          backgroundColor: colors.backgroundColor,
          borderWidth: tone === "primary" ? 0 : 1,
          borderColor: colors.borderColor,
          opacity: props.disabled ? 0.5 : 1,
        },
        primaryShadow,
      ]}
    >
      <SymbolView
        name={props.icon}
        size={props.compact ? 13 : 14}
        tintColor={colors.textColor}
        type="monochrome"
      />
      <Text
        className="text-[12px] font-t3-bold uppercase"
        style={{ color: colors.textColor, letterSpacing: 0.8 }}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}
