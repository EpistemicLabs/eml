import { normalizeMailAddress } from './address'

/** The subject of a reply: the original's, with one Re: in front. */
export function replySubject(subject: string | null): string | null {
  if (subject === null) return null
  return /^re:/i.test(subject.trim()) ? subject : `Re: ${subject}`
}

/**
 * The name of a reply: the same text to the same message is the same reply, so a job that asks
 * twice sends once.
 */
export function replyKey(messageId: string, text: string): string {
  return `reply:${messageId}:${fnv1a(text)}`
}

/** The name of a new mail: the same text with the same subject to the same person is the same mail. */
export function newMailKey(to: string, subject: string | null, text: string): string {
  return `new:${fnv1a(`${normalizeMailAddress(to)}\n${subject ?? ''}\n${text}`)}`
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
