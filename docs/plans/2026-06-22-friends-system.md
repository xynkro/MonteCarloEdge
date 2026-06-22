# Friends system — design + plan (2026-06-22)

**Goal:** A Mobile-Legends-style social layer — add friends, see who's online + their in-game status,
spectate/join their public rooms, and DM them.

**Built ON the existing infra** (don't reinvent): `presence/{uid}` (heartbeat, online<45s, client-writable
own doc), `users/{uid}` (profile, readable by any signed-in user), the `sendMessage`→inbox + `giftChips`
callables, and the server-authoritative Cloud Functions pattern.

## Data model (new)
- **`friendships/{pairId}`** — `pairId = ${minUid}_${maxUid}` (one doc per pair, dedupes A→B / B→A).
  Fields: `users: [a, b]` (for `array-contains` queries), `requester: uid`, `status: "pending"|"accepted"`,
  `createdAt`, `acceptedAt?`. **Written ONLY by Cloud Functions** (server-authoritative); clients read.
- **`presence/{uid}` enrichment** — add `room: string|null` (current table code) + `avatar` so the friends
  list shows in-game status + an avatar. Client keeps writing its own presence (rules already allow it);
  `startPresence`/room-enter/room-leave set `room`.

## Server callables (functions/src/friends.ts, region asia-southeast1)
- `sendFriendRequest(toUid)` — create/upsert `friendships/{pairId}` status=pending, requester=me. Guards:
  not self, not already friends, rate-limit, target exists.
- `respondFriendRequest(fromUid, accept)` — only the non-requester may accept/decline; accept → status=accepted
  + acceptedAt; decline → delete the doc.
- `removeFriend(uid)` — delete the pair doc (either party).
(The deploy must keep `revenuecat.js` excluded while `REVENUECAT_WEBHOOK_AUTH` is unset — known workaround.)

## Firestore rules + indexes
- `match /friendships/{id}` → `allow read: if signedIn() && request.auth.uid in resource.data.users;`
  `allow write: if false;` (functions only).
- Index: `friendships` composite (`users` array-contains + `status`) — add to firestore.indexes.json.

## Client (firebase-adapter.ts)
- `subscribeFriends(uid, cb)` — onSnapshot `where("users","array-contains",uid)`; split into accepted +
  incoming-pending (requester≠me) + outgoing-pending. Join with presence (subscribeOnline) for online/room.
- `sendFriendRequest` / `respondFriendRequest` / `removeFriend` wrappers.
- `setPresenceRoom(code|null)` — update own presence.room on room enter/leave.

## UI (main.ts) — `renderFriends`, `S.screen="friends"`
- Home tile/button "Friends" (badge = pending-request count).
- Sections: **Requests** (accept/decline), **Online** friends (avatar, name, "in MCE-XXXX" if in a room →
  Spectate/Join if public, else "Watch"), **Offline** friends. Add-friend: from the online-now list, or by
  searching the user directory by nickname.
- **Phase 2:** Spectate/Join wired to `spectateRoom`/`joinRoom` (already support mid-hand join).
- **Phase 3:** 1:1 DMs — `dms/{threadId}/messages` thread reusing the chat drawer primitives.

## Phasing
1. **Foundation (this pass):** schema + rules + index + the 3 callables + adapter subs/wrappers +
   presence.room + the Friends screen (requests, online/offline list, add-friend). Verify with 2 emulator users.
2. Spectate/Join from the list.
3. DMs.

## Hard-rule compliance
Server-authoritative writes (functions only write friendships); no `undefined` to Firestore; presence stays
client-own-writable per existing rules; one render path (Friends is a new screen, not a table fork).
