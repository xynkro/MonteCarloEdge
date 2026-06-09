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

// ── Phase 2: networked tables (calls the deployed Cloud Functions) ──
async function callFn<T>(name: string, data: unknown): Promise<T> {
  const app = await getFirebaseApp();
  const m = await import("firebase/functions");
  const fns = m.getFunctions(app, "asia-southeast1"); // must match the deploy region
  const res = await m.httpsCallable(fns, name)(data);
  return res.data as T;
}
export const createRoom = (opts: { tier: string; buyIn: number; name: string; bots: string[] }) =>
  callFn<{ code: string }>("createTable", opts);
export const joinRoom = (code: string, name: string) => callFn<{ code: string; seatIdx?: number; already?: boolean }>("joinTable", { code, name });
export const dealHand = (code: string) => callFn<{ ok: boolean }>("startHand", { code });
export const actRoom = (code: string, action: unknown, expectedVersion: number) =>
  callFn<{ ok: boolean }>("act", { code, action, expectedVersion });
export const leaveRoom = (code: string) => callFn<{ ok: boolean; banked?: number }>("leaveTable", { code });

/** Live public table state (no hole cards). Returns an unsubscribe fn. */
export async function subscribeRoom(code: string, cb: (pub: Record<string, unknown> | null) => void): Promise<() => void> {
  const { m, db } = await firestore();
  return m.onSnapshot(m.doc(db, "tables", code), (s: { exists: () => boolean; data: () => Record<string, unknown> }) => cb(s.exists() ? s.data() : null));
}
/** Your OWN hole cards for this room (rules let you read only your own). */
export async function subscribeMyHand(code: string, uid: string, cb: (hand: { handId?: string; holeCards?: [number, number] | null } | null) => void): Promise<() => void> {
  const { m, db } = await firestore();
  return m.onSnapshot(m.doc(db, `tables/${code}/hands/${uid}`), (s: { exists: () => boolean; data: () => { handId?: string; holeCards?: [number, number] | null } }) => cb(s.exists() ? s.data() : null));
}
/** Read the player's server-held chip balance (seeded on first room interaction). */
export async function readChips(uid: string): Promise<number | null> {
  const { m, db } = await firestore();
  const s = await m.getDoc(m.doc(db, "users", uid));
  return s.exists() ? (((s.data() as { chips?: number }).chips) ?? 0) : null;
}

/** Pop the Google account picker and sign in. */
export async function signInWithGoogle(): Promise<MPUser> {
  const app = await getFirebaseApp();
  const { getAuth, GoogleAuthProvider, signInWithPopup } = await import("firebase/auth");
  const res = await signInWithPopup(getAuth(app), new GoogleAuthProvider());
  const user = toUser(res.user);
  // Seed/refresh the user profile doc — BEST-EFFORT. Auth has already succeeded;
  // a Firestore write failure (e.g. rules not yet published) must NOT make the
  // whole sign-in look broken. The presence layer surfaces any rules issue.
  try {
    const { m, db } = await firestore();
    await m.setDoc(m.doc(db, "users", user.uid), { name: user.name }, { merge: true });
  } catch { /* signed in regardless */ }
  return user;
}

/** Sign in with Apple (provider enabled in the Firebase console). */
export async function signInWithApple(): Promise<MPUser> {
  const app = await getFirebaseApp();
  const { getAuth, OAuthProvider, signInWithPopup } = await import("firebase/auth");
  const provider = new OAuthProvider("apple.com");
  provider.addScope("name"); provider.addScope("email");
  const res = await signInWithPopup(getAuth(app), provider);
  const user = toUser(res.user);
  try { const { m, db } = await firestore(); await m.setDoc(m.doc(db, "users", user.uid), { name: user.name }, { merge: true }); } catch { /* */ }
  return user;
}

/** Register a new account with email + password. */
export async function registerEmail(email: string, password: string, name: string): Promise<MPUser> {
  const app = await getFirebaseApp();
  const { getAuth, createUserWithEmailAndPassword, updateProfile } = await import("firebase/auth");
  const res = await createUserWithEmailAndPassword(getAuth(app), email, password);
  if (name) { try { await updateProfile(res.user, { displayName: name }); } catch { /* */ } }
  const user = toUser({ uid: res.user.uid, displayName: name || res.user.displayName });
  try { const { m, db } = await firestore(); await m.setDoc(m.doc(db, "users", user.uid), { name: user.name }, { merge: true }); } catch { /* */ }
  return user;
}
/** Sign in with an existing email + password. */
export async function signInEmail(email: string, password: string): Promise<MPUser> {
  const app = await getFirebaseApp();
  const { getAuth, signInWithEmailAndPassword } = await import("firebase/auth");
  const res = await signInWithEmailAndPassword(getAuth(app), email, password);
  return toUser(res.user);
}
export async function sendReset(email: string): Promise<void> {
  const app = await getFirebaseApp();
  const { getAuth, sendPasswordResetEmail } = await import("firebase/auth");
  await sendPasswordResetEmail(getAuth(app), email);
}
export async function changePassword(newPassword: string): Promise<void> {
  const app = await getFirebaseApp();
  const { getAuth, updatePassword } = await import("firebase/auth");
  const u = getAuth(app).currentUser;
  if (!u) throw new Error("Not signed in.");
  await updatePassword(u, newPassword);
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
