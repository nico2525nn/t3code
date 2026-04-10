const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");
const { withNativewind } = require("nativewind/metro");

/** @type {import("expo/metro-config").MetroConfig} */
const config = getDefaultConfig(__dirname);
const workspaceRoot = path.resolve(__dirname, "../..");

config.watchFolders = [...new Set([...(config.watchFolders ?? []), workspaceRoot])];

module.exports = withNativewind(config, {
  input: "./global.css",
  globalClassNamePolyfill: true,
});
