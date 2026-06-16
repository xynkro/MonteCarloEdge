// MonteCarloEdge — passkey (WebAuthn / Face ID) auth.
//
// Lets a returning player restore their ONLINE session with Face ID even after the
// iOS PWA evicts the Firebase token store: the passkey lives in the platform keychain
// (iCloud Keychain), survives the eviction, and a verified assertion mints a fresh
// Firebase custom token. Public-key crypto only — NO secrets to handle.
//
// Flow:
//   register (signed-in): passkeyRegisterStart → Face ID creates a platform passkey →
//     passkeyRegisterFinish verifies + stores the public key.
//   authenticate (signed-out): passkeyAuthStart → Face ID → passkeyAuthFinish verifies
//     the signature and returns a Firebase custom token the client signs in with.
//
// Storage (Cloud-Function-only; clients denied by the default-deny firestore.rules):
//   passkeys/{credIdB64url}  { uid, publicKey, counter, name, createdAt, lastUsed }
//   passkeyChallenges/{id}   { challenge, uid?, type, exp }   — single-use, 2-min TTL
import { onCall, HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from "@simplewebauthn/server";

const RP_NAME = "MonteCarlo Edge";
// The trust anchor: the SERVER decides which origins are valid, never the client.
const ORIGINS: Record<string, string> = {
  "montecarloedge.web.app": "https://montecarloedge.web.app",
  "montecarloedge.firebaseapp.com": "https://montecarloedge.firebaseapp.com",
};
function rpConfig(data: any): { rpID: string; origin: string } {
  const rpID = String(data?.rpID || "montecarloedge.web.app");
  if (rpID === "localhost") { // emulator/dev: any localhost port
    const origin = String(data?.origin || "http://localhost:5173");
    if (!/^http:\/\/localhost(:\d+)?$/.test(origin)) throw new HttpsError("invalid-argument", "Bad origin.");
    return { rpID, origin };
  }
  const origin = ORIGINS[rpID];
  if (!origin) throw new HttpsError("invalid-argument", "Unknown origin.");
  return { rpID, origin };
}
const b64url = (u8: Uint8Array): string => Buffer.from(u8).toString("base64url");
const fromB64url = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64url"));
const CHALLENGE_TTL = 120_000; // 2 min, single-use

function uidOf(req: CallableRequest): string {
  if (!req.auth?.uid) throw new HttpsError("unauthenticated", "Sign in first.");
  return req.auth.uid;
}

// ── 1) Registration: issue a challenge (signed-in caller) ──
export const passkeyRegisterStart = onCall({ region: "asia-southeast1" }, async (req) => {
  const uid = uidOf(req);
  const { rpID } = rpConfig(req.data);
  const db = getFirestore();
  const existing = await db.collection("passkeys").where("uid", "==", uid).get();
  const opts = await generateRegistrationOptions({
    rpName: RP_NAME, rpID, userID: uid,
    userName: String(req.auth?.token?.email || req.auth?.token?.name || "player"),
    userDisplayName: String(req.auth?.token?.name || "Player"),
    attestationType: "none",
    excludeCredentials: existing.docs.map((d) => ({ id: fromB64url(d.id), type: "public-key" as const })),
    authenticatorSelection: { residentKey: "required", userVerification: "required", authenticatorAttachment: "platform" },
  });
  await db.doc(`passkeyChallenges/${uid}`).set({ challenge: opts.challenge, uid, type: "reg", exp: Date.now() + CHALLENGE_TTL });
  return opts;
});

// ── 2) Registration: verify + store the credential ──
export const passkeyRegisterFinish = onCall({ region: "asia-southeast1" }, async (req) => {
  const uid = uidOf(req);
  const { rpID, origin } = rpConfig(req.data);
  const db = getFirestore();
  const chRef = db.doc(`passkeyChallenges/${uid}`);
  const ch = (await chRef.get()).data();
  if (!ch || ch.type !== "reg" || ch.exp < Date.now()) throw new HttpsError("failed-precondition", "Challenge expired — try again.");
  await chRef.delete();
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: req.data.response, expectedChallenge: ch.challenge,
      expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
    });
  } catch { throw new HttpsError("invalid-argument", "Passkey verification failed."); }
  if (!verification.verified || !verification.registrationInfo) throw new HttpsError("invalid-argument", "Passkey not verified.");
  const { credentialID, credentialPublicKey, counter } = verification.registrationInfo;
  const credId = b64url(credentialID);
  await db.doc(`passkeys/${credId}`).set({
    uid, publicKey: b64url(credentialPublicKey), counter,
    name: String(req.data?.name || "Face ID"), createdAt: FieldValue.serverTimestamp(),
  });
  return { ok: true, credId };
});

// ── 3) Authentication: issue a challenge (NO auth — that's the point) ──
export const passkeyAuthStart = onCall({ region: "asia-southeast1" }, async (req) => {
  const { rpID } = rpConfig(req.data);
  const db = getFirestore();
  const opts = await generateAuthenticationOptions({ rpID, userVerification: "required" }); // discoverable / usernameless
  const flowId = opts.challenge; // the challenge is unique + random; use it as the lookup id
  await db.doc(`passkeyChallenges/${flowId}`).set({ challenge: opts.challenge, type: "auth", exp: Date.now() + CHALLENGE_TTL });
  return { flowId, options: opts };
});

// ── 4) Authentication: verify the assertion → Firebase custom token ──
export const passkeyAuthFinish = onCall({ region: "asia-southeast1" }, async (req) => {
  const { rpID, origin } = rpConfig(req.data);
  const flowId = String(req.data?.flowId || "");
  const response = req.data?.response;
  if (!flowId || !response?.id) throw new HttpsError("invalid-argument", "Bad request.");
  const db = getFirestore();
  const chRef = db.doc(`passkeyChallenges/${flowId}`);
  const ch = (await chRef.get()).data();
  if (!ch || ch.type !== "auth" || ch.exp < Date.now()) throw new HttpsError("failed-precondition", "Challenge expired — try again.");
  await chRef.delete();
  const credId = String(response.id);
  const credRef = db.doc(`passkeys/${credId}`);
  const cred = (await credRef.get()).data();
  if (!cred) throw new HttpsError("not-found", "Unknown passkey.");
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response, expectedChallenge: ch.challenge, expectedOrigin: origin, expectedRPID: rpID,
      requireUserVerification: true,
      authenticator: { credentialID: fromB64url(credId), credentialPublicKey: fromB64url(cred.publicKey), counter: cred.counter || 0 },
    });
  } catch { throw new HttpsError("unauthenticated", "Passkey verification failed."); }
  if (!verification.verified) throw new HttpsError("unauthenticated", "Passkey not verified.");
  await credRef.update({ counter: verification.authenticationInfo.newCounter, lastUsed: FieldValue.serverTimestamp() });
  const token = await getAuth().createCustomToken(cred.uid);
  return { token };
});
