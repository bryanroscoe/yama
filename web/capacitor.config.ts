import type { CapacitorConfig } from "@capacitor/cli";

// The phone apps wrap the same web build. Build with VITE_API_BASE set to the Yama server,
// e.g. VITE_API_BASE=https://yama.example.com npm run build -w web, then `npx cap sync`.
const config: CapacitorConfig = {
  appId: "app.yama.companion",
  appName: "Yama",
  webDir: "dist",
  backgroundColor: "#13201C",
  ios: { contentInset: "never" },
  android: { allowMixedContent: false },
};

export default config;
