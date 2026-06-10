// Firebase web config + lazy initialization.
//
// This config is PUBLIC by design — it ships in the client JS of every Firebase
// web app. Security is NOT secrecy; it's enforced by Firebase Auth + Firestore
// Security Rules + API-key restrictions (restrict this key to your domains in the
// Google Cloud console). So committing it is fine.
//
// Firebase is LAZY-LOADED (dynamic import) so the single-player trainer's bundle
// stays small — the SDK is only fetched when a user actually enters multiplayer.
// Analytics is intentionally omitted (privacy + bundle weight).

import type { FirebaseApp } from "firebase/app";

export const firebaseConfig = {
  apiKey: "AIzaSyDYU3qTIwQ-LRPiJlx65beK0BHRquzDIko",
  // Serve the app from this SAME domain (Firebase Hosting also serves the site at
  // montecarloedge.firebaseapp.com) so the OAuth handler (/__/auth/) is same-origin
  // — required for iOS Safari (ITP). We use firebaseapp.com (not web.app) because its
  // redirect URI is already registered in the OAuth client; web.app's is not, which
  // caused Error 400 redirect_uri_mismatch.
  authDomain: "montecarloedge.firebaseapp.com",
  projectId: "montecarloedge",
  storageBucket: "montecarloedge.firebasestorage.app",
  messagingSenderId: "92656316638",
  appId: "1:92656316638:web:6c0f22e5d43c90d6f6524f",
};

// ── DEV emulator mode (localhost ONLY) ───────────────────────────────────────
// Opt-in via ?emu=1 (persisted to localStorage; ?emu=0 clears it). This is GATED on
// hostname being localhost/127.0.0.1, so it is physically inert in production — it can
// never be a backdoor in the live app. When on, the whole app runs against the Firebase
// emulators (auth/firestore/functions) with email-password test users, so online
// multiplayer can be validated end-to-end without Google OAuth and without touching prod.
const isLocalhost = typeof location !== "undefined" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
function detectEmu(): boolean {
  if (!isLocalhost) return false;
  try {
    const q = new URLSearchParams(location.search);
    if (q.has("emu")) { const on = q.get("emu") !== "0"; localStorage.setItem("mce_emu", on ? "1" : "0"); return on; }
    return localStorage.getItem("mce_emu") === "1";
  } catch { return false; }
}
export const DEV_EMU = detectEmu();

let _app: FirebaseApp | null = null;
let _emuWired = false;

/** Initialise (once) and return the Firebase app. Dynamic import = lazy chunk. */
export async function getFirebaseApp(): Promise<FirebaseApp> {
  if (_app) return _app;
  const { initializeApp, getApps, getApp } = await import("firebase/app");
  _app = getApps().length ? getApp() : initializeApp(firebaseConfig);
  if (DEV_EMU && !_emuWired) {
    _emuWired = true;
    const [auth, fs, fns] = await Promise.all([import("firebase/auth"), import("firebase/firestore"), import("firebase/functions")]);
    try { auth.connectAuthEmulator(auth.getAuth(_app), "http://127.0.0.1:9099", { disableWarnings: true }); } catch { /* already wired */ }
    try { fs.connectFirestoreEmulator(fs.getFirestore(_app), "127.0.0.1", 8080); } catch { /* already wired */ }
    try { fns.connectFunctionsEmulator(fns.getFunctions(_app, "asia-southeast1"), "127.0.0.1", 5001); } catch { /* already wired */ }
    // eslint-disable-next-line no-console
    console.log("%c🔧 MCE DEV — Firebase emulators wired (auth:9099 / firestore:8080 / functions:5001)", "color:#f5c451;font-weight:bold");
  }
  return _app;
}
