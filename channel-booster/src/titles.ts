import { thresholds } from './thresholds.js'
import type { TitleCandidate, TitleLabInput } from './types.js'

/** Words that signal curiosity, stakes, or specificity. Scored, not required. */
const POWER_WORDS = [
  'secret', 'truth', 'nobody', 'never', 'stop', 'why', 'actually', 'real', 'hidden', 'mistake', 'mistakes', 'worst', 'best',
  'impossible', 'insane', 'finally', 'exposed', 'proof', 'proved', 'wrong', 'until', 'before', 'after', 'only', 'every',
  'free', 'cheap', 'expensive', 'fastest', 'easiest', 'hardest', 'first', 'last', 'ultimate', 'brutal', 'honest',
]

const GENERIC_WORDS = ['video', 'vlog', 'episode', 'update', 'part', 'ep', 'my channel', 'new video', 'introduction']

interface Formula {
  name: string
  build: (input: TitleLabInput) => string | undefined
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * Title formulas. Each one encodes a psychological lever the audience
 * responds to (curiosity gap, stakes, specificity, contrast, identity).
 * Formulas that need a field the input lacks return undefined and are skipped.
 */
export const TITLE_FORMULAS: Formula[] = [
  { name: 'first-person test', build: (i) => `I Tried ${i.topic}${i.number ? ` for ${i.number}` : ''}` },
  { name: 'result reveal', build: (i) => (i.number ? `${cap(i.topic)}: ${i.number} Later` : undefined) },
  { name: 'why question', build: (i) => `Why ${cap(i.topic)} Is Not What You Think` },
  { name: 'nobody tells you', build: (i) => `What Nobody Tells You About ${cap(i.topic)}` },
  { name: 'mistake frame', build: (i) => `The ${cap(i.topic)} Mistake Everyone Makes` },
  { name: 'ranked list', build: (i) => (i.number ? `${i.number} ${cap(i.topic)} Ideas Ranked Worst to Best` : undefined) },
  { name: 'until/stakes', build: (i) => `I Did ${cap(i.topic)} Until It Worked` },
  { name: 'contrast', build: (i) => (i.subject ? `${i.subject} vs ${cap(i.topic)}: Not Even Close` : `Cheap vs Expensive ${cap(i.topic)}`) },
  { name: 'identity', build: (i) => (i.audience ? `${cap(i.topic)} for ${i.audience} (Start Here)` : undefined) },
  { name: 'truth bomb', build: (i) => `The Truth About ${cap(i.topic)}` },
  { name: 'timebox', build: (i) => (i.number ? `${cap(i.topic)} in ${i.number}` : `${cap(i.topic)} in 24 Hours`) },
  { name: 'how I', build: (i) => `How I ${cap(i.topic)} (Step by Step)` },
  { name: 'stop doing', build: (i) => `Stop ${cap(i.topic)} Like This` },
  { name: 'proof', build: (i) => `${cap(i.topic)}. I Have Proof.` },
  { name: 'subject spotlight', build: (i) => (i.subject ? `${i.subject} Changed How I Think About ${cap(i.topic)}` : undefined) },
]

/** Heuristic score for a single title. 0-100. Notes explain every deduction and bonus. */
export function scoreTitle(title: string): { score: number; notes: string[] } {
  const notes: string[] = []
  let score = 50
  const len = title.length
  const lower = title.toLowerCase()
  const words = lower.split(/\s+/).filter(Boolean)

  const minChars = thresholds.titleMinChars.value
  const maxChars = thresholds.titleMaxChars.value
  if (len >= minChars && len <= maxChars) {
    score += 15
    notes.push(`length in the mobile sweet spot (${minChars}-${maxChars} chars)`)
  } else if (len > maxChars + 10) {
    score -= 15
    notes.push(`too long (${len} chars): truncates on mobile and in suggested`)
  } else if (len < 20) {
    score -= 10
    notes.push(`too short (${len} chars): no promise to click on`)
  } else {
    score += 5
  }

  if (/\d/.test(title)) {
    score += 10
    notes.push('contains a number (specificity)')
  }
  const power = words.filter((w) => POWER_WORDS.includes(w.replace(/[^a-z]/g, '')))
  if (power.length > 0) {
    score += Math.min(15, power.length * 8)
    notes.push(`curiosity or stakes words: ${[...new Set(power)].join(', ')}`)
  }
  if (/^(i|why|how|what|the|stop|nobody)\b/i.test(title)) {
    score += 5
    notes.push('front-loaded hook word')
  }
  const capsWords = title.split(/\s+/).filter((w) => w.length > 2 && w === w.toUpperCase() && /[A-Z]/.test(w))
  if (capsWords.length > 1) {
    score -= 10
    notes.push('shouting: more than one ALL-CAPS word')
  }
  if (/!{1,}/.test(title)) {
    score -= 8
    notes.push('exclamation marks read as clickbait')
  }
  if (GENERIC_WORDS.some((g) => lower.includes(g))) {
    score -= 12
    notes.push('generic word (video, vlog, episode...) wastes characters')
  }
  if (/\b(you|your)\b/i.test(title) || /\b(i|my)\b/i.test(title)) {
    score += 5
    notes.push('addresses a person (you / I)')
  }
  const uniqueRatio = new Set(words).size / Math.max(1, words.length)
  if (uniqueRatio < 0.8) {
    score -= 5
    notes.push('repeated words')
  }
  return { score: Math.max(0, Math.min(100, score)), notes }
}

/** Generate and rank title candidates for an idea. */
export function generateTitles(input: TitleLabInput): TitleCandidate[] {
  const seen = new Set<string>()
  const out: TitleCandidate[] = []
  for (const formula of TITLE_FORMULAS) {
    const title = formula.build(input)
    if (!title) continue
    const key = title.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const { score, notes } = scoreTitle(title)
    out.push({ title, formula: formula.name, score, notes })
  }
  return out.sort((a, b) => b.score - a.score)
}

/**
 * Title and thumbnail should say different things: the thumbnail shows,
 * the title tells. Returns the share of meaningful title words repeated
 * in the thumbnail text (0 = fully complementary, 1 = pure repetition).
 */
const STOP_WORDS = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'and', 'is', 'it', 'my', 'i', 'you', 'this', 'that', 'with', 'was', 'are', 'but', 'not', 'your', 'our'])

/** Content tokens of a string: lowercase words longer than two letters, stop words removed. */
export function tokens(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9$]+/).filter((w) => w.length > 2 && !STOP_WORDS.has(w))
}

export function titleThumbnailOverlap(title: string, thumbnailText: string | undefined): number {
  if (!thumbnailText) return 0
  const t = tokens(thumbnailText)
  if (t.length === 0) return 0
  const titleSet = new Set(tokens(title))
  const repeated = t.filter((w) => titleSet.has(w)).length
  return repeated / t.length
}
