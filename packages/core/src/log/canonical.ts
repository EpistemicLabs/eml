// --- JSON for the op log (v0.21) ------------------------------------------------
//
// Two encodings of one walk. An op's payload is the envelope as plain JSON in
// the caller's key order (plainJson): the stored bytes are what is hashed and
// signed, and the command runs on them, so a re-encoding would change key
// order and with it behaviour. The state hash covers canonical JSON
// (canonicalJson): object keys sorted by UTF-16 code unit — RFC 8785 (JCS) for
// these values — so equal states hash equal whatever order rows were read in.
// Both leave out a key whose value is undefined, as JSON.stringify does (an
// absent optional field). Anything else that is not plain JSON (a non-finite
// number, undefined in an array, a Date, a Buffer, a class instance, a
// function) is refused instead of coerced.

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

/** `value` as JSON in its own key order; throws "Invalid command: …" on what is not plain JSON. */
export function plainJson(value: unknown): string {
  return encode(value, '$', false)
}

/** `value` as canonical JSON (keys sorted); throws like plainJson. */
export function canonicalJson(value: unknown): string {
  return encode(value, '$', true)
}

function encode(v: unknown, path: string, sortKeys: boolean): string {
  if (v === null) return 'null'
  switch (typeof v) {
    case 'string':
      return JSON.stringify(v)
    case 'boolean':
      return v ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(v)) refuse(path, String(v))
      return JSON.stringify(v)
    case 'object': {
      if (Array.isArray(v)) {
        return `[${v.map((item, i) => {
          if (item === undefined) refuse(`${path}[${i}]`, 'undefined')
          return encode(item, `${path}[${i}]`, sortKeys)
        }).join(',')}]`
      }
      const proto = Object.getPrototypeOf(v)
      if (proto !== Object.prototype && proto !== null) refuse(path, (v as object).constructor?.name ?? 'an object')
      const obj = v as Record<string, unknown>
      const keys = Object.keys(obj).filter(k => obj[k] !== undefined)
      // default sort compares UTF-16 code units, as JCS orders keys
      if (sortKeys) keys.sort()
      return `{${keys.map(k => `${JSON.stringify(k)}:${encode(obj[k], `${path}.${k}`, sortKeys)}`).join(',')}}`
    }
    default:
      return refuse(path, typeof v)
  }
}

function refuse(path: string, what: string): never {
  throw new Error(`Invalid command: the input must be plain JSON; ${path} is ${what}.`)
}
