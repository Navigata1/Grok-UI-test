import { tagged, thresholds } from './thresholds.js'
import type { TitleCandidate, TitleLabInput, TitleShape } from './types.js'

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
  /** A worked title in this shape from playbook/title-formulas.md, so a person sees the verb and the article adapted, not pasted. */
  example?: string
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
  { name: 'first-person test', build: (i) => `I Tried ${i.topic}${i.number ? ` for ${i.number}` : ''}`, example: 'I Tried 30 Days of Cold Showers' },
  { name: 'result reveal', build: (i) => (i.number ? `${cap(i.topic)}: ${i.number} Later` : undefined), example: 'Cold Showers: 30 Days Later' },
  { name: 'why question', build: (i) => `Why ${cap(i.topic)} Is Not What You Think`, example: 'Why Cold Showers Are Not What You Think' },
  { name: 'nobody tells you', build: (i) => `What Nobody Tells You About ${cap(i.topic)}`, example: 'What Nobody Tells You About Cold Showers' },
  { name: 'mistake frame', build: (i) => `The ${cap(i.topic)} Mistake Everyone Makes`, example: 'The Cold Shower Mistake Everyone Makes' },
  { name: 'ranked list', build: (i) => (i.number ? `${i.number} ${cap(i.topic)} Ideas Ranked Worst to Best` : undefined), example: '7 Cold Therapies Ranked Worst to Best' },
  { name: 'until/stakes', build: (i) => `I Did ${cap(i.topic)} Until It Worked`, example: 'I Took Cold Showers Until It Worked' },
  { name: 'contrast', build: (i) => (i.subject ? `${i.subject} vs ${cap(i.topic)}: Not Even Close` : `Cheap vs Expensive ${cap(i.topic)}`), example: 'Ice Bath vs Cold Shower: Not Even Close' },
  { name: 'identity', build: (i) => (i.audience ? `${cap(i.topic)} for ${i.audience} (Start Here)` : undefined), example: 'Cold Showers for Runners (Start Here)' },
  { name: 'truth bomb', build: (i) => `The Truth About ${cap(i.topic)}`, example: 'The Truth About Cold Showers' },
  { name: 'timebox', build: (i) => (i.number ? `${cap(i.topic)} in ${i.number}` : `${cap(i.topic)} in 24 Hours`), example: 'Cold Adaptation in 14 Days' },
  { name: 'how I', build: (i) => `How I ${cap(i.topic)} (Step by Step)`, example: 'How I Stopped Dreading Cold Showers' },
  { name: 'stop doing', build: (i) => `Stop ${cap(i.topic)} Like This`, example: 'Stop Taking Cold Showers Like This' },
  { name: 'proof', build: (i) => `${cap(i.topic)}. I Have Proof.`, example: 'Cold Showers Work. I Have Proof.' },
  { name: 'subject spotlight', build: (i) => (i.subject ? `${i.subject} Changed How I Think About ${cap(i.topic)}` : undefined) },
]

/** What a shape leaves where the topic goes. */
export const TITLE_BLANK = '___'

/**
 * The formulas as shapes a person writes from: a blank where the topic goes,
 * the number, subject and audience filled in when given, and the playbook's
 * worked example. A formula cannot conjugate a verb or drop an article, so a
 * topic pasted into it reads as a template fill ("I Did A $300 solar
 * generator Until It Worked"); offline, `booster titles` and the package sheet
 * show these instead. Not scored and not ranked: the order is the formula order.
 */
export function titleShapes(input: Omit<TitleLabInput, 'topic'> = {}): TitleShape[] {
  const seen = new Set<string>()
  const out: TitleShape[] = []
  for (const formula of TITLE_FORMULAS) {
    const title = formula.build({ ...input, topic: TITLE_BLANK })
    if (!title || seen.has(title.toLowerCase())) continue
    seen.add(title.toLowerCase())
    out.push({ title, formula: formula.name, ...(formula.example ? { example: formula.example } : {}), template: true, score: null })
  }
  return out
}

/**
 * Points a template fill loses, on top of being held under the title gate
 * (house). Big enough that a fill carrying every bonus (100) still lands
 * under the house gate, and fills stay ordered among themselves.
 */
export const TEMPLATE_FILL_PENALTY = 45

/** A word with its edge punctuation stripped, lowercased: "(Step" -> "step", "Proof." -> "proof", "I-95" stays "i-95". */
function norm(raw: string): string {
  return raw.toLowerCase().replace(/^[^a-z0-9$]+|[^a-z0-9]+$/g, '')
}

/** "I", "I'm", "I've": capitalised in every case style, so never evidence of Title Case. */
function isFirstPerson(word: string): boolean {
  return /^i(['\u2019][a-z]+)?$/.test(word)
}

/**
 * The words the formulas write around the topic ("did", "until", "it",
 * "worked", "is", "not", "what", "you", "think", ...). Derived from
 * TITLE_FORMULAS with every optional field given and with none (the contrast
 * formula writes "Cheap vs Expensive" only without a subject), so a new
 * formula brings its frame with it.
 */
const FRAME_WORDS: ReadonlySet<string> = new Set(
  [{ topic: '_', number: '_', subject: '_', audience: '_' }, { topic: '_' }]
    .flatMap((probe) => TITLE_FORMULAS.flatMap((f) => (f.build(probe) ?? '').split(/\s+/)))
    .map(norm)
    .filter((w) => /^[a-z]/.test(w)),
)

/** Function words: a lowercase run of these ("a", "for the") is not a phrase, and a title-cased one is house style, not a fill. */
const FUNCTION_WORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'nor', 'so', 'if', 'as', 'than', 'then', 'vs',
  'of', 'for', 'to', 'in', 'on', 'at', 'by', 'with', 'from', 'off', 'up', 'out', 'into', 'onto', 'over', 'per', 'via',
  'about', 'after', 'before', 'under', 'until', 'without', 'within', 'through', 'between', 'during', 'against', 'around',
  'is', 'are', 'was', 'were', 'be', 'been', 'am', 'do', 'does', 'did', 'has', 'have', 'had', 'can', 'will', 'not', 'no',
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'his', 'she', 'her', 'it', 'its', 'they', 'their', 'this', 'that', 'these', 'those',
])

const ARTICLES: ReadonlySet<string> = new Set(['a', 'an', 'the'])
const SUBJECT_PRONOUNS: ReadonlySet<string> = new Set(['i', 'we', 'he', 'she', 'they'])
/** Frame words a subject pronoun can never follow: "Tried I", "About I", "vs We", "The I". */
const NO_PRONOUN_AFTER: ReadonlySet<string> = new Set(['tried', 'stop', 'about', 'vs', 'the', 'a', 'an', 'cheap', 'expensive'])
/** Words an article can never follow, whatever the case: "The A", "Expensive A". */
const NO_ARTICLE_AFTER: ReadonlySet<string> = new Set(['a', 'an', 'the', 'cheap', 'expensive'])
/** Base-form verbs that end in -ing, so "How I Bring ..." is not read as a gerund. */
const ING_VERBS: ReadonlySet<string> = new Set(['bring', 'cling', 'fling', 'ring', 'sing', 'sling', 'spring', 'sting', 'string', 'swing', 'wing', 'wring'])

interface Token {
  raw: string
  word: string
  /**
   * First letter upper- or lowercase; `other` for numbers, prices, symbols, brand spellings ("iPhone",
   * "eBay") and all-caps words of two or more letters ("NOT", "WORST", "USB"): emphasis or an acronym,
   * written the same in every case style, so never evidence of Title Case.
   */
  kind: 'cap' | 'lower' | 'other'
  /** First word of the title or of a sentence inside it (after . ! ? : ; or a dash), where every case style capitalises. */
  start: boolean
}

function tokenize(title: string): Token[] {
  const raws = title.split(/\s+/).filter(Boolean)
  return raws.map((raw, i) => {
    const prev = raws[i - 1]
    const bare = raw.replace(/^[^A-Za-z0-9$]+/, '')
    const first = bare.charAt(0)
    const letters = bare.replace(/[^A-Za-z]/g, '')
    const shouted = letters.length >= 2 && letters === letters.toUpperCase()
    return {
      raw,
      word: norm(raw),
      kind: shouted ? 'other' : /[A-Z]/.test(first) ? 'cap' : /[a-z]/.test(first) && !/[A-Z]/.test(bare) ? 'lower' : 'other',
      start: prev === undefined || /[.!?:;]$/.test(prev) || /^[-\u2013\u2014|/]+$/.test(prev),
    }
  })
}

/**
 * Template-fill artifacts: what a formula leaves when a topic is pasted into
 * it rather than written into it. One note per artifact found; empty for a
 * title written in consistent Title Case or sentence case.
 *
 *   mixed case   a title-cased frame word ("Did", "Until", "Is", "Tried") in a
 *                title that also has a lowercase phrase of two or more content
 *                words ("solar generator"), or one lowercase word right after a
 *                capitalised topic word ("Cold showers"): Title Case and
 *                sentence case at once. An all-caps word ("are NOT worth it")
 *                is emphasis, not Title Case
 *   pronoun      a subject pronoun straight after a frame word ("Tried I",
 *                "About I", "I Did I"): the topic was pasted in as a sentence
 *   article      two articles in a row ("The A"), an article after "Cheap" or
 *                "Expensive", or a capitalised article after "I Did" / "Stop"
 *                with a lowercase content word later ("I Did A $300 solar
 *                generator"): the topic was pasted in with its article. In
 *                Start Case ("I Did A Backflip Every Day") the capital is style
 *   how I        "How I" followed by an article, a pronoun or a gerund
 *                ("How I Living off ..."): the formula needs a past-tense verb
 *   doubled      the same number phrase twice in one sentence, or at most one
 *                word apart ("30 days for 30 days", "30 Days: 30 Days Later"):
 *                the number was pasted into a topic that already carried it. A
 *                person restating it in a new sentence ("30 Days Of Cold
 *                Showers: What 30 Days Did To Me") and a comparison ("$300 vs
 *                $3000 Solar Generator") are left alone
 *
 * Pronoun and article pairs never span a sentence break: after "Cheap vs
 * Expensive:" or "Cheap?" a new sentence may open on "The", "A" or "We". A
 * sentence-case title with a proper noun that happens to be a frame word
 * ("Best Buy") next to a lowercase phrase is the known false positive.
 */
export function templateArtifacts(title: string): string[] {
  const toks = tokenize(title.trim())
  const found: string[] = []

  // A capitalised article is no evidence: "The" opens proper names ("I tried The Home Edit method").
  const frameCaps = toks.filter((t) => t.kind === 'cap' && !t.start && !isFirstPerson(t.word) && !ARTICLES.has(t.word) && FRAME_WORDS.has(t.word))
  if (frameCaps.length > 0) {
    // The stretches of the title with no capitalised word in them ("I" does not break one), scored by
    // content words. A capitalised topic word just before a stretch that opens on a lowercase content
    // word joins it: the formula capitalised "cold" and left "showers" as the topic wrote it.
    const isContent = (t: Token | undefined): boolean => t !== undefined && t.kind === 'lower' && !FUNCTION_WORDS.has(t.word)
    let best: Token[] = []
    let bestContent = 0
    let run: Token[] = []
    let lead: Token | undefined
    for (const t of [...toks, undefined]) {
      if (t === undefined || (t.kind === 'cap' && !isFirstPerson(t.word))) {
        const joined = lead && !lead.start && !FRAME_WORDS.has(lead.word) && isContent(run[0]) ? [lead, ...run] : run
        const n = joined.filter((x) => x === lead || isContent(x)).length
        if (n > bestContent) {
          best = joined
          bestContent = n
        }
        run = []
        lead = t
      } else run.push(t)
    }
    if (bestContent >= 2) {
      found.push(`template fill: Title Case frame words (${[...new Set(frameCaps.map((t) => t.raw.replace(/[^A-Za-z']/g, '')))].join(', ')}) around the lowercase phrase "${best.map((t) => t.raw).join(' ')}"; write the whole title in one case`)
    }
  }

  const comparison = toks.some((t) => t.word === 'vs' || t.word === 'versus' || t.word === 'or')
  const pairs = toks.slice(1).map((t, i) => `${toks[i]!.word} ${t.word}`)
  const weight = (p: string): number => p.split(' ').filter((w) => !FUNCTION_WORDS.has(w)).length
  // Name the doubled pair with the most content in it: "30 days", not "for 30". The second copy (pair j,
  // j >= i + 2 leaves j - i - 2 words between) starts at most one word after the first ends, or in the
  // same sentence; a person restating the number after a colon or a full stop is writing, not pasting.
  const sameSentence = (i: number, j: number): boolean => !toks.slice(i + 1, j + 1).some((t) => t.start)
  const doubled = comparison ? undefined : pairs.filter((p, i) => /\d/.test(p) && pairs.some((q, j) => j >= i + 2 && q === p && (j <= i + 3 || sameSentence(i, j)))).sort((x, y) => weight(y) - weight(x))[0]
  if (doubled) found.push(`template fill: "${doubled}" appears twice; the formula pasted it into a topic that already had it`)

  // A lowercase content word after token i: the rest of the topic kept its own case, so a capital right after the frame was cap(), not style.
  const lowerContentAfter = (i: number): boolean => toks.slice(i + 1).some((t) => t.kind === 'lower' && !FUNCTION_WORDS.has(t.word))
  for (let i = 0; i + 1 < toks.length; i += 1) {
    const a = toks[i]!
    const b = toks[i + 1]!
    // A new sentence ("Cheap vs Expensive: The ...", "Cheap? A ...", "Expensive. We ...") opens on any word.
    if (b.start) continue
    const before = toks[i - 1]?.word
    const afterIDid = a.word === 'did' && (before === 'i' || before === 'we')
    const afterHowI = a.word === 'i' && before === 'how'
    const pair = `${afterHowI ? `${toks[i - 1]!.raw} ` : ''}${a.raw} ${b.raw}`
    if (SUBJECT_PRONOUNS.has(b.word) && (NO_PRONOUN_AFTER.has(a.word) || afterIDid || afterHowI)) {
      found.push(`template fill: "${pair}" puts a pronoun straight after the frame; the topic was pasted in as a sentence`)
    } else if (ARTICLES.has(b.word) && (NO_ARTICLE_AFTER.has(a.word) || afterHowI || ((afterIDid || a.word === 'stop') && b.kind === 'cap' && lowerContentAfter(i + 1)))) {
      found.push(`template fill: "${pair}" starts the pasted-in topic with its article; no article belongs after "${a.raw}" here`)
    } else if (afterHowI && b.kind !== 'other' && b.word.length > 4 && b.word.endsWith('ing') && !ING_VERBS.has(b.word)) {
      found.push(`template fill: "How I ${b.raw}" needs a past-tense verb after "How I" (How I Built ..., not How I Building ...)`)
    }
  }
  return found
}

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
  } else if (len > maxChars) {
    // The band just past the limit used to score +5 silently, so `titles score` reported no
    // length problem on a title the publish checklist then rejected.
    score -= 5
    notes.push(`over ${maxChars} chars (${len}): the end of the promise starts truncating on a phone`)
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
  // A template fill is a shape with a topic pasted in, not a title: the bonuses above are lexical and
  // would rate it 85-93, so it loses the penalty and stays under the gate even where a profile lowers it.
  const artifacts = templateArtifacts(title)
  if (artifacts.length > 0) {
    score = Math.min(score - TEMPLATE_FILL_PENALTY, thresholds.titleGateScore.value - 1)
    notes.push(...artifacts, `template fill: held under the title gate (${tagged('titleGateScore')}); write the title in your own words`)
  }
  return { score: Math.max(0, Math.min(100, score)), notes }
}

/**
 * Fill every formula with the topic and rank the fills. A formula cannot
 * conjugate a verb or drop an article, so most fills are drafts, and
 * scoreTitle() holds the ones that read as template fills under the gate.
 * The CLI prints titleShapes() instead and never chooses a fill for a package.
 */
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
