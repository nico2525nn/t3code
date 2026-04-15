import { memo, useCallback } from "react";
import { requireNativeViewManager } from "expo-modules-core";
import {
  Pressable,
  ScrollView,
  TextInput,
  View,
  type LayoutChangeEvent,
  type NativeSyntheticEvent,
  type ViewProps,
} from "react-native";

import { AppText as Text } from "../../components/AppText";

interface TerminalInputEvent {
  readonly data: string;
}

interface TerminalResizeEvent {
  readonly cols: number;
  readonly rows: number;
}

interface NativeTerminalSurfaceProps extends ViewProps {
  readonly terminalKey: string;
  readonly initialBuffer: string;
  readonly fontSize: number;
  readonly onInput?: (event: NativeSyntheticEvent<TerminalInputEvent>) => void;
  readonly onResize?: (event: NativeSyntheticEvent<TerminalResizeEvent>) => void;
}

interface TerminalSurfaceProps extends ViewProps {
  readonly terminalKey: string;
  readonly buffer: string;
  readonly fontSize?: number;
  readonly isRunning: boolean;
  readonly onInput: (data: string) => void;
  readonly onResize: (size: { readonly cols: number; readonly rows: number }) => void;
}

const NATIVE_COMPONENT_NAME = "T3TerminalSurface";
function resolveNativeTerminalSurface() {
  const expoGlobal = globalThis as typeof globalThis & {
    expo?: {
      getViewConfig?: (moduleName: string, viewName?: string) => unknown;
    };
  };
  if (expoGlobal.expo?.getViewConfig?.(NATIVE_COMPONENT_NAME) == null) {
    return null;
  }

  return requireNativeViewManager<NativeTerminalSurfaceProps>(NATIVE_COMPONENT_NAME);
}

const NativeTerminalSurfaceView = resolveNativeTerminalSurface();

export const hasNativeTerminalSurface = NativeTerminalSurfaceView !== null;

function estimateGridSize(input: {
  readonly width: number;
  readonly height: number;
  readonly fontSize: number;
}): { readonly cols: number; readonly rows: number } {
  const cellWidth = input.fontSize * 0.62;
  const cellHeight = input.fontSize * 1.35;
  return {
    cols: Math.max(20, Math.min(400, Math.floor(input.width / cellWidth))),
    rows: Math.max(5, Math.min(200, Math.floor(input.height / cellHeight))),
  };
}

const FallbackTerminalSurface = memo(function FallbackTerminalSurface(props: TerminalSurfaceProps) {
  const fontSize = props.fontSize ?? 12;
  const statusLabel = props.isRunning
    ? "Native terminal module not linked. Using text fallback."
    : "Open terminal to start a shell.";

  const handleLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    props.onResize(estimateGridSize({ width, height, fontSize }));
  };

  return (
    <View
      style={[
        {
          flex: 1,
          backgroundColor: "#050505",
          borderRadius: 8,
          overflow: "hidden",
        },
        props.style,
      ]}
      onLayout={handleLayout}
    >
      <View style={{ flex: 1, paddingHorizontal: 10, paddingVertical: 8 }}>
        <Text className="pb-2 text-[11px] text-neutral-500">{statusLabel}</Text>
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: 12 }}
          showsVerticalScrollIndicator={false}
        >
          <Text
            selectable
            style={{
              color: "#f5f5f5",
              fontFamily: "Menlo",
              fontSize,
              lineHeight: Math.round(fontSize * 1.35),
            }}
          >
            {props.buffer || "$ "}
          </Text>
        </ScrollView>
      </View>
      <View
        style={{
          borderTopWidth: 1,
          borderTopColor: "rgba(255,255,255,0.12)",
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          padding: 8,
        }}
      >
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          blurOnSubmit={false}
          editable={props.isRunning}
          placeholder="type and press return"
          placeholderTextColor="#737373"
          returnKeyType="send"
          style={{
            color: "#f5f5f5",
            flex: 1,
            fontFamily: "Menlo",
            fontSize: 13,
            padding: 0,
          }}
          onSubmitEditing={(event) => {
            const text = event.nativeEvent.text;
            if (text.length > 0) {
              props.onInput(`${text}\n`);
            }
          }}
        />
        <Pressable
          disabled={!props.isRunning}
          style={({ pressed }) => ({
            opacity: !props.isRunning ? 0.35 : pressed ? 0.65 : 1,
            paddingHorizontal: 10,
            paddingVertical: 6,
            borderRadius: 8,
            backgroundColor: "rgba(255,255,255,0.1)",
          })}
          onPress={() => props.onInput("\u0003")}
        >
          <Text className="font-t3-bold text-[11px] text-neutral-200">Ctrl-C</Text>
        </Pressable>
      </View>
    </View>
  );
});

export const TerminalSurface = memo(function TerminalSurface(props: TerminalSurfaceProps) {
  const fontSize = props.fontSize ?? 12;
  const { onInput, onResize } = props;
  const handleNativeInput = useCallback(
    (event: NativeSyntheticEvent<TerminalInputEvent>) => {
      onInput(event.nativeEvent.data);
    },
    [onInput],
  );
  const handleNativeResize = useCallback(
    (event: NativeSyntheticEvent<TerminalResizeEvent>) => {
      onResize({
        cols: event.nativeEvent.cols,
        rows: event.nativeEvent.rows,
      });
    },
    [onResize],
  );

  if (NativeTerminalSurfaceView) {
    return (
      <NativeTerminalSurfaceView
        {...props}
        terminalKey={props.terminalKey}
        initialBuffer={props.buffer}
        fontSize={fontSize}
        onInput={handleNativeInput}
        onResize={handleNativeResize}
      />
    );
  }

  return <FallbackTerminalSurface {...props} fontSize={fontSize} />;
});
