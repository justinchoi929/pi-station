// Builds dist/mac-*/Pi Station.app. The app holds only desktop/: it runs the server
// from this checkout (recorded as piStationHome), whose .next holds the web build.
// The pi CLI is installed independently and resolved from PATH at runtime.
import { build } from "electron-builder";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

await build({
  projectDir: root,
  mac: ["dir"],
  config: {
    appId: "dev.pi-station.desktop",
    productName: "Pi Station",
    directories: { output: join(root, "dist") },
    files: ["desktop/main.mjs", "desktop/preload.cjs", "package.json", "!node_modules/**/*"],
    extraMetadata: { piStationHome: root, main: "desktop/main.mjs", dependencies: {} },
    npmRebuild: false,
    mac: {
      icon: join(root, "public/icons/icon-512.png"),
      category: "public.app-category.developer-tools",
      identity: null,
    },
  },
});
