import type { Signature } from './schema.js'
import { checkSignature, describeSignature, looksLikePerson } from './signature.js'
import { titleThumbnailOverlap } from './titles.js'
import type { ThumbnailBrief, ThumbnailConcept, ThumbnailQa, ThumbnailSpec } from './types.js'

/** Colour pairs that read at 120px wide on a phone. Order does not matter. */
const HIGH_CONTRAST_PAIRS: Array<[string, string]> = [
  ['yellow', 'black'], ['yellow', 'blue'], ['yellow', 'purple'], ['white', 'black'], ['white', 'red'], ['white', 'blue'],
  ['white', 'green'], ['orange', 'blue'], ['orange', 'black'], ['red', 'black'], ['red', 'white'], ['cyan', 'black'],
  ['green', 'black'], ['black', 'yellow'], ['pink', 'black'], ['lime', 'black'], ['gold', 'black'],
]

const LOW_CONTRAST_PAIRS: Array<[string, string]> = [
  ['red', 'green'], ['blue', 'purple'], ['grey', 'white'], ['gray', 'white'], ['grey', 'black'], ['gray', 'black'],
  ['blue', 'black'], ['green', 'blue'], ['brown', 'black'], ['brown', 'red'], ['orange', 'red'], ['orange', 'yellow'],
]

const BUSY_WORDS = ['busy', 'cluttered', 'crowd', 'crowded', 'lots', 'many', 'collage', 'pattern', 'detailed']

function pairMatches(colors: string[], pairs: Array<[string, string]>): boolean {
  const set = colors.map((c) => c.toLowerCase().trim())
  return pairs.some(([a, b]) => set.includes(a) && set.includes(b))
}

/** Points deducted when a concept drifts from the channel signature [house]. A deliberate drift is written on the proof sheet. */
const SIGNATURE_DRIFT_PENALTY = 10

/**
 * Score a thumbnail concept before anyone opens Photoshop.
 *
 * The rules encode the "clean thumbnail" school: one focal subject, at most
 * three elements, three words or fewer, high contrast, and text that adds
 * something the title does not already say. With a channel `signature`
 * (channel.json) the concept is also checked against the registered colour
 * pair, word budget and face policy; drift costs 10 and is reported as
 * "signature drift: ..." so a deliberate drift can be written on the sheet.
 */
export function qaThumbnail(spec: ThumbnailSpec, signature?: Signature): ThumbnailQa {
  const passes: string[] = []
  const failures: string[] = []
  const fixes: string[] = []
  let score = 100

  if (!spec.focalSubject || spec.focalSubject.trim().length === 0) {
    score -= 30
    failures.push('no focal subject')
    fixes.push('Name the one thing the eye lands on first. If you cannot, the concept is a collage, not a thumbnail.')
  } else {
    passes.push(`focal subject: ${spec.focalSubject}`)
  }

  const elementCount = spec.elements.filter((e) => e.trim()).length
  if (elementCount <= 3) {
    passes.push(`${elementCount} element(s): reads at a glance`)
  } else if (elementCount === 4) {
    score -= 10
    failures.push('4 elements: borderline')
    fixes.push('Cut one element. Ask which of the four the video would still work without.')
  } else {
    score -= 25
    failures.push(`${elementCount} elements: cluttered`)
    fixes.push('Reduce to three elements: subject, one supporting object, optional text.')
  }

  const words = (spec.text ?? '').trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) {
    passes.push('no text: the image carries it')
  } else if (words.length <= 3) {
    passes.push(`text is ${words.length} word(s)`)
  } else if (words.length <= 5) {
    score -= 10
    failures.push(`${words.length} words of text: hard to read on mobile`)
    fixes.push('Cut the text to three words or fewer. Keep the noun or the number, drop the verbs.')
  } else {
    score -= 25
    failures.push(`${words.length} words of text: unreadable at phone size`)
    fixes.push('Text is a title, not a thumbnail. Keep at most three words and let the title do the telling.')
  }

  if (spec.title && words.length > 0) {
    const overlap = titleThumbnailOverlap(spec.title, spec.text)
    if (overlap >= 0.67) {
      score -= 15
      failures.push('thumbnail text repeats the title')
      fixes.push('Make the text say something the title does not: the stake, the number, the reaction, or the object.')
    } else {
      passes.push('thumbnail text complements the title')
    }
  }

  if (looksLikePerson(spec.focalSubject)) {
    if (!spec.emotion || /^(none|neutral|flat|no)/i.test(spec.emotion)) {
      score -= 15
      failures.push('a face with no expression')
      fixes.push('Give the face a readable, specific emotion that matches the promise (shock, doubt, pride, fear). Neutral faces do not get clicks.')
    } else {
      passes.push(`emotion: ${spec.emotion}`)
    }
  }

  if (spec.colors && spec.colors.length >= 2) {
    if (pairMatches(spec.colors, LOW_CONTRAST_PAIRS) && !pairMatches(spec.colors, HIGH_CONTRAST_PAIRS)) {
      score -= 15
      failures.push(`low-contrast colour pair: ${spec.colors.join(' / ')}`)
      fixes.push('Push the subject and background to opposite ends of brightness: light subject on dark ground or the reverse.')
    } else if (pairMatches(spec.colors, HIGH_CONTRAST_PAIRS)) {
      passes.push(`high-contrast pair: ${spec.colors.join(' / ')}`)
    }
  }

  if (spec.background && BUSY_WORDS.some((w) => spec.background!.toLowerCase().includes(w))) {
    score -= 10
    failures.push('busy background')
    fixes.push('Blur, darken, or simplify the background so the subject separates from it.')
  }

  if (signature) {
    const check = checkSignature(spec, signature)
    if (check.drift) {
      score -= SIGNATURE_DRIFT_PENALTY
      failures.push(`signature drift: ${check.reasons.join('; ')}`)
      fixes.push(`Match the channel signature (${describeSignature(signature).replace(/^Keep the channel signature: /, '').replace(/\.$/, '')}) or write the deliberate drift on the proof sheet.`)
    } else {
      passes.push('matches the channel signature')
    }
  }

  score = Math.max(0, Math.min(100, score))
  const grade: ThumbnailQa['grade'] = score >= 80 ? 'ship' : score >= 60 ? 'revise' : 'rethink'
  return { score, grade, passes, failures, fixes }
}

/** The design rules every brief ships with. Kept as data so the skills and docs stay in sync. */
export const THUMBNAIL_RULES: string[] = [
  'One focal subject. The eye must land somewhere in under a second.',
  'At most three elements: subject, one supporting object or reaction, optional text.',
  'Three words of text or fewer. The title tells; the thumbnail shows.',
  'Thumbnail and title say different things. Never repeat the title on the image.',
  'High contrast between subject and background. Check it at 120px wide.',
  'Faces need a specific, readable emotion that matches the promise.',
  'Clean background: blurred, darkened, or a flat gradient. Clutter kills clicks.',
  'Design for the phone first: safe margins, no thin lines, no small text.',
  'One idea per thumbnail. If it needs explaining, it is two thumbnails.',
  'Consistent visual signature across the channel (colour, framing, type) so returning viewers recognise you in the feed.',
]

export const THUMBNAIL_QA_CHECKLIST: string[] = [
  'Readable at 120px wide on a phone screenshot?',
  'Does it make a promise the video keeps?',
  'Would you click it next to the top three competing videos?',
  'Is the subject separated from the background?',
  'Is there exactly one idea?',
  'Is the text three words or fewer and different from the title?',
  'Exported at 1280x720, under 2MB, no important element in the bottom-right corner (timestamp overlay)?',
]

export const THUMBNAIL_TEST_PLAN: string[] = [
  'Ship the strongest concept as A and the most different concept as B in YouTube Test & Compare (up to three variants).',
  'Let the test run until YouTube declares a winner on watch-time share; do not stop it on CTR alone.',
  'If CTR rises but average view duration falls, the winner over-promises: revise the hook or the concept, not just the thumbnail.',
  'Log the winner and the losing concept in the packaging ledger so the next brief starts from evidence.',
]

/** Build five concepts, each pulling a different psychological lever. */
export function buildThumbnailBrief(idea: string, title: string, options: { subject?: string; stake?: string; result?: string } = {}): ThumbnailBrief {
  const subject = options.subject ?? 'the creator'
  const stake = options.stake ?? 'what could go wrong'
  const result = options.result ?? 'the end result'
  const concepts: ThumbnailConcept[] = [
    {
      name: 'The Result',
      angle: 'result',
      focalSubject: result,
      supportingElement: `${subject} reacting to it`,
      text: '',
      composition: 'Result fills 60% of the frame, subject in the lower third, background blurred.',
      whyItWorks: 'Shows the payoff so the title can sell the journey.',
    },
    {
      name: 'The Stakes',
      angle: 'stakes',
      focalSubject: subject,
      supportingElement: stake,
      text: 'Or Else',
      composition: 'Subject centre-left with a worried expression, the threat entering from the right edge.',
      whyItWorks: 'Fear of loss outperforms promise of gain in the feed.',
    },
    {
      name: 'The Curiosity Gap',
      angle: 'curiosity',
      focalSubject: `${result}, partly hidden`,
      supportingElement: 'a red arrow or circle pointing at the hidden part',
      text: '?',
      composition: 'Hide the key detail behind a blur or a hand; the marker tells the viewer where to look.',
      whyItWorks: 'An unresolved image is only resolved by clicking.',
    },
    {
      name: 'The Contrast',
      angle: 'contrast',
      focalSubject: 'before / after split',
      supportingElement: 'a thin vertical divider',
      text: 'vs',
      composition: 'Left half dull and desaturated, right half bright and finished; same framing on both sides.',
      whyItWorks: 'The brain reads a split frame instantly and wants to know how.',
    },
    {
      name: 'The Identity',
      angle: 'identity',
      focalSubject: subject,
      supportingElement: 'the single object the audience recognises as their world',
      text: '',
      composition: 'Subject holding or standing next to the object, clean single-colour background in the channel colour.',
      whyItWorks: 'Viewers click on people who look like they belong to the same tribe.',
    },
  ]
  return {
    idea,
    title,
    concepts,
    rules: THUMBNAIL_RULES,
    qaChecklist: THUMBNAIL_QA_CHECKLIST,
    testPlan: THUMBNAIL_TEST_PLAN,
  }
}

/**
 * What `renderImagePrompts()` needs from a concept. Both a brief's
 * `ThumbnailConcept` and a QA `ThumbnailSpec` satisfy it, so the render hook
 * can take either the brief or the QA-passed specs.
 */
export interface ImagePromptConcept {
  name?: string
  focalSubject: string
  emotion?: string
  /** Every element when known (spec); otherwise derived from subject, supporting element and text. */
  elements?: string[]
  supportingElement?: string
  text?: string
  composition?: string
  background?: string
  /** Colour pair; falls back to the signature colours when absent. */
  colors?: string[]
}

function clean(s: string | undefined): string {
  return (s ?? '').trim().replace(/\s+/g, ' ')
}

/**
 * One image-generation prompt per concept (architecture 2.7 render hook), so
 * any external image tool can build the QA-passed concepts. Each prompt
 * states the subject, its expression, the elements, the colour pair, the
 * composition and background, a 16:9 1280x720 frame, and either the exact
 * text to set or "no text"; the signature sentence closes it. Pure string
 * work: the same input always yields the same prompts.
 */
export function renderImagePrompts(concepts: ImagePromptConcept[], signature?: Signature): string[] {
  const sigColors = (signature?.colors ?? []).map((c) => c.trim().toLowerCase()).filter(Boolean)
  return concepts.map((c) => {
    const subject = clean(c.focalSubject) || 'the focal subject'
    const emotion = clean(c.emotion)
    const text = clean(c.text)
    const elements = (c.elements && c.elements.length > 0
      ? c.elements
      : [c.focalSubject, c.supportingElement ?? '', text ? `the text "${text}"` : '']
    ).map(clean).filter(Boolean)
    const colors = (c.colors ?? []).map((x) => x.trim().toLowerCase()).filter(Boolean)
    const pair = colors.length > 0 ? colors : sigColors

    const lines: string[] = []
    lines.push(`${c.name ? `${clean(c.name)}: ` : ''}YouTube thumbnail, 16:9, 1280x720, photoreal, sharp, phone-first.`)
    lines.push(`Subject: ${subject}${emotion && !/^(none|neutral|flat|no)/i.test(emotion) ? `, expression ${emotion}` : ''}, filling the frame, separated from the background.`)
    lines.push(`Elements (${elements.length}): ${elements.join('; ')}. Nothing else in the frame.`)
    if (pair.length > 0) lines.push(`Colours: ${pair.join(' and ')}, high contrast, subject and background at opposite ends of brightness.`)
    if (clean(c.composition)) lines.push(`Composition: ${clean(c.composition)}`)
    if (clean(c.background)) lines.push(`Background: ${clean(c.background)}.`)
    lines.push(text
      ? `Text: exactly the words "${text}" in large bold type, readable at 120px wide, nowhere near the bottom-right corner. No other lettering.`
      : 'No text, no letters, no captions, no logos, no watermark.')
    lines.push('Safe margins, no thin lines, no small details, no clutter.')
    if (signature) lines.push(describeSignature(signature))
    return lines.join(' ')
  })
}
