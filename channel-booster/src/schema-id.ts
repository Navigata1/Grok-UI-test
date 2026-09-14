/** Small stable hash for deterministic ids (FNV-1a, 32-bit, base36). Free of zod so browser bundles can use it. */
export function stableId(prefix: string, text: string): string {
  let h = 0x811c9dc5
  const s = text.trim().toLowerCase()
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `${prefix}:${h.toString(36)}`
}
