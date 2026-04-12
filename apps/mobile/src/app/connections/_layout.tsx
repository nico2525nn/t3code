import Stack from "expo-router/stack";

export const unstable_settings = {
  anchor: "index",
};

export default function ConnectionsLayout() {
  return (
    <Stack
      screenOptions={{
        contentStyle: { backgroundColor: "rgba(246,244,239,0.98)" },
        headerShown: false,
      }}
    >
      <Stack.Screen name="index" options={{ animation: "none" }} />
      <Stack.Screen name="new" options={{ animation: "slide_from_right" }} />
    </Stack>
  );
}
