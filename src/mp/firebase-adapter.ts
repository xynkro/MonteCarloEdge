// Firebase auth + presence (Phase 1).
//
// Google sign-in + a live "who's online" list. Lazy-loads the Firebase SDK
// (dynamic imports) so it's a separate chunk — the single-player trainer never
// pays for it. Table play / dealing (Phase 2) needs Cloud Functions + the Blaze
// plan; this module is the free-tier foundation: identity + presence.

import { getFirebaseApp, DEV_EMU } from "./firebase.js";
import type { MPUser } from "./types.js";

export { DEV_EMU } from "./firebase.js";

/** DEV-ONLY (emulator) — sign in as a deterministic test user without Google OAuth.
 *  Register-or-sign-in `dev-<label>@mce.test`. Throws off the emulator so it can't run
 *  against real auth. Used by the local validation harness to drive a full online hand. */
export async function devSignIn(label: string): Promise<MPUser> {
  if (!DEV_EMU) throw new Error("dev sign-in is emulator-only");
  const app = await getFirebaseApp();
  const a = await import("firebase/auth");
  const auth = a.getAuth(app);
  const email = `dev-${label.toLowerCase().replace(/[^a-z0-9]/g, "")}@mce.test`, pw = "devpass123";
  try { const c = await a.signInWithEmailAndPassword(auth, email, pw); return toUser(c.user); }
  catch { const c = await a.createUserWithEmailAndPassword(auth, email, pw); try { await a.updateProfile(c.user, { displayName: label }); } catch { /* */ } return toUser(c.user); }
}

const PRESENCE_BEAT_MS = 20_000;   // heartbeat interval
export const PRESENCE_STALE_MS = 45_000; // "online" if seen within this window

const toUser = (u: { uid: string; displayName: string | null; photoURL?: string | null }): MPUser => ({
  uid: u.uid,
  name: (u.displayName ?? "Player").split(" ")[0] || "Player", // first name for the table
  chips: 0,
  strategyEntitled: false,
});

let _db: unknown = null;
async function firestore() {
  const app = await getFirebaseApp();
  const m = await import("firebase/firestore");
  if (!_db) {
    // In the Capacitor WKWebView, Firestore's default WebChannel transport frequently can't
    // connect, so reads/writes hang forever (this is what made native sign-in spin on the
    // seedProfile write). Force long-polling on native. initializeFirestore must run before the
    // first getFirestore and only once; fall back if it was already initialized (e.g. emulator).
    try {
      _db = isNativeShell()
        ? m.initializeFirestore(app, { experimentalForceLongPolling: true })
        : m.getFirestore(app);
    } catch { _db = m.getFirestore(app); }
  }
  return { m, db: _db as ReturnType<typeof m.getFirestore> };
}

// ── Phase 2: networked tables (calls the deployed Cloud Functions) ──
async function callFn<T>(name: string, data: unknown): Promise<T> {
  const app = await getFirebaseApp();
  const m = await import("firebase/functions");
  const fns = m.getFunctions(app, "asia-southeast1"); // must match the deploy region
  const res = await m.httpsCallable(fns, name)(data);
  return res.data as T;
}
export const createRoom = (opts: { tier: string; buyIn: number; name: string; bots: string[]; currency?: "play" | "premium"; assisted?: boolean; isPublic?: boolean }) =>
  callFn<{ code: string; currency?: string }>("createTable", opts);
export const joinRoom = (code: string, name: string) => callFn<{ code: string; seatIdx?: number; already?: boolean }>("joinTable", { code, name });
/** Watch the room without taking a seat or paying a buy-in. */
export const spectateRoom = (code: string, name: string) => callFn<{ code: string; spectator: boolean }>("joinTable", { code, name, spectate: true });
/** Add an AI bot to an existing (waiting) play-currency room. Owner-only (server-enforced). */
export const addBot = (code: string, archetype = "TAG") => callFn<{ ok: boolean }>("addBot", { code, archetype });
export const dealHand = (code: string) => callFn<{ ok: boolean }>("startHand", { code });
export const actRoom = (code: string, action: unknown, expectedVersion: number) =>
  callFn<{ ok: boolean }>("act", { code, action, expectedVersion });
export const leaveRoom = (code: string) => callFn<{ ok: boolean; banked?: number }>("leaveTable", { code });

/** Per-player seat prefs (toggle MCE strategy on your seat, pick a recommendation style).
 *  assisted flips silently to false if the user doesn't hold Edge Pass. */
export type RecStyle = "balanced" | "tag" | "lag" | "nit" | "station" | "maniac";
export type HeroStyle = "gto" | "tag" | "lag" | "nit" | "maniac";
export const setSeatPrefs = (code: string, prefs: { assisted?: boolean; recStyle?: RecStyle; heroStyle?: HeroStyle }) =>
  callFn<{ ok: boolean; assisted: boolean; recStyle: RecStyle; heroStyle: HeroStyle }>("setSeatPrefs", { code, ...prefs });
/** Owner-only: flip room privacy. */
export const setRoomPrefs = (code: string, prefs: { isPublic?: boolean }) =>
  callFn<{ ok: boolean; isPublic: boolean }>("setRoomPrefs", { code, ...prefs });
/** Owner-only: remove a bot from a seat while waiting. */
export const kickBot = (code: string, seatIdx: number) =>
  callFn<{ ok: boolean }>("kickBot", { code, seatIdx });
/** Up to 20 open public rooms in waiting (Online Games list). */
export const listPublicRooms = () =>
  callFn<{ rooms: Array<{ code: string; name: string; sb: number; bb: number; occupied: number; max: number; currency: string }> }>("listPublicRooms", {});
/** Top up your seated stack (bust rebuy / lobby top-up). Server-enforced bounds. */
export const rebuyRoom = (code: string, amount: number) =>
  callFn<{ ok: boolean; stack: number }>("rebuy", { code, amount });
/** Post a chat message into the room (1 msg/2s, ≤120 chars; seated + spectators). */
export const sendChat = (code: string, text: string) => callFn<{ ok: boolean }>("sendChat", { code, text });

/** Subscribe to the last 30 chat messages in a room (orderBy ts desc). */
export interface ChatMsg { id: string; uid: string; name: string; text: string; ts: number | null }
export function subscribeChat(code: string, cb: (msgs: ChatMsg[]) => void): () => void {
  let cancelled = false;
  let unsub: (() => void) | null = null;
  (async () => {
    const { m, db } = await firestore();
    if (cancelled) return;
    const q = m.query(m.collection(db, `tables/${code}/chat`), m.orderBy("ts", "desc"), m.limit(30));
    unsub = m.onSnapshot(q, (snap: { docs: { id: string; data: (opts?: { serverTimestamps?: string }) => { uid?: string; name?: string; text?: string; ts?: { toMillis?: () => number } } }[] }) => {
      if (cancelled) return;
      const msgs: ChatMsg[] = snap.docs.map((d) => {
        const dt = d.data({ serverTimestamps: "estimate" });
        return { id: d.id, uid: dt.uid ?? "", name: dt.name ?? "?", text: dt.text ?? "", ts: dt.ts?.toMillis?.() ?? null };
      }).reverse(); // oldest → newest for natural reading
      cb(msgs);
    }, () => { if (!cancelled) cb([]); });
  })();
  return () => { cancelled = true; unsub?.(); };
}

/** Live public table state (no hole cards). Returns an unsubscribe fn. */
export function subscribeRoom(code: string, cb: (pub: Record<string, unknown> | null) => void): () => void {
  let cancelled = false;
  let unsub: (() => void) | null = null;
  (async () => {
    const { m, db } = await firestore();
    if (cancelled) return;
    unsub = m.onSnapshot(m.doc(db, "tables", code), (s: { exists: () => boolean; data: () => Record<string, unknown> }) => { if (!cancelled) cb(s.exists() ? s.data() : null); }, () => { if (!cancelled) cb(null); });
  })();
  return () => { cancelled = true; unsub?.(); };
}
/** Your OWN hole cards for this room (rules let you read only your own). */
export function subscribeMyHand(code: string, uid: string, cb: (hand: { handId?: string; holeCards?: [number, number] | null } | null) => void): () => void {
  let cancelled = false;
  let unsub: (() => void) | null = null;
  (async () => {
    const { m, db } = await firestore();
    if (cancelled) return;
    unsub = m.onSnapshot(m.doc(db, `tables/${code}/hands/${uid}`), (s: { exists: () => boolean; data: () => { handId?: string; holeCards?: [number, number] | null } }) => { if (!cancelled) cb(s.exists() ? s.data() : null); }, () => { if (!cancelled) cb(null); });
  })();
  return () => { cancelled = true; unsub?.(); };
}
/** Read the player's server-held chip balance (seeded on first room interaction). */
export async function readChips(uid: string): Promise<number | null> {
  const { m, db } = await firestore();
  const s = await m.getDoc(m.doc(db, "users", uid));
  if (!s.exists()) return null;
  const d = s.data() as { chipsPlay?: number; chips?: number };
  return (d.chipsPlay as number) ?? (d.chips as number) ?? 0;
}

/** Read the player's account doc: chip balance + Edge Pass entitlement. */
export async function readUser(uid: string): Promise<{ chips: number | null; edgePass: boolean }> {
  const { m, db } = await firestore();
  const s = await m.getDoc(m.doc(db, "users", uid));
  if (!s.exists()) return { chips: null, edgePass: false };
  const d = s.data() as { chipsPlay?: number; chips?: number; edgePass?: boolean };
  return { chips: (d.chipsPlay as number) ?? (d.chips as number) ?? null, edgePass: !!d.edgePass };
}

// ── Stripe Edge Pass ──
/** Start Edge Pass checkout — returns the Stripe Checkout URL to redirect to. */
export const edgePassCheckout = (origin: string) => callFn<{ url: string | null }>("createCheckoutSession", { origin });
/** Open the Stripe billing portal (manage/cancel) — returns its URL. */
export const billingPortal = (origin: string) => callFn<{ url: string | null }>("createBillingPortal", { origin });

// ── economy: two wallets, gifting, messaging, admin, ledger ──
export interface Wallet { play: number; premium: number; edgePass: boolean; lastWeekly: number; weeklyStreak: number; collectibles: string[] }
/** Live two-wallet balance + Edge Pass + weekly-claim state + owned collectibles. */
export async function subscribeWallet(uid: string, cb: (w: Wallet) => void): Promise<() => void> {
  const { m, db } = await firestore();
  return m.onSnapshot(m.doc(db, "users", uid), (s: { exists: () => boolean; data: () => Record<string, unknown> }) => {
    const d = s.exists() ? s.data() : {};
    cb({ play: (d.chipsPlay as number) ?? (d.chips as number) ?? 25000, premium: (d.chipsPremium as number) ?? 0, edgePass: !!d.edgePass, lastWeekly: (d.lastWeekly as number) ?? 0, weeklyStreak: (d.weeklyStreak as number) ?? 0, collectibles: (d.collectibles as string[]) ?? [] });
  }, () => {});
}
/** Buy a cosmetic collectible with premium chips. */
export const buyCollectible = (itemId: string) => callFn<{ balance: number }>("buyCollectible", { itemId });
export interface InboxMsg { id: string; kind: string; from: string; fromName: string; text?: string; chips?: number; currency?: string; read?: boolean; createdAt?: { seconds: number } }
/** Live inbox (newest first). */
export async function subscribeInbox(uid: string, cb: (msgs: InboxMsg[]) => void): Promise<() => void> {
  const { m, db } = await firestore();
  const q = m.query(m.collection(db, `users/${uid}/inbox`), m.orderBy("createdAt", "desc"), m.limit(50));
  return m.onSnapshot(q, (snap: { docs: { id: string; data: () => Record<string, unknown> }[] }) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() } as InboxMsg))), () => {});
}
/** Update the player's display name on their account doc (rules allow name-only). */
export async function updateName(uid: string, name: string): Promise<void> {
  const { m, db } = await firestore();
  try { await m.setDoc(m.doc(db, "users", uid), { name }, { merge: true }); } catch { /* */ }
}
const inboxPath = (uid: string, msgId: string) => `users/${uid}/inbox/${msgId}`;
export async function markRead(uid: string, msgId: string): Promise<void> {
  const { m, db } = await firestore();
  await m.updateDoc(m.doc(db, inboxPath(uid, msgId)), { read: true });
}
export async function deleteMessage(uid: string, msgId: string): Promise<void> {
  const { m, db } = await firestore();
  await m.deleteDoc(m.doc(db, inboxPath(uid, msgId)));
}
export const giftChips = (toUid: string, amount: number, note = "") => callFn<{ ok: boolean }>("giftChips", { toUid, amount, note });
export const sendMessage = (toUid: string, text: string) => callFn<{ ok: boolean }>("sendMessage", { toUid, text });
// ── friends ──
export const sendFriendRequest = (toUid: string, toName?: string, fromName?: string) => callFn<{ ok: boolean; status: string }>("sendFriendRequest", { toUid, toName, fromName });
export const respondFriendRequest = (fromUid: string, accept: boolean) => callFn<{ ok: boolean }>("respondFriendRequest", { fromUid, accept });
export const removeFriend = (otherUid: string) => callFn<{ ok: boolean }>("removeFriend", { otherUid });
export interface Friendship { otherUid: string; name: string; status: "pending" | "accepted"; requester: string; incoming: boolean }
/** Live friendships where I'm a participant — accepted + incoming/outgoing pending (incoming = they invited me). */
export async function subscribeFriends(uid: string, cb: (fs: Friendship[]) => void): Promise<() => void> {
  const { m, db } = await firestore();
  const q = m.query(m.collection(db, "friendships"), m.where("users", "array-contains", uid), m.limit(500));
  return m.onSnapshot(q, (snap: { docs: { data: () => Record<string, unknown> }[] }) => {
    const fs = snap.docs.map((d) => {
      const x = d.data() as { users?: string[]; requester?: string; status?: string; names?: Record<string, string> };
      const other = (x.users ?? []).find((u) => u !== uid) ?? "";
      return { otherUid: other, name: (x.names ?? {})[other] ?? "Player", status: (x.status as "pending" | "accepted") ?? "pending", requester: x.requester ?? "", incoming: x.requester !== uid };
    }).filter((f) => f.otherUid);
    cb(fs);
  }, () => {});
}
// ── 1:1 direct messages (thread id = sorted-uid pair, same as friendships) ──
export interface DmMsg { id: string; from: string; text: string; createdAt?: unknown }
export const sendDm = (toUid: string, text: string) => callFn<{ ok: boolean }>("sendDm", { toUid, text });
const dmPair = (a: string, b: string) => (a < b ? `${a}_${b}` : `${b}_${a}`);
export async function subscribeDmThread(myUid: string, otherUid: string, cb: (msgs: DmMsg[]) => void): Promise<() => void> {
  const { m, db } = await firestore();
  const q = m.query(m.collection(db, `dms/${dmPair(myUid, otherUid)}/messages`), m.orderBy("createdAt", "asc"), m.limit(200));
  return m.onSnapshot(q, (snap: { docs: { id: string; data: () => Record<string, unknown> }[] }) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() } as DmMsg))), () => {});
}
export const claimWeekly = () => callFn<{ granted: number; balance: number }>("claimWeekly", {});
export const adminGift = (toUid: string, currency: "play" | "premium", amount: number) => callFn<{ balance: number }>("adminGift", { toUid, currency, amount });
export const adminSetEdgePass = (toUid: string, on: boolean) => callFn<{ edgePass: boolean }>("adminSetEdgePass", { toUid, on });
/** Super-admin only: delete a user's Firestore profile + inbox + presence + Auth user. */
export const adminDeleteUser = (toUid: string) => callFn<{ ok: boolean }>("adminDeleteUser", { toUid });
export interface AdminUser { uid: string; name: string; play: number; premium: number; edgePass: boolean }
/** Live list of ALL users (admin only — rules enforce list-if-admin). */
export async function subscribeUsers(cb: (users: AdminUser[]) => void): Promise<() => void> {
  const { m, db } = await firestore();
  return m.onSnapshot(m.query(m.collection(db, "users"), m.limit(300)), (snap: { docs: { id: string; data: () => Record<string, unknown> }[] }) =>
    cb(snap.docs.map((d) => { const x = d.data(); return { uid: d.id, name: (x.name as string) ?? "player", play: (x.chipsPlay as number) ?? (x.chips as number) ?? 0, premium: (x.chipsPremium as number) ?? 0, edgePass: !!x.edgePass }; })), () => {});
}

/** Is the signed-in user a super-admin (custom claim)? */
export async function isAdminClaim(): Promise<boolean> {
  const app = await getFirebaseApp();
  const { getAuth } = await import("firebase/auth");
  const u = getAuth(app).currentUser;
  if (!u) return false;
  try { const r = await u.getIdTokenResult(); return r.claims.admin === true; } catch { return false; }
}
/** Live ledger feed (admin only — rules enforce). Newest first. */
export async function subscribeLedger(cb: (rows: Record<string, unknown>[]) => void): Promise<() => void> {
  const { m, db } = await firestore();
  const q = m.query(m.collection(db, "ledger"), m.orderBy("at", "desc"), m.limit(100));
  return m.onSnapshot(q, (snap: { docs: { id: string; data: () => Record<string, unknown> }[] }) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))), () => {});
}

// True inside the Capacitor native shell (the bridge injects window.Capacitor before our
// bundle runs). On native, OAuth popups/redirects don't work — so we use the
// @capacitor-firebase/authentication plugin (native Google/Apple sheets) with skipNativeAuth
// and feed the returned credential to the JS SDK via signInWithCredential, keeping the JS
// layer the single source of auth-state truth (onAuthStateChanged, wallet sub, etc.).
function isNativeShell(): boolean {
  return !!(globalThis as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();
}
// Best-effort profile seed after any sign-in — auth already succeeded, so a Firestore write
// failure (e.g. rules not yet published) must NOT make sign-in look broken.
async function seedProfile(user: MPUser): Promise<void> {
  try { const { m, db } = await firestore(); await m.setDoc(m.doc(db, "users", user.uid), { name: user.name }, { merge: true }); } catch { /* signed in regardless */ }
}

/** Pop the Google account picker and sign in. Native → native Google sheet via the plugin. */
export async function signInWithGoogle(): Promise<MPUser> {
  const app = await getFirebaseApp();
  if (isNativeShell()) {
    const { FirebaseAuthentication } = await import("@capacitor-firebase/authentication");
    const { getAuth, GoogleAuthProvider, signInWithCredential, getAdditionalUserInfo } = await import("firebase/auth");
    const r = await FirebaseAuthentication.signInWithGoogle({ skipNativeAuth: true });
    const idToken = r.credential?.idToken;
    if (!idToken) throw new Error("Google sign-in returned no credential.");
    const res = await signInWithCredential(getAuth(app), GoogleAuthProvider.credential(idToken, r.credential?.accessToken));
    const user = toUser(res.user);
    // isNew is a nice-to-have (onboarding routing) — it must NEVER break a successful sign-in.
    try { user.isNew = getAdditionalUserInfo(res)?.isNewUser ?? false; } catch { /* non-fatal */ }
    void seedProfile(user); // best-effort — never block sign-in on a profile write (it can hang in a fresh native webview)
    return user;
  }
  const { getAuth, GoogleAuthProvider, signInWithPopup } = await import("firebase/auth");
  const res = await signInWithPopup(getAuth(app), new GoogleAuthProvider());
  const user = toUser(res.user);
  await seedProfile(user);
  return user;
}

/** Start an OAuth sign-in via REDIRECT (reliable on phones/PWAs — unlike popup, which
 *  often can't relay the result back to the opener and hangs). Navigates away; the
 *  result is picked up by consumeRedirect() on the next load. */
export async function signInRedirect(which: "google" | "apple"): Promise<void> {
  const app = await getFirebaseApp();
  const { getAuth, GoogleAuthProvider, OAuthProvider, signInWithRedirect } = await import("firebase/auth");
  let provider;
  if (which === "apple") { const p = new OAuthProvider("apple.com"); p.addScope("name"); p.addScope("email"); provider = p; }
  else { provider = new GoogleAuthProvider(); }
  await signInWithRedirect(getAuth(app), provider);
}
/** Finalize a redirect sign-in on load. Returns the user (+ whether brand new) or null. */
export async function consumeRedirect(): Promise<{ user: MPUser; isNew: boolean } | { error: unknown } | null> {
  // Native: there's no redirect flow (OAuth runs through the @capacitor-firebase/authentication
  // plugin), and our native Auth is initialized WITHOUT a popupRedirectResolver — so calling
  // getRedirectResult here throws auth/argument-error and bounces the signed-in user to the
  // sign-in screen. The persisted session is restored by onAuthStateChanged instead.
  if (isNativeShell()) return null;
  const app = await getFirebaseApp();
  const { getAuth, getRedirectResult, getAdditionalUserInfo } = await import("firebase/auth");
  try {
    const res = await getRedirectResult(getAuth(app));
    if (!res || !res.user) return null;
    const user = toUser(res.user);
    const isNew = getAdditionalUserInfo(res)?.isNewUser ?? false;
    try { const { m, db } = await firestore(); await m.setDoc(m.doc(db, "users", user.uid), { name: user.name }, { merge: true }); } catch { /* */ }
    return { user, isNew };
  } catch (e) { return { error: e }; }
}

/** Sign in with Apple. Native → native Apple sheet via the plugin (needs the Apple Developer
 *  "Sign in with Apple" capability + the Apple provider configured in Firebase). */
export async function signInWithApple(): Promise<MPUser> {
  const app = await getFirebaseApp();
  if (isNativeShell()) {
    const { FirebaseAuthentication } = await import("@capacitor-firebase/authentication");
    const { getAuth, OAuthProvider, signInWithCredential, getAdditionalUserInfo } = await import("firebase/auth");
    const r = await FirebaseAuthentication.signInWithApple({ skipNativeAuth: true });
    const idToken = r.credential?.idToken;
    if (!idToken) throw new Error("Apple sign-in returned no credential.");
    const provider = new OAuthProvider("apple.com");
    const res = await signInWithCredential(getAuth(app), provider.credential({ idToken, rawNonce: r.credential?.nonce }));
    const user = toUser(res.user);
    // isNew is a nice-to-have (onboarding routing) — it must NEVER break a successful sign-in.
    try { user.isNew = getAdditionalUserInfo(res)?.isNewUser ?? false; } catch { /* non-fatal */ }
    void seedProfile(user); // best-effort — never block sign-in on a profile write (it can hang in a fresh native webview)
    return user;
  }
  const { getAuth, OAuthProvider, signInWithPopup } = await import("firebase/auth");
  const provider = new OAuthProvider("apple.com");
  provider.addScope("name"); provider.addScope("email");
  const res = await signInWithPopup(getAuth(app), provider);
  const user = toUser(res.user);
  await seedProfile(user);
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

// ── Passkey / Face ID (WebAuthn) ──
// The RP id + origin are derived from where we're actually running; the server
// validates them against its allowlist (it never trusts these values blindly).
const rpInfo = (): { rpID: string; origin: string } => ({ rpID: location.hostname, origin: location.origin });

/** True only if this device can do a platform passkey (Face ID / Touch ID). */
export async function passkeySupported(): Promise<boolean> {
  try {
    const { browserSupportsWebAuthn, platformAuthenticatorIsAvailable } = await import("@simplewebauthn/browser");
    return browserSupportsWebAuthn() && (await platformAuthenticatorIsAvailable());
  } catch { return false; }
}

/** Enrol a passkey for the CURRENT signed-in user (one-time). Triggers Face ID. */
export async function passkeyRegister(name?: string): Promise<{ ok: boolean }> {
  const { rpID, origin } = rpInfo();
  const { startRegistration } = await import("@simplewebauthn/browser");
  const options = await callFn<Parameters<typeof startRegistration>[0]>("passkeyRegisterStart", { rpID, origin });
  const response = await startRegistration(options);
  return callFn<{ ok: boolean }>("passkeyRegisterFinish", { rpID, origin, response, name });
}

/** Sign IN with a passkey (no existing session) → Firebase custom token → MPUser. */
export async function passkeySignIn(): Promise<MPUser> {
  const { rpID, origin } = rpInfo();
  const { startAuthentication } = await import("@simplewebauthn/browser");
  const start = await callFn<{ flowId: string; options: Parameters<typeof startAuthentication>[0] }>("passkeyAuthStart", { rpID, origin });
  const response = await startAuthentication(start.options);
  const { token } = await callFn<{ token: string }>("passkeyAuthFinish", { rpID, origin, flowId: start.flowId, response });
  const app = await getFirebaseApp();
  const { getAuth, signInWithCustomToken } = await import("firebase/auth");
  const res = await signInWithCustomToken(getAuth(app), token);
  const user = toUser(res.user);
  try { const { m, db } = await firestore(); await m.setDoc(m.doc(db, "users", user.uid), { name: user.name }, { merge: true }); } catch { /* signed in regardless */ }
  return user;
}

export async function signOutUser(): Promise<void> {
  const app = await getFirebaseApp();
  const { getAuth, signOut } = await import("firebase/auth");
  await Promise.race([clearPresence(), new Promise((r) => setTimeout(r, 1500))]);
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
let _presenceEpoch = 0;
let _unloadHandler: (() => void) | null = null;
let _presenceRoom: string | null = null; // current table code (for friends' in-game status), or null
let _presenceRoomPublic = false;          // is that table PUBLIC? private rooms stay hidden from friends

export async function startPresence(user: MPUser): Promise<void> {
  const epoch = ++_presenceEpoch;
  const { m, db } = await firestore();
  if (epoch !== _presenceEpoch) return;
  const ref = m.doc(db, "presence", user.uid);
  _presenceRef = { uid: user.uid };
  // room persists across beats; it's set/cleared by setPresenceRoom on table enter/leave.
  const beat = () => m.setDoc(ref, { name: user.name, lastSeen: m.serverTimestamp(), room: _presenceRoom, roomPublic: _presenceRoomPublic }).catch(() => {});
  await beat();
  if (epoch !== _presenceEpoch) return;
  if (_beat) clearInterval(_beat);
  _beat = setInterval(beat, PRESENCE_BEAT_MS);
  if (_unloadHandler) window.removeEventListener("beforeunload", _unloadHandler);
  _unloadHandler = () => { void m.deleteDoc(ref).catch(() => {}); };
  window.addEventListener("beforeunload", _unloadHandler);
}

/** Set/clear the table code (+ whether it's public) on my presence doc so friends see my in-game
 *  status. Private rooms are surfaced as in-a-game but NOT spectatable/joinable by friends. */
export async function setPresenceRoom(code: string | null, isPublic = false): Promise<void> {
  _presenceRoom = code || null;
  _presenceRoomPublic = !!code && isPublic;
  if (!_presenceRef) return;
  const { m, db } = await firestore();
  await m.setDoc(m.doc(db, "presence", _presenceRef.uid), { room: _presenceRoom, roomPublic: _presenceRoomPublic }, { merge: true }).catch(() => {});
}

export async function clearPresence(): Promise<void> {
  _presenceRoom = null; _presenceRoomPublic = false;
  ++_presenceEpoch;
  if (_beat) { clearInterval(_beat); _beat = null; }
  if (_unloadHandler) { window.removeEventListener("beforeunload", _unloadHandler); _unloadHandler = null; }
  if (_presenceRef) {
    const { m, db } = await firestore();
    await m.deleteDoc(m.doc(db, "presence", _presenceRef.uid)).catch(() => {});
    _presenceRef = null;
  }
}

/** Live list of users seen within the stale window. Returns an unsubscribe fn. */
export async function subscribeOnline(cb: (online: { uid: string; name: string; room: string | null; roomPublic: boolean }[]) => void): Promise<() => void> {
  const { m, db } = await firestore();
  return m.onSnapshot(m.collection(db, "presence"), (snap: { docs: { id: string; data: (opts?: { serverTimestamps?: string }) => { name?: string; room?: string | null; roomPublic?: boolean; lastSeen?: { toMillis?: () => number } } }[] }) => {
    const now = Date.now();
    const online = snap.docs
      .map((d) => { const x = d.data({ serverTimestamps: "estimate" }); return { uid: d.id, name: x.name ?? "Player", room: x.room ?? null, roomPublic: !!x.roomPublic, seen: x.lastSeen?.toMillis?.() ?? 0 }; })
      .filter((x) => now - x.seen < PRESENCE_STALE_MS)
      .map((x) => ({ uid: x.uid, name: x.name, room: x.room, roomPublic: x.roomPublic }));
    cb(online);
  }, () => {});
}
