/** The channels the bridge carries. A channel joins this list with its plug-in. */
export type Channel = 'mail'

/** Mail addresses compare in lower case, without surrounding space. */
export function normalizeMailAddress(address: string): string {
  return address.trim().toLowerCase()
}

/** The part after the last @, or null for something that is not an address. */
export function domainOf(address: string): string | null {
  const at = address.lastIndexOf('@')
  if (at < 1 || at === address.length - 1) return null
  return normalizeMailAddress(address.slice(at + 1))
}
