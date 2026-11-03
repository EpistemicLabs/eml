import { certifyDevice, joinRequest, newDeviceKeys, newSigningKey, parseInviteLink } from '@engramprotocol/protocol'
import { relayOriginFor, type TeamFile } from './team-file'

// --- Joining a team brain (v0.21, spec team-brain-sync-client-spec §5) ----------
//
// The invitee's device joins with the link an owner sent: it makes the
// member's identity key and its own device keys, certifies the device, and
// builds the join — its identity, the certificate and its handle sealed under
// the invite secret, signed with the invite's join key (PROTOCOL.md §8). The
// join goes to the relay before any login (sync.ts, join mode); the inviter's
// accept names the device whose wrapped key this one takes, the owner adds
// the member, and the device logs in and replays the log from seq 1.

/**
 * What a join starts from, for the brain `brain` the invite `link` names: the
 * team file to keep (identity, device, the join with its link), ready for a
 * Sync in join mode. Throws ProtocolError when the link is not an invite
 * link for `brain` (UnsupportedVersionError for a link of a newer protocol).
 */
export function joinTeamBrain(args: { brain: string, link: string, handle: string, now: string }): TeamFile {
  const link = parseInviteLink(args.link)
  const identity = newSigningKey()
  const device = newDeviceKeys()
  const cert = certifyDevice(identity, { brain: args.brain, device_sign: device.sign.publicKey, device_enc: device.enc.publicKey, created_at: args.now })
  const request = joinRequest(args.link, identity, cert, args.handle)
  return { v: 1, brain: args.brain, relay: relayOriginFor(link.relay), device, identity, join: { link: args.link, request } }
}
