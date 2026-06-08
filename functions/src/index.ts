// MonteCarloEdge Cloud Functions — the server-authoritative game host.
// The engine (src/engine/*, src/mp/mp-engine, src/mp/auth-table-codec) is imported
// VERBATIM (single source of truth) and runs here behind the Admin SDK, so the deck
// and every player's hole cards live only in server memory + the no-client-read
// `tables/{id}/private/state` doc.
//
// This file currently exposes a healthCheck that PROVES the shared engine compiles
// and runs in the Functions runtime + a secure deal round-trips through the codec.
// The full callable suite (createTable / joinTable / startHand / act / leaveTable /
// setSeatAssisted / pokeTimeout + scheduled reapers) lands on top of this scaffold.

import { onCall } from "firebase-functions/v2/https";
import { createAuthTable, sit, startHand, publicState, privateHandFor } from "../../src/mp/mp-engine.js";
import { serializeAuthTable, deserializeAuthTable } from "../../src/mp/auth-table-codec.js";
import { cryptoRng } from "./crypto-rng.js";

export const healthCheck = onCall((req) => {
  // Deal a 2-handed table with the CSPRNG, round-trip it through the codec
  // (as Firestore would), and confirm the rebuilt table is consistent.
  const t = createAuthTable("hc", { uid: req.auth?.uid ?? "anon", name: "Host" }, {
    name: "health", blinds: { sb: 1, bb: 2 }, startingStack: 200, maxSeats: 2,
  });
  sit(t, "u2", "Guest", 1);
  startHand(t, cryptoRng);

  const rebuilt = deserializeAuthTable(JSON.parse(JSON.stringify(serializeAuthTable(t))));
  const pub = publicState(rebuilt);
  return {
    ok: true,
    engine: "shared",
    handId: rebuilt.handId,
    seats: pub.seats.length,
    pot: pub.pot,
    // public projection carries no hole cards; each seated player has exactly 2
    publicHasNoHoles: !JSON.stringify(pub).includes("holeCards"),
    guestHasTwoCards: privateHandFor(rebuilt, "u2").holeCards?.length === 2,
  };
});
