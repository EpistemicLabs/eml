// @engramprotocol/protocol — the parts of the team-brain protocol that every
// party computes the same way: the cockpit's brain server and the relay.

export * from './log'
export { ready, ProtocolError } from './sodium'
export {
  newSigningKey, signingKeyFromSeed, newEncryptionKey, encryptionKeyFromSeed, newDeviceKeys,
  certifyDevice, verifyDeviceCert, fingerprint,
  type KeyPair, type DeviceKeys, type DeviceCert,
} from './keys'
export {
  PROTOCOL_VERSION, UnsupportedVersionError, isClearCall, sealOp, clearOp, openRecord,
  type BrainKey, type SealedRecord, type ClearRecord, type LogRecord, type TeamOp, type OpenedOp,
} from './seal'
export {
  sealHandle, genesisMembers, applyMembership, memberOfDevice, memberHandles, checkAuthor,
  type Role, type Box, type Member, type MemberSet,
} from './membership'
export { newBrainKey, keyId, rotateKey, epochKeys, wrapKey, unwrapKey, type WrappedKey } from './brainkey'
export {
  INVITE_DAYS, newInvite, inviteLink, parseInviteLink, inviteNotice, verifyInviteNotice, checkInviteOpen,
  joinRequest, openJoin, joinAccept, openAccept,
  type Invite, type InviteNotice, type JoinRequest, type JoinAccept,
} from './invite'
export { LOGIN_WINDOW_MS, loginChallenge, loginResponse, verifyLogin, type LoginChallenge, type LoginResponse } from './login'
export { DivergedError, checkpointArgs, checkCheckpoint } from './checkpoint'
