# The EML team-brain protocol, version 1

A team brain is an EML brain that several people share. Every member's
cockpit keeps a full copy and runs all brain logic locally; a relay orders and
stores what the members write, and passes it on. **The relay never sees the
contents:** members encrypt every write before it leaves their machine, with a
key the relay never has. This document describes everything that crosses the
wire, so anyone can check that claim against the code
(`@engramprotocol/protocol`, MIT) and the test vectors in `vectors/`.

## 1. What the relay sees and what it never sees

| The relay sees | The relay never sees |
|---|---|
| the brain id; each op's id, epoch, size and arrival time | what an op says (the payload), or its signature |
| membership records: member and device public keys, device certificates with their creation time, roles, key ids, which device signed each record | names or handles of members (they are sealed, padded to one size); a membership record's provenance is all null |
| the genesis: the root's keys and the state hash of the brain it starts from; the account that created the brain (§13) | the state hashes of checkpoints (they are sealed) |
| wrapped brain keys (sealed to one device each) and who wrapped them | the brain key of any epoch |
| invite notices: an invite id and its expiry | the invite secret, or what the invitee calls themselves |
| logins: which device logs in to which brain, and when | sessions, models or harnesses of the agents that wrote |

What the relay can do, and what members notice:

- **Drop or delay** records: it can; members see a gap or a stall, not a forgery.
- **Reorder or fork** the log (show members different histories): every op
  carries its author's chain link at the point it was written (§4); a replica
  whose own link at that point differs stops. This is fork consistency, not
  more: a relay that splits the members into groups and never lets an op of
  one group reach the other is noticed only once an op crosses between them.
- **Replay** an old record (an add_member of a removed member, an add_device
  of a revoked device, any op again): refused — an op_id appears at most once
  in a brain's log (§4).
- **Forge or alter** a write, a membership change, a wrapped key, an invite
  answer or a login: it cannot — each is signed by a member's device or bound
  by a MAC under a secret the relay never sees.
- **Serve a log of its own** to someone joining: refused — the inviter's
  answer names the genesis and the head of the log it answered from (§8).
- **Read** anything listed on the right: it cannot.

Not covered:

- A member who already had a key keeps what they read with it (a removal
  rotates the key for everything after it).
- Metadata on the left is visible to the relay operator.
- Members are trusted in v1. A malicious member can disturb the brain — for
  example, a false checkpoint (§10) makes every honest replica stop as
  diverged. Defending the team against its own members is out of scope for
  v1.

## 2. Encodings and primitives

- **Canonical JSON**: object keys sorted by UTF-16 code unit, no whitespace,
  numbers and strings as JSON.stringify writes them (RFC 8785 for these
  values). Every signed or MAC'd text and every AAD below is canonical JSON.
- **Bytes as text**: base64url without padding; exactly one spelling is
  accepted (no padding, no other alphabet, no whitespace, zero trailing bits).
- **Times**: ISO-8601 UTC with milliseconds (`2026-10-26T08:00:00.000Z`).
- **Ids**: brains and ops are lowercase UUIDs.
- **Strict parsing**: every object has exactly its fields; an unknown field is
  refused, never ignored. An unknown version is refused as
  "update your cockpit" (§11), checked before anything else of an object.
- **Size**: a payload is at most 16 MiB of UTF-8 (`MAX_PAYLOAD`). The largest
  op, an import of many engrams, is far below it — a whole brain of about
  1,400 engrams is 6.5 MiB of JSON — and the cap bounds what one op can make
  every replica and the relay hold.
- **Primitives**, all standard libsodium constructions:
  Ed25519 (`crypto_sign_detached`), X25519 sealed boxes (`crypto_box_seal`),
  XChaCha20-Poly1305 (`crypto_aead_xchacha20poly1305_ietf`, 24-byte nonces),
  BLAKE2b (`crypto_generichash`), HMAC-SHA-512-256 (`crypto_auth`), and
  SHA-256 for hashes of the log.
- **Signatures** cover a domain tag plus a text: `sign(key, "<tag>" + text)`.
  Tags: `eml-op-v1\n`, `eml-device-cert-v1\n`, `eml-wrapped-key-v1\n`,
  `eml-invite-notice-v1\n`, `eml-relay-login-v1\n`.

## 3. Keys

- **Identity key** (Ed25519): one per member per team brain, made on the
  member's first device and kept there. Its public key is the member id.
- **Device keys**: per device per team brain, an Ed25519 signing key and an
  X25519 encryption key. Private keys never leave the device. Keys are kept as
  32-byte seeds (Ed25519: the RFC 8032 seed; X25519: `crypto_box_seed_keypair`).
- **Device certificate**: `{v: 1, brain, member, device_sign, device_enc,
  created_at, sig}`, `sig` = the identity key's signature over
  `eml-device-cert-v1\n` + canonicalJson of the other fields.
- **Fingerprint** (what an owner compares when confirming a join): the first
  20 bytes of SHA-256 over the identity public key, as 8 groups of 5 hex digits.
- **Brain key**: 32 random bytes per epoch. Its **key id** is BLAKE2b-256 of
  the text `eml-brain-key-id-v1`, keyed with the brain key.

## 4. The log and the op

Every write to a brain — private or shared — is an op in the brain's log
(`@engramprotocol/protocol/log`).

- **Envelope**: `{op_id, schema, call, args, provenance, team}`;
  `provenance = {handle, ingestion_method, session_id, model, harness}`, each
  a string or null; in a shared brain
  `team = {brain, device, base_seq, head_hash}`: the brain, the author's
  device signing key, and the author's last applied entry with its chain link.
- **Payload**: the envelope as JSON in the author's key order, no whitespace.
  These exact bytes are hashed, signed, sealed and stored; nobody re-encodes
  them. A reader accepts a payload only in this one form (re-encoding the
  parsed value gives the same bytes: no whitespace, no repeated keys).
- **Chain**: entry `seq` (from 1) has
  `hash = SHA-256("<prev_hash>\n<seq>\n<at>\n<payload_hash>")`, hashes as
  lowercase hex, `prev_hash` of seq 1 = 64 zeros, `payload_hash` = SHA-256 of
  the payload. The relay sets `seq` and `at`; each replica computes the chain
  itself. A replica that finds an op's `head_hash` different from its own link
  at `base_seq` stops: the relay showed members different histories. A relay
  time going backwards stops a replica too.
- **Op signature**: the author device's Ed25519 signature over
  `eml-op-v1\n<payload_hash>`.
- **Once**: an op_id appears at most once in a brain's log. A replica refuses
  a record whose op_id it has applied before — membership records in the
  member set (§6), brain writes in its log — so a relay cannot replay one.

## 5. Records on the wire

- **Sealed record** (every brain write):
  `{v: 1, kind: "op", brain, op_id, epoch, nonce, ct}`;
  `ct` = XChaCha20-Poly1305 under the brain key of `epoch`, a random 24-byte
  `nonce`, plaintext = signature (64 bytes) ‖ payload, AAD = canonicalJson of
  the record without `ct`. Sign, then encrypt: the relay sees neither.
  `op_id` is in the clear so the relay can drop a resent duplicate.
- **Clear record** (genesis and membership): `{v: 1, kind: "clear", brain,
  op_id, payload, sig}`. Only `brain.genesis` and `team.*` calls travel in
  the clear, and they never travel sealed; a reader refuses either mix-up.
  A clear record's author is its signing device alone: its provenance has
  every field null (no handle, session, model or harness), or it is refused.
- The relay delivers `{seq, at, record}`.
- **Opening** a record: exactly its fields; this brain; for a sealed record the
  key of its epoch and successful decryption; a UTF-8 payload in its one form;
  exactly the envelope's fields; the record's `op_id` is the payload's; the
  call travels in the right kind; the signature is `team.device`'s. Then the
  member set decides (§6).

## 6. Membership

Membership follows from the log, and the relay and every member compute it
the same way from the clear records. Each record's op_id must be new to the
log (§4).

- **Genesis** (seq 1, clear): `brain.genesis {state_hash, root: {member,
  device_cert, handle, key_id}}`, signed by the root's device. The root is the
  first owner; `key_id` names the epoch-0 key; `state_hash` (64 hex digits) is
  the hash of the state the brain starts from.
- **Records** — the signing device must be a current device of a member:
  - `team.add_member {member, role, device_cert, handle}` — by an owner, for
    someone not yet a member; role `owner` or `member`.
  - `team.add_device {device_cert}` — by a device of the same member.
  - `team.revoke_device {device}` — by that member's device or an owner's.
  - `team.remove_member {member}` — by an owner; never the last owner.
  - `team.rotate_key {epoch, key_id, prev}` — by an owner; `epoch` = current + 1.
- A device certificate must be the named member's, for this brain, and for a
  device that is not a device already.
- **Rotation due**: a removal or revocation makes a key rotation due; until
  it comes, the brain takes no sealed op and adds nobody. A removed member
  still holds the old key, so nothing new is written under it.
- **An owner keeps a device**: no record may leave the brain without an owner
  who has a current device — then nobody could add, remove or rotate.
- **Handles**: a member's handle (what their sealed ops' `provenance.handle`
  says) is 1–63 characters of `a-z`, `0-9`, `_` and `-` — the charset of
  EML's user and agent ids. It rides in their joining record, sealed: its
  length, the text and zeros make 64 bytes, encrypted with XChaCha20-Poly1305
  under the brain key of the current epoch, AAD =
  canonicalJson({brain, op_id, member}). Only members read it. Two handles are
  the same when they are the same string: no Unicode normalization or case
  folding, whose tables differ between runtimes and could let two replicas
  disagree on whether a handle is taken — and none of the invisible marks,
  look-alike letters or other spaces they would have to catch. A handle
  belongs to whoever first joined with it, for good: a later member with the
  same handle has none — also after the first one was removed; a member who
  joins again keeps theirs.
- **An op is accepted** when its device is a current device of a member and —
  for a sealed op — its `provenance.handle` is that member's handle, and it is
  sealed under the current epoch with no rotation due. A membership record
  names no handle; its device and the rules above decide. Otherwise every
  replica rejects it the same way.

## 7. Brain keys

- **Rotation**: `prev` in `team.rotate_key` is the previous key sealed with
  XChaCha20-Poly1305 under the new key, AAD = canonicalJson({brain, epoch}) with
  the new epoch. With the newest key a member opens every older key, each
  checked against the key id the log names for its epoch; a new member reads
  the whole history.
- **Wrapped key** (kept by the relay, outside the log):
  `{v: 1, brain, epoch, recipient, sealed, wrapper, sig}`; `sealed` =
  `crypto_box_seal(key, the recipient device's encryption key)`; `sig` = the
  wrapper device's signature over `eml-wrapped-key-v1\n` + canonicalJson of the
  other fields. A device accepts it only for itself and this brain, from a
  current device of an owner or of its own member, for an epoch the log has
  reached, and only if the key's id is the one the log names. An unsigned box
  could be replaced by the relay with a key of its own; this one cannot.

## 8. Invites

- **Link**: `https://<relay>/i/1/<brain>/<invite_id>#<secret>` — a 16-byte
  invite id and a 32-byte secret; `1` is the protocol version. The secret is
  in the fragment, which a browser never sends to a server. An invite is open
  for 7 days and is taken once.
- **Notice** (kept by the relay): `{v: 1, brain, invite_id, expires_at,
  inviter, sig}`, signed by an owner's device under `eml-invite-notice-v1\n`.
  No secret. The relay takes it only from a current device of an owner, and
  only with an expiry at most 7 days ahead.
- **Keys from the secret** `s`: mac_key = BLAKE2b-256 of `eml-invite-mac-v1`
  keyed with `s`; enc_key = the same of `eml-invite-enc-v1`.
- **Join** (invitee → relay → inviter): `{v: 1, brain, invite_id, member,
  device_cert, handle, mac}`; `handle` = the padded handle sealed under enc_key,
  AAD = canonicalJson({brain, invite_id, member}); `mac` = `crypto_auth` under
  mac_key over canonicalJson({t: "eml-invite-join-v1", …the join without mac}).
- **Accept** (inviter → relay → invitee): `{v: 1, brain, invite_id,
  join_hash, inviter, anchor, mac}`; `join_hash` = SHA-256 of canonicalJson of
  the whole join, `inviter` = the inviter device's certificate, `anchor` =
  `{genesis, seq, head_hash}` — the genesis op_id of the inviter's log and its
  last entry with that entry's chain link — and `mac` as above with
  `t: "eml-invite-accept-v1"`.
- The relay cannot make either MAC, so it cannot swap the invitee's keys, the
  inviter's keys, the handle or the anchor. The owner confirms the join by
  name and fingerprint, adds the member (`team.add_member`) and wraps the brain
  key for the new device.
- The invitee replays the log the relay serves and refuses it unless its
  genesis op_id is the anchor's and its chain link at the anchor's seq is the
  anchor's head_hash; and it takes a wrapped brain key only from the inviter's
  device named in the accept — not from just any owner of the log it was
  served, which the relay could have made up. It unwraps the key first — the
  chain links need the payload hashes inside the sealed records — but writes
  nothing and treats the served log as genuine only once the anchor holds.

## 9. Relay login

- **Challenge** (relay): `{v: 1, relay, brain, nonce, issued_at}` with a
  32-byte random nonce.
- **Response** (device): `{v: 1, relay, brain, nonce, device, sig}`, `sig` over
  `eml-relay-login-v1\n` + canonicalJson({relay, brain, nonce, device}). The
  device answers only a challenge naming the relay host it connected to and
  the brain it asked for.
- The relay takes a response once, within 60 seconds, from a current device of
  a member. No passwords, no bearer tokens.

## 10. Checkpoints

`brain.checkpoint {seq, state_hash}` (sealed): its author's hash of the brain
state after `seq`, which must be the author's `base_seq`. The state hash is
SHA-256 over canonical JSON of every state table of the brain (rows by primary
key; not the migration ledger, the log or its snapshots, or the full-text
index's internal tables). A replica whose own hash differs has diverged and
stops. A new device replays the whole log from seq 1 and compares its state
with checkpoints other members signed.

## 11. Versions

Every record, message, link and signature tag carries protocol version 1. A
cockpit that meets a higher version stops at that point and keeps the brain
read-only until it is updated; the relay refuses versions it does not know.
The brain schema (inside the payload) is versioned separately, with the same
rule.

## 12. Checking it yourself

- **The vectors** in `vectors/` are the reference: fixed keys and nonces (each
  derived from a readable text), every format above with its exact bytes.
  `keys.json`, `ops.json`, `membership.json`, `brainkeys.json`, `invite.json`,
  `login.json`. Recompute them with any libsodium binding. The package's own
  tests also check, with Node's built-in crypto and independently of
  libsodium: the Ed25519 keys and signatures, the X25519 keys, every
  XChaCha20-Poly1305 box (through HChaCha20 and OpenSSL's ChaCha20-Poly1305),
  the invite MACs (HMAC-SHA-512 truncated) and every SHA-256. Keyed BLAKE2b
  (key ids, the invite keys) and sealed boxes (`crypto_box_seal`) are checked
  by libsodium only.
- **What leaves your machine**: every sealed record is the `ct` of §5. Take a
  record your cockpit sent, and check that without the brain key it opens to
  nothing, that its header holds only the fields of §5, and that with your
  brain key it opens to your signature and your payload.
- **The code**: this package is the whole protocol; the cockpit's sync client
  and the relay both call it, and the relay holds no key that opens a record.

## 13. Relay transport

How a device and the relay talk (`transport.ts`). Records, wrapped keys,
notices, joins and accepts ride inside a frame unchanged; their readers above
check them.

- **Connection**: one WebSocket over TLS per device per brain, at
  `wss://<relay>/sync/1/<brain>` (`1` is the protocol version; another one is
  "update your cockpit"). The relay sends a challenge (§9) right after the
  upgrade.
- **Frames**: text, one JSON object each, `{t, …}` with exactly the fields of
  its `t`. A request carries `req`, a positive integer the device chooses; the
  answer echoes it. Pushes carry none.
- **Size**: a frame is at most 24 MiB of UTF-8 (`MAX_FRAME`) — a sealed record
  at `MAX_PAYLOAD` with its header fits — and before the login at most 64 KiB
  (`PRE_LOGIN_MAX`). Both sides check the byte length before parsing.
- **Device → relay**: before the login `login {response}`, `create {genesis,
  grant}` (a new brain; the grant comes from the brain owner's account and is
  opaque here), `join {join}` (an invitee, who is no member yet); after it
  `subscribe {from}`, `append {req, record}`, `key_put {req, wrapped}`,
  `keys {req}`, `invite_put {req, notice}`, `invite_cancel {req, invite_id}`,
  `invite_accept {req, accept}`.
- **Relay → device**: `challenge {challenge}`, `welcome {member, device,
  head}`, `created {seq, at}`, `op {seq, at, record}` (§5: the log from
  `from` in order, then `caught_up {seq}`, then every new entry, the device's
  own included), `appended {req, seq, at}`, `ok {req}`, `keys {req,
  wrapped}`, `key {wrapped}`, `join {join}` (to the inviter's device),
  `join_waiting {invite_id}`, `accept {accept}`, `invite_closed {invite_id,
  reason}`, `error {req, code, message}`.
- **Appending**: the relay gives the record the next seq and a time no earlier
  than the last one's. A record sent again with the same bytes gets its first
  seq back, so a device resends a write it has no answer for; an op_id in the
  log with other bytes is refused.
- **What the relay refuses**, and every device still checks itself — a relay
  that skipped a check gains nothing, since each replica applies the rules of
  §5–§8 to every record it is served:
  - a sealed record whose header is not exactly §5's or not this brain's, of
    an epoch other than the current one, or while a rotation is due;
  - a clear record that does not open (§5) or that the member set refuses (§6);
  - an op_id already in the log with other bytes;
  - a wrapped key, notice or accept not from the device that is logged in, or
    not one that may write it (§7, §8);
  - a frame over its size, and writes over the brain's rate or storage quota.
  A refused write is not in the log; the device may send it again as a new op
  with a new op_id. An op_id that is in the log is used for good, whether
  members applied the op or rejected it.
- **Closing**: the relay closes a connection on a malformed frame (4000), an
  unknown version (4001), a failed login (4003), when the device or its member
  leaves the brain (4004), over the rate (4008), or when the device reads too
  slowly (4009; it reconnects and subscribes from its last seq + 1).
