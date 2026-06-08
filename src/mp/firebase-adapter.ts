// Firebase auth + presence (Phase 1).
//
// Google sign-in + a live "who's online" list. Lazy-loads the Firebase SDK
// (dynamic imports) so it's a separate chunk — the single-player trainer never
// pays for it. Table play / dealing (Phase 2) needs Cloud Functions + the Blaze
// plan; this module is the free-tier foundation: identity + presence.

import { getFirebaseApp } from "./firebase.js";
import type { MPUser } from "./types.js";

const PRESENCE_BEAT_MS = 20_000;   // heartbeat interval
export const PRESENCE_STALE_MS = 45_000; // "online" if seen within this window

const toUser = (u: { uid: string; displayName: string | null; photoURL?: string | null }): MPUser => ({
  uid: u.uid,
  name: (u.displayName ?? "Player").split(" ")[0] || "Player", // first name for the table
  chips: 0,
  strategyEntitled: false,
});

async function firestore() {
  const app = await getFirebaseApp();
  const m = await import("firebase/firestore");
  return { m, db: m.getFirestore(app) };
}

/** Pop the Google account picker and sign in. */
export async function signInWithGoogle(): Promise<MPUser> {
  const app = await getFirebaseApp();
  const { getAuth, GoogleAuthProvider, signInWithPopup } = await import("firebase/auth");
  const res = await signInWithPopup(getAuth(app), new GoogleAuthProvider());
  const user = toUser(res.user);
  // Seed/refresh the user profile doc (chips become server-authoritative in Phase 3).
  const { m, db } = await firestore();
  await m.setDoc(m.doc(db, "users", user.uid), { name: user.name }, { merge: true });
  return user;
}

export async function signOutUser(): Promise<void> {
  const app = await getFirebaseApp();
  const { getAuth, signOut } = await import("firebase/auth");
  await clearPresence();
  await signOut(getAuth(app));
}

/** Fires with the current user (or null) on load + whenever auth state changes. */
export async function onAuthChanged(cb: (u: MPUser | null) => void): Promise<() => void> {
  const app = await getFirebaseApp();
  const { getAuth, onAuthStateChanged } = await import("firebase/auth");
  return onAuthStateChanged(getAuth(app), (u) => cb(u ? toUser(u) : null));
}

// ── Presence ──
let _beat: ReturnType<typeof setInterval> | null = null;
let _presenceRef: { uid: string } | null = null;

export async function startPresence(user: MPUser): Promise<void> {
  const { m, db } = await firestore();
  const ref = m.doc(db, "presence", user.uid);
  _presenceRef = { uid: user.uid };
  const beat = () => m.setDoc(ref, { name: user.name, lastSeen: m.serverTimestamp() }).catch(() => {});
  await beat();
  if (_beat) clearInterval(_beat);
  _beat = setInterval(beat, PRESENCE_BEAT_MS);
  // Best-effort cleanup when the tab closes (RTDB onDisconnect lands in a later pass).
  window.addEventListener("beforeunload", () => { void m.deleteDoc(ref).catch(() => {}); });
}

export async function clearPresence(): Promise<void> {
  if (_beat) { clearInterval(_beat); _beat = null; }
  if (_presenceRef) {
    const { m, db } = await firestore();
    await m.deleteDoc(m.doc(db, "presence", _presenceRef.uid)).catch(() => {});
    _presenceRef = null;
  }
}

/** Live list of users seen within the stale window. Returns an unsubscribe fn. */
export async function subscribeOnline(cb: (online: { uid: string; name: string }[]) => void): Promise<() => void> {
  const { m, db } = await firestore();
  return m.onSnapshot(m.collection(db, "presence"), (snap: { docs: { id: string; data: () => { name?: string; lastSeen?: { toMillis?: () => number } } }[] }) => {
    const now = Date.now();
    const online = snap.docs
      .map((d) => ({ uid: d.id, name: d.data().name ?? "Player", seen: d.data().lastSeen?.toMillis?.() ?? 0 }))
      .filter((x) => now - x.seen < PRESENCE_STALE_MS)
      .map((x) => ({ uid: x.uid, name: x.name }));
    cb(online);
  });
}
