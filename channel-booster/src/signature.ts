/**
 * Channel signature registry checks (architecture 2.7).
 *
 * `channel.json.signature` names the colour pair, the face policy, and the
 * word budget every thumbnail keeps so returning viewers recognise the
 * channel in the feed. `checkSignature()` compares a concept spec against it
 * deterministically; `describeSignature()` turns it into the one sentence
 * the thumbnail-factory prompt and the image prompts carry.
 *
 * Browser-safe: no Node imports.
 */
import type { Signature } from './schema.js'
import type { ThumbnailSpec } from './types.js'

/** Words in a focal subject that mean a person (and so a face) is in frame. Trailing boundary keeps "here", "meter", "herbs" out. */
const FACE_PATTERN = /\b(me|my face|face|person|host|creator|guy|girl|man|woman|kid|him|her|reaction|i)\b/i

/** True when the focal subject describes a person, so a face will be in the frame. */
export function looksLikePerson(focalSubject: string | undefined): boolean {
  return FACE_PATTERN.test(focalSubject ?? '')
}

export interface SignatureCheck {
  /** True when at least one signature rule is missed. */
  drift: boolean
  /** One short clause per missed rule, in a fixed order: colours, words, face. */
  reasons: string[]
}

function norm(colors: string[] | undefined): string[] {
  return (colors ?? []).map((c) => c.trim().toLowerCase()).filter(Boolean)
}

function wordCount(text: string | undefined): number {
  return (text ?? '').trim().split(/\s+/).filter(Boolean).length
}

/**
 * Compare a thumbnail concept against the channel signature.
 *
 * Rules, each producing one reason when missed:
 *  - colours: when the spec names colours, every signature colour must be among them
 *    (a spec with no colours is not judged; nothing is known about it yet);
 *  - words: the text may not exceed `signature.maxWords`;
 *  - face: with `facePolicy: 'never'` the focal subject may not be a person, with
 *    `'always'` it must be one; `'either'` is never drift.
 * A deliberate drift is allowed: it is written on the proof sheet, not hidden.
 */
export function checkSignature(spec: ThumbnailSpec, signature: Signature): SignatureCheck {
  const reasons: string[] = []

  const specColors = norm(spec.colors)
  const sigColors = norm(signature.colors)
  if (specColors.length > 0 && sigColors.length > 0) {
    const missing = sigColors.filter((c) => !specColors.includes(c))
    if (missing.length > 0) {
      reasons.push(`colours ${specColors.join('/')} miss the signature pair ${sigColors.join('/')} (no ${missing.join(', ')})`)
    }
  }

  const words = wordCount(spec.text)
  if (words > signature.maxWords) {
    reasons.push(`${words} words of text, signature allows at most ${signature.maxWords}`)
  }

  const face = looksLikePerson(spec.focalSubject)
  if (signature.facePolicy === 'never' && face) {
    reasons.push(`a face is in frame ("${spec.focalSubject.trim()}") but the signature never shows one`)
  } else if (signature.facePolicy === 'always' && !face) {
    reasons.push('no face in frame but the signature always shows one')
  }

  return { drift: reasons.length > 0, reasons }
}

/**
 * The signature as one sentence for prompts, e.g.
 * "Keep the channel signature: the yellow/black colour pair, always a face, at most 3 words of text, framing subject in the lower third, typeface condensed caps."
 * Injected under "Channel signature:" in the thumbnail-factory prompt and appended to every image prompt.
 */
export function describeSignature(signature: Signature): string {
  const parts: string[] = []
  const colors = norm(signature.colors)
  if (colors.length > 0) parts.push(`the ${colors.join('/')} colour ${colors.length > 1 ? 'pair' : 'accent'}`)
  parts.push(signature.facePolicy === 'always' ? 'always a face' : signature.facePolicy === 'never' ? 'never a face' : 'a face optional')
  parts.push(signature.maxWords === 0 ? 'no text' : `at most ${signature.maxWords} word${signature.maxWords === 1 ? '' : 's'} of text`)
  if (signature.framing?.trim()) parts.push(`framing ${signature.framing.trim()}`)
  if (signature.typeface?.trim()) parts.push(`typeface ${signature.typeface.trim()}`)
  if (signature.notes?.trim()) parts.push(signature.notes.trim().replace(/[.\s]+$/, ''))
  return `Keep the channel signature: ${parts.join(', ')}.`
}
