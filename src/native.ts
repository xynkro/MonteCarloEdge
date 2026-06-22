// Native (Capacitor) shell bootstrap — status bar + launch splash.
//
// Every call here is a no-op on the web build (isNativePlatform() === false), and the plugin
// imports are DYNAMIC, so the web bundle never carries the native plugin code. This is the
// same lazy-load discipline as src/mp/firebase.ts.
import { Capacitor } from "@capacitor/core";

export async function initNative(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  const platform = Capacitor.getPlatform();

  // Hide the launch splash FIRST, now that the first render() has painted. Doing this before the
  // (cosmetic) status-bar work means a status-bar failure can never leave the splash stuck up.
  // The config keeps the splash up (launchAutoHide:false) until this call, so there's no flash.
  try {
    const { SplashScreen } = await import("@capacitor/splash-screen");
    await SplashScreen.hide();
  } catch { /* */ }

  // Status bar: light (white) glyphs on the dark shell. Note the @capacitor/status-bar naming
  // is inverted — Style.Dark means "light text for dark backgrounds", which is what we want.
  try {
    const { StatusBar, Style } = await import("@capacitor/status-bar");
    await StatusBar.setStyle({ style: Style.Dark });
    if (platform === "android") {
      // Let the webview draw under the bar; the app already pads via env(safe-area-inset-top).
      await StatusBar.setOverlaysWebView({ overlay: true });
    }
  } catch { /* status bar is cosmetic — never block boot on it */ }
}
