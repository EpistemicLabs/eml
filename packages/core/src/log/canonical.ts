// --- Canonical JSON (v0.21) ------------------------------------------------------
//
// The one byte form the op log hashes: object keys sorted by UTF-16 code unit,
// no whitespace, strings and numbers as JSON.stringify prints them — RFC 8785
// (JCS) for the values an op carries. A key whose value is undefined is left
// out, as JSON.stringify does (an absent optional field). Anything else that is
// not plain JSON (a non-finite number, undefined in an array, a Date, a Buffer,
// a class instance, a function) is refused instead of coerced, so a payload
// means and hashes the same everywhere.

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

/** `value` as canonical JSON; throws "Invalid command: …" on what is not plain JSON. */
export function canonicalJson(value: unknown): string {
  return encode(value, '$')
}

function encode(v: unknown, path: string): string {
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
          return encode(item, `${path}[${i}]`)
        }).join(',')}]`
      }
      const proto = Object.getPrototypeOf(v)
      if (proto !== Object.prototype && proto !== null) refuse(path, (v as object).constructor?.name ?? 'an object')
      const obj = v as Record<string, unknown>
      // default sort compares UTF-16 code units, as JCS orders keys
      const keys = Object.keys(obj).filter(k => obj[k] !== undefined).sort()
      return `{${keys.map(k => `${JSON.stringify(k)}:${encode(obj[k], `${path}.${k}`)}`).join(',')}}`
    }
    default:
      return refuse(path, typeof v)
  }
}

function refuse(path: string, what: string): never {
  throw new Error(`Invalid command: the input must be plain JSON; ${path} is ${what}.`)
}
