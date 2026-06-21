import type { CapacitorConfig } from "@capacitor/cli";

// Native shell config. The app is bundled LOCALLY (webDir: dist) — no remote server.url —
// so the binary ships its own assets. A remote-URL-only wrapper is an automatic App Store
// rejection (Guideline 4.2 "minimum functionality"); locally-bundled + native auth/IAP is not.
//
// NOTE: appId is permanent once an app is submitted to either store. It's trivially
// changeable RIGHT NOW (before first submission) — confirm the bundle id before you ship.
const config: CapacitorConfig = {
  appId: "com.montecarloedge.app",
  appName: "MonteCarloEdge",
  webDir: "dist",
  // Match the app shell's --bg so there's no white flash behind the webview / during launch.
  backgroundColor: "#070a0f",
  ios: {
    backgroundColor: "#070a0f",
    // The app draws its own safe-area padding via CSS env(safe-area-inset-*) (now that the
    // viewport has viewport-fit=cover), so the webview must NOT auto-inset the content.
    contentInset: "never",
  },
  android: {
    backgroundColor: "#070a0f",
  },
};

export default config;
