import { ProtocolError, certifyDevice, joinRequest, newDeviceKeys, newSigningKey, parseInviteLink } from '@engramprotocol/protocol'
import { isRelayOrigin, relayOriginFor, type TeamFile } from './team-file'

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
 * link for `brain`, or names a host that is no relay origin (the team file
 * would refuse it later); UnsupportedVersionError for a link of a newer
 * protocol.
 */
export function joinTeamBrain(args: { brain: string, link: string, handle: string, now: string }): TeamFile {
  const link = parseInviteLink(args.link)
  const relay = relayOriginFor(link.relay)
  if (!isRelayOrigin(relay)) throw new ProtocolError('the invite link\'s host is not a relay origin')
  const identity = newSigningKey()
  const device = newDeviceKeys()
  const cert = certifyDevice(identity, { brain: args.brain, device_sign: device.sign.publicKey, device_enc: device.enc.publicKey, created_at: args.now })
  const request = joinRequest(args.link, identity, cert, args.handle)
  return { v: 1, brain: args.brain, relay, device, identity, join: { link: args.link, request } }
}
