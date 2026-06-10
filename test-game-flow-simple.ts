// Simple debug test to understand the flow

import { createAuthTable, seatAi, startHand, actSeat, toActTableSeat, publicState } from "./src/mp/mp-engine.js";
import { mulberry32 } from "./src/engine/rng.js";

const rng = mulberry32(42);

const t = createAuthTable("TEST", { uid: "owner", name: "P0" }, {
  name: "test",
  blinds: { sb: 1, bb: 2 },
  startingStack: 200,
  maxSeats: 2,
});

// Seed bots
for (let s = 1; s < 2; s++) {
  seatAi(t, s, `B${s}`, "TAG");
}

console.log("Seats before startHand:");
t.seats.forEach((s, i) => {
  console.log(`  ${i}: uid=${s.uid}, ai=${s.ai}, chips=${s.chips}`);
});

if (!startHand(t, rng)) {
  console.error("startHand failed");
  process.exit(1);
}

console.log("\nAfter startHand:");
console.log(`  status=${t.status}, liveSeats=${JSON.stringify(t.liveSeats)}`);

const pub = publicState(t);
console.log(`  publicState: street=${pub.street}, toAct=${pub.toAct}, currentBet=${pub.currentBet}`);

console.log("\nSeats in game:");
pub.seats.forEach((s, i) => {
  console.log(`  ${i}: name=${s.name}, chips=${s.chips}, bet=${s.bet}, folded=${s.folded}`);
});

const toActSeat = toActTableSeat(t);
console.log(`\ntoActTableSeat() = ${toActSeat}`);

if (toActSeat >= 0) {
  const seat = t.seats[toActSeat];
  const pubSeat = pub.seats[toActSeat];
  const toCall = (pub.currentBet || 0) - (pubSeat?.bet || 0);
  console.log(`  seat ${toActSeat}: name=${seat?.name}, toCall=${toCall}`);
  console.log(`  legal actions: ${JSON.stringify(t.gs?.legalActionsFor(t.liveSeats.indexOf(toActSeat)))}`);

  // Try a check
  const res = actSeat(t, toActSeat, { type: "check" });
  console.log(`  actSeat(check): ok=${res.ok}, err=${res.err}`);
}

