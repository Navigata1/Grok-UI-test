/**
 * Publish package (architecture 2.10).
 *
 * Assembles what YouTube Studio needs from the package artifacts so publishing
 * is copy-paste and the checklist (playbook/publish-checklist.md) is checked by
 * a machine, not a memory: description line 1 = the promise, chapters from the
 * story, a pinned-comment question the sequel answers, a community post, two
 * Shorts cut points from the strongest payoff moments, the publish window from
 * the profile's returning-viewer day, and Test & Compare instructions with A
 * and B named. Pure functions; nothing here touches the disk or the clock.
 *
 * Placeholders the human must replace are written in square brackets, so
 * `checkPublish()` can tell a chosen end-screen target from an unchosen one.
 */
import { checkPromise } from './promise.js'
import { tokens } from './titles.js'
import { TEST_RULES } from './experiments.js'
import { thresholds } from './thresholds.js'
import type { ProfileDoc } from './schema.js'
import type { ThumbnailQa } from './types.js'

/**
 * Numeric gates of the publish package. House defaults, owned here until the
 * thresholds owner moves them into thresholds.ts (see integration notes).
 */
export const PUBLISH_RULES = {
  shortsDurationSec: { value: 45, evidence: 'house', note: 'length of each Short cut from a payoff moment' },
  shortsCount: { value: 2, evidence: 'house', note: 'Shorts cut from the best moments, each pointing at the video (playbook)' },
  minChapters: { value: 3, evidence: 'unverified', note: 'YouTube needs at least three chapters, the first at 0:00, each at least 10 s' },
  minChapterGapSec: { value: 10, evidence: 'unverified', note: 'shortest chapter YouTube accepts' },
} as const

/** A chapter as the story report emits it. */
export interface PublishChapter {
  atSec: number
  title: string
}

/** A payoff-ladder moment from the story. `strength` (0-1) is optional; without it the promise decides. */
export interface PayoffMoment {
  atSec: number
  moment: string
  strength?: number
}

export interface PublishInput {
  title: string
  /** The one-sentence promise from the package. Becomes description line 1 verbatim. */
  promise: string
  chapters?: PublishChapter[]
  payoffLadder?: PayoffMoment[]
  /** The question the sequel will answer. Derived from the promise when absent. */
  sequelQuestion?: string
  /** Names of the two thumbnails in the Test & Compare, e.g. { a: 'stakes', b: 'result' }. */
  thumbs: { a: string; b: string }
  profile?: ProfileDoc
  /** The most related proven video (title or URL) the end screen points at. */
  relatedVideo?: string
}

export interface ShortsCut {
  atSec: number
  durationSec: number
  /** First line of the Short: the moment, phrased to send the viewer to the video. */
  hook: string
}

export interface PublishPack {
  title: string
  /** The promise, in plain words. */
  descriptionLine1: string
  /** Line 1, blank line, chapters as mm:ss lines, then the links placeholder. */
  description: string
  chapters: PublishChapter[]
  /** A question the sequel answers. */
  pinnedComment: string
  communityPost: string
  shortsCuts: ShortsCut[]
  /** Day and rule, e.g. "Thursday, when returning viewers are online (check Studio > Audience)". */
  publishWindow: string
  publishWindowSource: 'profile' | 'default'
  /** Test & Compare with A and B named, run until watch-time share decides. */
  abInstructions: string
  thumbs: { a: string; b: string }
  /** The related proven video, or a bracketed placeholder when none was given. */
  endScreenTarget: string
  /** The profile carries computed baselines, so the 48-hour review has its numbers. */
  baselineReady: boolean
}

const DAY_NAMES: Record<NonNullable<ProfileDoc['publishDay']>, string> = {
  mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday',
}

const DEFAULT_DAY = 'Thursday'
const WINDOW_RULE = 'when returning viewers are online (check Studio > Audience)'

/** Seconds as mm:ss (hh:mm:ss past an hour), the form YouTube reads as a chapter mark. */
export function mmss(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(r).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function plain(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function endsWithQuestion(s: string): string {
  const t = plain(s).replace(/[.!\s]+$/, '')
  return t.endsWith('?') ? t : `${t}?`
}

/**
 * Chapters sorted, de-duplicated by mark, with a 0:00 open when the story
 * starts later, and at least PUBLISH_RULES.minChapterGapSec apart: a beat that
 * lands inside the previous one's gap is dropped. `checkPublish()` enforces the
 * same gap, and a story segmented per paragraph routinely puts two beats eight
 * seconds apart, so without this `publish pack` writes a description the very
 * next command rejects.
 */
export function normaliseChapters(chapters: PublishChapter[] | undefined): PublishChapter[] {
  const seen = new Set<number>()
  const out: PublishChapter[] = []
  for (const c of [...(chapters ?? [])].sort((a, b) => a.atSec - b.atSec)) {
    const at = Math.max(0, Math.round(c.atSec))
    const title = plain(c.title)
    if (seen.has(at) || !title) continue
    seen.add(at)
    out.push({ atSec: at, title })
  }
  const minGap = PUBLISH_RULES.minChapterGapSec.value
  if (out.length > 0 && out[0].atSec !== 0) {
    // A first beat inside the minimum gap is the open; pulling it back to 0:00 keeps its title.
    if (out[0].atSec < minGap) out[0] = { atSec: 0, title: out[0].title }
    else out.unshift({ atSec: 0, title: 'Open' })
  }
  const spaced: PublishChapter[] = []
  for (const c of out) {
    const last = spaced[spaced.length - 1]
    if (last && c.atSec - last.atSec < minGap) continue
    spaced.push(c)
  }
  return spaced
}

/**
 * The two strongest payoff moments, in playing order. Strength: an explicit
 * `strength`, else how many promise words the moment carries, else later wins
 * (payoffs escalate; the biggest is in the final third). Falls back to
 * non-open chapters, then to the open itself, so there are always two cuts
 * when the story has two distinct marks.
 */
export function pickShortsCuts(promise: string, payoffLadder: PayoffMoment[] | undefined, chapters: PublishChapter[] = []): ShortsCut[] {
  const promiseSet = new Set(tokens(promise))
  const count = PUBLISH_RULES.shortsCount.value
  const duration = PUBLISH_RULES.shortsDurationSec.value
  const ranked = [...(payoffLadder ?? [])]
    .filter((m) => plain(m.moment).length > 0)
    .map((m) => ({ m, overlap: tokens(m.moment).filter((t) => promiseSet.has(t)).length }))
    .sort((x, y) => (y.m.strength ?? 0) - (x.m.strength ?? 0) || y.overlap - x.overlap || y.m.atSec - x.m.atSec)
  const picks: ShortsCut[] = []
  const used = new Set<number>()
  const add = (atSec: number, hook: string) => {
    const at = Math.max(0, Math.round(atSec))
    if (used.has(at) || picks.length >= count) return
    used.add(at)
    picks.push({ atSec: at, durationSec: duration, hook })
  }
  for (const { m } of ranked) add(m.atSec, `${cap(plain(m.moment))} (full video in the description)`)
  for (const c of chapters.filter((c) => c.atSec > 0).sort((a, b) => b.atSec - a.atSec)) add(c.atSec, `${cap(c.title)} (full video in the description)`)
  add(0, `${cap(plain(promise))} (full video in the description)`)
  return picks.sort((a, b) => a.atSec - b.atSec)
}

/** The publish window sentence for a profile day (default Thursday). */
export function publishWindowFor(profile: ProfileDoc | undefined): { publishWindow: string; source: PublishPack['publishWindowSource'] } {
  const day = profile?.publishDay
  if (day && DAY_NAMES[day]) return { publishWindow: `${DAY_NAMES[day]}, ${WINDOW_RULE}`, source: 'profile' }
  return { publishWindow: `${DEFAULT_DAY}, ${WINDOW_RULE}`, source: 'default' }
}

/** Assemble the publish pack from the package artifacts. See the module comment. */
export function assemblePublish(input: PublishInput): PublishPack {
  const title = plain(input.title)
  const promise = plain(input.promise)
  const chapters = normaliseChapters(input.chapters)
  const descriptionLine1 = promise
  const description = [
    descriptionLine1,
    '',
    ...(chapters.length > 0 ? ['Chapters', ...chapters.map((c) => `${mmss(c.atSec)} ${c.title}`), ''] : []),
    'Links',
    '[links after the fold: gear, sources, the previous video]',
  ].join('\n')
  const pinnedComment = input.sequelQuestion
    ? endsWithQuestion(input.sequelQuestion)
    : `${cap(promise).replace(/[.!?\s]+$/, '')}: what should the next video answer? Reply with the one question this one left you with; the top comment picks the sequel.`
  const shortsCuts = pickShortsCuts(promise, input.payoffLadder, chapters)
  const { publishWindow, source: publishWindowSource } = publishWindowFor(input.profile)
  const thumbs = { a: plain(input.thumbs.a), b: plain(input.thumbs.b) }
  const communityPost = [
    `New: ${title}`,
    promise,
    '[video link]',
    pinnedComment,
  ].join('\n')
  const abInstructions = [
    `Upload with Test & Compare on. Variant A = "${thumbs.a}", variant B = "${thumbs.b}"; same title on both.`,
    `Run it at least ${TEST_RULES.minHours.value} h [${TEST_RULES.minHours.evidence}] and ${TEST_RULES.minImpressions.value} impressions per variant [${TEST_RULES.minImpressions.evidence}] (${TEST_RULES.coldStartMinHours.value} h / ${TEST_RULES.coldStartMinImpressions.value} on a cold start).`,
    'The winner is the variant with the higher watch-time share, not the higher CTR; a CTR winner that loses watch time over-promised, and that routes to the hook, not to another thumbnail.',
    'Type the panel numbers with: booster test judge --slug <slug> --a "<impressions>,<ctr>,<share>" --b "<impressions>,<ctr>,<share>" --hours <h>.',
  ].join('\n')
  const endScreenTarget = input.relatedVideo ? plain(input.relatedVideo) : '[most related proven video: pick from booster ledger levers, not the newest upload]'
  return {
    title,
    descriptionLine1,
    description,
    chapters,
    pinnedComment,
    communityPost,
    shortsCuts,
    publishWindow,
    publishWindowSource,
    abInstructions,
    thumbs,
    endScreenTarget,
    baselineReady: input.profile?.baselines !== undefined,
  }
}

export interface PublishCheckInput {
  /** scoreTitle(pack.title).score */
  titleScore: number
  /** qaThumbnail grades of A and B. */
  thumbGrades: [ThumbnailQa['grade'], ThumbnailQa['grade']]
  /** titleThumbnailOverlap below thresholds.titleThumbOverlapMax for both concepts. */
  overlapOk: boolean
  /** Both PNGs passed `booster thumbnail check` (1280x720, under 2 MB). Undefined: not asserted here. */
  thumbFilesOk?: boolean
  /** The creator confirmed the window in Studio > Audience. Defaults to true when the window came from the profile. */
  publishWindowConfirmed?: boolean
  /** The 48-hour review is on the calendar. Default false. */
  reviewScheduled?: boolean
  /** Baseline numbers are ready for the review. Defaults to pack.baselineReady. */
  baselineReady?: boolean
}

export interface PublishCheckItem {
  label: string
  ok: boolean
  /** Why it failed, or what still needs a human. */
  detail?: string
}

export interface PublishCheck {
  pass: boolean
  items: PublishCheckItem[]
}

function isPlaceholder(s: string): boolean {
  return /^\s*\[/.test(s)
}

/**
 * Check a pack against playbook/publish-checklist.md, one item per line in the
 * same order. `pass` is true only when every item is true; details say what to
 * fix. The chapters line cannot see the retention map, so it checks YouTube's
 * chapter rules instead (three or more, 0:00 first, rising, 10 s apart).
 */
export function checkPublish(pack: PublishPack, input: PublishCheckInput): PublishCheck {
  const items: PublishCheckItem[] = []
  const push = (label: string, ok: boolean, detail?: string) => items.push(ok ? { label, ok } : { label, ok, detail })

  // 1. Title
  const len = pack.title.length
  const minChars = thresholds.titleMinChars.value
  const maxChars = thresholds.titleMaxChars.value
  const gate = thresholds.titleGateScore.value
  const promiseReport = checkPromise(pack.descriptionLine1, { title: pack.title, descriptionLine1: pack.description })
  const titleProblems: string[] = []
  if (len < minChars || len > maxChars) titleProblems.push(`${len} chars, needs ${minChars}-${maxChars}`)
  if (!promiseReport.surfaces.title?.pass) titleProblems.push(promiseReport.surfaces.title?.reason ?? 'promise not in the title')
  if (!input.overlapOk) titleProblems.push(`thumbnail text repeats the title (overlap max ${thresholds.titleThumbOverlapMax.value})`)
  if (input.titleScore < gate) titleProblems.push(`title score ${input.titleScore} under the gate ${gate}`)
  push('Title final: 30 to 55 characters, promise inside the first 40, no thumbnail words repeated.', titleProblems.length === 0, titleProblems.join('; '))

  // 2. Thumbnails
  const thumbProblems: string[] = []
  const [gradeA, gradeB] = input.thumbGrades
  if (gradeA !== 'ship') thumbProblems.push(`A graded ${gradeA}`)
  if (gradeB !== 'ship') thumbProblems.push(`B graded ${gradeB}`)
  if (!pack.thumbs.a || !pack.thumbs.b) thumbProblems.push('both thumbnails must be named for the test')
  if (pack.thumbs.a && pack.thumbs.a.toLowerCase() === pack.thumbs.b.toLowerCase()) thumbProblems.push('A and B are the same concept')
  if (input.thumbFilesOk === false) thumbProblems.push('a file failed booster thumbnail check (1280x720, under 2 MB)')
  push('Thumbnails A and B exported at 1280x720, under 2MB, graded "ship"; Test & Compare on.', thumbProblems.length === 0, thumbProblems.join('; '))

  // 3. Description
  const firstLine = pack.description.split(/\r?\n/)[0] ?? ''
  const descProblems: string[] = []
  if (!promiseReport.surfaces.descriptionLine1?.pass) descProblems.push(promiseReport.surfaces.descriptionLine1?.reason ?? 'line 1 does not restate the promise')
  if (/https?:\/\/|www\./i.test(firstLine)) descProblems.push('a link sits in line 1; move links after the fold')
  push('Description first line restates the promise in plain words; links after the fold.', descProblems.length === 0, descProblems.join('; '))

  // 4. Chapters
  const chapterProblems: string[] = []
  const minChapters = PUBLISH_RULES.minChapters.value
  const minGap = PUBLISH_RULES.minChapterGapSec.value
  if (pack.chapters.length < minChapters) chapterProblems.push(`${pack.chapters.length} chapters, YouTube needs ${minChapters} [${PUBLISH_RULES.minChapters.evidence}]`)
  if (pack.chapters.length > 0 && pack.chapters[0].atSec !== 0) chapterProblems.push('first chapter must be 00:00')
  for (let i = 1; i < pack.chapters.length; i += 1) {
    if (pack.chapters[i].atSec - pack.chapters[i - 1].atSec < minGap) {
      chapterProblems.push(`chapters closer than ${minGap} s at ${mmss(pack.chapters[i].atSec)}`)
      break
    }
  }
  push('Chapters match the retention map beats.', chapterProblems.length === 0, chapterProblems.join('; '))

  // 5. End screen
  push('End screen points at the most related proven video, not the newest.', !isPlaceholder(pack.endScreenTarget) && pack.endScreenTarget.length > 0, 'no related video chosen: pass --related <title or url>')

  // 6. Pinned comment
  push('Pinned comment asks the question the sequel will answer.', pack.pinnedComment.includes('?'), 'the pinned comment is not a question')

  // 7. Community post and Shorts
  const shortsProblems: string[] = []
  if (!pack.communityPost.trim()) shortsProblems.push('community post is empty')
  if (pack.shortsCuts.length < PUBLISH_RULES.shortsCount.value) shortsProblems.push(`${pack.shortsCuts.length} Shorts cut, need ${PUBLISH_RULES.shortsCount.value}: add payoff moments to the story`)
  if (new Set(pack.shortsCuts.map((s) => s.atSec)).size !== pack.shortsCuts.length) shortsProblems.push('two Shorts start at the same mark')
  push('Community post scheduled inside 24 hours; two Shorts cut from the best moments scheduled inside 48 hours, each pointing at the video.', shortsProblems.length === 0, shortsProblems.join('; '))

  // 8. Publish time
  const windowOk = input.publishWindowConfirmed ?? pack.publishWindowSource === 'profile'
  push('Publish time matches when your returning viewers are online (Studio > Audience).', windowOk, 'set publishDay in channel.json or confirm the window against Studio > Audience')

  // 9. Review
  const baselineReady = input.baselineReady ?? pack.baselineReady
  const reviewScheduled = input.reviewScheduled ?? false
  const reviewProblems: string[] = []
  if (!reviewScheduled) reviewProblems.push('put the 48-hour review on the calendar, then record it: booster publish check <slug> --review-scheduled')
  if (!baselineReady) reviewProblems.push('no baselines in the profile: run booster profile refresh, or note that the cold-start priors apply')
  push('The 48-hour review is on the calendar with the baseline numbers ready.', reviewProblems.length === 0, reviewProblems.join('; '))

  return { pass: items.every((i) => i.ok), items }
}

/** The pack as packages/<slug>/publish.md: one copy-paste block per Studio field. */
export function renderPublishMarkdown(pack: PublishPack): string {
  const lines: string[] = [
    `# Publish: ${pack.title}`,
    '',
    '## Title',
    '',
    pack.title,
    '',
    '## Description',
    '',
    '```',
    pack.description,
    '```',
    '',
    '## Pinned comment',
    '',
    pack.pinnedComment,
    '',
    '## Community post (inside 24 hours)',
    '',
    '```',
    pack.communityPost,
    '```',
    '',
    '## Shorts (inside 48 hours, each pointing at the video)',
    '',
    ...pack.shortsCuts.map((s, i) => `${i + 1}. Cut at ${mmss(s.atSec)} for ${s.durationSec} s. Hook: ${s.hook}`),
    '',
    '## Publish window',
    '',
    `${pack.publishWindow}${pack.publishWindowSource === 'default' ? ' (default; set publishDay in channel.json)' : ''}`,
    '',
    '## Test & Compare',
    '',
    pack.abInstructions,
    '',
    '## End screen',
    '',
    pack.endScreenTarget,
    '',
  ]
  return lines.join('\n')
}

/** The checklist result as the CLI prints it. */
export function renderPublishCheck(check: PublishCheck): string {
  return [
    `Publish checklist: ${check.pass ? 'PASS' : 'NOT YET'}`,
    ...check.items.map((i) => `- [${i.ok ? 'x' : ' '}] ${i.label}${i.detail ? `\n      ${i.detail}` : ''}`),
  ].join('\n')
}
