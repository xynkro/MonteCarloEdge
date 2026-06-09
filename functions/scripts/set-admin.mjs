// Stamp (or remove) the super-admin custom claim on an account.
//
// The admin:true claim is what gates adminGift (mint premium / adjust balances) and
// reading the /ledger audit trail. Run it yourself — it never prints your key.
//
// USAGE (point at your Admin SDK service-account JSON, which stays in Downloads):
//   GOOGLE_APPLICATION_CREDENTIALS="$HOME/Downloads/montecarloedge-firebase-adminsdk-fbsvc-XXXX.json" \
//     node functions/scripts/set-admin.mjs you@email.com
//   ...add `false` to REMOVE admin:  node functions/scripts/set-admin.mjs you@email.com false
//
// After running, sign out + back in on the app (or it refreshes within ~1h) so your
// new token carries the claim.
import admin from "firebase-admin";

const emailOrUid = process.argv[2];
const enable = process.argv[3] !== "false";
if (!emailOrUid) { console.error("Usage: node set-admin.mjs <email|uid> [false]"); process.exit(1); }

admin.initializeApp(); // uses GOOGLE_APPLICATION_CREDENTIALS

const auth = admin.auth();
const user = emailOrUid.includes("@") ? await auth.getUserByEmail(emailOrUid) : await auth.getUser(emailOrUid);
await auth.setCustomUserClaims(user.uid, enable ? { admin: true } : {});
console.log(`${enable ? "Granted" : "Removed"} admin claim for ${user.email ?? user.uid} (uid ${user.uid}).`);
console.log("Sign out and back in on the app to refresh your token.");
process.exit(0);
