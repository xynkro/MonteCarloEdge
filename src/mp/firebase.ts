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

let _app: FirebaseApp | null = null;

/** Initialise (once) and return the Firebase app. Dynamic import = lazy chunk. */
export async function getFirebaseApp(): Promise<FirebaseApp> {
  if (_app) return _app;
  const { initializeApp, getApps, getApp } = await import("firebase/app");
  _app = getApps().length ? getApp() : initializeApp(firebaseConfig);
  return _app;
}
