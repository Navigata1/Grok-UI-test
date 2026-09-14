/** Commands: titles, thumbnail, package. */
import { generateTitles, scoreTitle, titleThumbnailOverlap } from '../../src/titles.js'
import { buildThumbnailBrief, qaThumbnail } from '../../src/thumbnails.js'
import type { ThumbnailSpec } from '../../src/types.js'
import { list, out, str, type CommandModule } from '../shared.js'

export const packageModule: CommandModule = {
  verbs: ['titles', 'thumbnail', 'package'],
  help: [
    'titles "<topic>" [--number ..] [--subject ..] [--audience ..]      generate and rank titles',
    'titles score "<title>"                                             score one title',
    'thumbnail brief "<idea>" --title ".." [--subject ..] [--stake ..] [--result ..]',
    'thumbnail qa --subject ".." --elements "a,b,c" [--emotion ..] [--text ..] [--background ..] [--colors "yellow,black"] [--title ..]',
    'package review --title ".." --thumb-text ".." [--elements ..]     title + thumbnail coherence',
  ],
  async run(cmd, sub, rest, flags) {
    if (cmd === 'titles') {
      if (sub === 'score') {
        const title = rest[0]
        if (!title) throw new Error('usage: booster titles score "<title>"')
        const s = scoreTitle(title)
        out({ title, ...s }, flags, () => [`"${title}"`, `Score ${s.score}/100`, ...s.notes.map((n) => `  - ${n}`)].join('\n'))
        return 0
      }
      const topic = sub
      if (!topic) throw new Error('usage: booster titles "<topic>" [--number ..] [--subject ..] [--audience ..]')
      const candidates = generateTitles({ topic, number: str(flags, 'number'), subject: str(flags, 'subject'), audience: str(flags, 'audience') })
      out(candidates, flags, () => ['Score  Formula               Title', ...candidates.map((c) => `${String(c.score).padStart(5)}  ${c.formula.padEnd(21)} ${c.title}`), '', 'Pick two: the highest score and the one most different from it. Then write three of your own that beat both.'].join('\n'))
      return 0
    }
    if (cmd === 'thumbnail') {
      if (sub === 'brief') {
        const idea = rest[0]
        const title = str(flags, 'title')
        if (!idea || !title) throw new Error('usage: booster thumbnail brief "<idea>" --title "<title>" [--subject ..] [--stake ..] [--result ..]')
        const brief = buildThumbnailBrief(idea, title, { subject: str(flags, 'subject'), stake: str(flags, 'stake'), result: str(flags, 'result') })
        out(brief, flags, () => [
          `Thumbnail brief · ${idea}`, `Title: ${title}`, '',
          ...brief.concepts.flatMap((c, i) => [`${i + 1}. ${c.name} (${c.angle})`, `   focal: ${c.focalSubject}`, `   support: ${c.supportingElement}`, `   text: ${c.text || '(none)'}`, `   composition: ${c.composition}`, `   why: ${c.whyItWorks}`, '']),
          'Rules:', ...brief.rules.map((r) => `  - ${r}`), '', 'QA before export:', ...brief.qaChecklist.map((r) => `  - ${r}`), '', 'Test plan:', ...brief.testPlan.map((r) => `  - ${r}`),
        ].join('\n'))
        return 0
      }
      if (sub === 'qa') {
        const spec: ThumbnailSpec = {
          focalSubject: str(flags, 'subject') ?? '',
          emotion: str(flags, 'emotion'),
          elements: list(flags, 'elements') ?? [],
          text: str(flags, 'text'),
          background: str(flags, 'background'),
          colors: list(flags, 'colors'),
          title: str(flags, 'title'),
        }
        const qa = qaThumbnail(spec)
        out({ spec, ...qa }, flags, () => [`Thumbnail QA · ${qa.score}/100 · ${qa.grade.toUpperCase()}`, ...qa.passes.map((p) => `  ✓ ${p}`), ...qa.failures.map((f) => `  ✕ ${f}`), ...(qa.fixes.length ? ['', 'Fixes:', ...qa.fixes.map((f) => `  - ${f}`)] : [])].join('\n'))
        return 0
      }
      throw new Error('usage: booster thumbnail brief ... | booster thumbnail qa ...')
    }
    // package review
    const title = str(flags, 'title')
    const thumbText = str(flags, 'thumb-text') ?? ''
    if (!title) throw new Error('usage: booster package review --title ".." --thumb-text ".." [--elements "a,b,c"]')
    const t = scoreTitle(title)
    const overlap = titleThumbnailOverlap(title, thumbText)
    const elements = list(flags, 'elements') ?? []
    const issues: string[] = []
    if (t.score < 60) issues.push('title scores under 60: rewrite before testing the thumbnail')
    if (overlap >= 0.67) issues.push('thumbnail text repeats the title: the pair says one thing twice instead of two things once')
    if (thumbText.split(/\s+/).filter(Boolean).length > 3) issues.push('thumbnail text is longer than three words')
    if (elements.length > 3) issues.push(`thumbnail has ${elements.length} elements; cut to three`)
    const verdict = issues.length === 0 ? 'pass' : issues.length === 1 ? 'revise' : 'fail'
    out({ title, thumbText, titleScore: t.score, overlap, verdict, issues, titleNotes: t.notes }, flags, () => [`Packaging review · ${verdict.toUpperCase()}`, `Title ${t.score}/100 · overlap ${Math.round(overlap * 100)}%`, ...t.notes.map((n) => `  · ${n}`), ...(issues.length ? ['', 'Issues:', ...issues.map((i) => `  - ${i}`)] : ['', 'Title tells, thumbnail shows. Ship it to Test & Compare.'])].join('\n'))
    return 0
  },
}
