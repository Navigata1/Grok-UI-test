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

/**
 * Score a thumbnail concept before anyone opens Photoshop.
 *
 * The rules encode the "clean thumbnail" school: one focal subject, at most
 * three elements, three words or fewer, high contrast, and text that adds
 * something the title does not already say.
 */
export function qaThumbnail(spec: ThumbnailSpec): ThumbnailQa {
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

  const looksLikePerson = /\b(me|my face|face|person|host|creator|guy|girl|man|woman|kid|him|her|reaction|i\b)/i.test(spec.focalSubject)
  if (looksLikePerson) {
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
