/**
 * Structured-output schemas for the Claude engines behind `booster ai`.
 *
 * One Zod object per engine; `ENGINES` maps the engine name a user types to
 * the schema the model must satisfy. `index.ts` passes the schema to
 * `zodOutputFormat()`; the deterministic engines then score what comes back.
 * Nothing here touches the network, so the fixtures in `schemas.test.ts`
 * run offline.
 */
import { z } from 'zod'

/** `ai idea-engine`: a channel read plus 8-12 scored ideas, each borrowing a proven format. */
export const IdeaBatch = z.object({
  channel_read: z.string().describe('two sentences on who this channel serves and what they click'),
  ideas: z.array(z.object({
    idea: z.string(),
    working_title: z.string(),
    thumbnail_concept: z.string().describe('one focal subject, at most three elements, three words of text or fewer'),
    demand_evidence: z.string().describe('which outlier or audience signal proves demand'),
    angle: z.string().describe('what makes it different from the outlier it borrows from'),
    scores: z.object({ demand: z.number(), packaging: z.number(), fit: z.number(), angle: z.number(), payoff: z.number(), feasibility: z.number() }),
  })).min(8).max(12),
})
export type IdeaBatch = z.infer<typeof IdeaBatch>

/** `ai title-lab`: 12-20 titles, each pulling a named lever, plus the top three and a thumbnail pairing note. */
export const TitleBatch = z.object({
  titles: z.array(z.object({ title: z.string(), lever: z.string(), why: z.string() })).min(12).max(20),
  top_three: z.array(z.string()).length(3),
  thumbnail_pairing_note: z.string().describe('what the thumbnail must show so it does not repeat the title'),
})
export type TitleBatch = z.infer<typeof TitleBatch>

/** `ai thumbnail-factory` and `ai package-fix`: 4-6 concepts with a designer brief each, and the A/B pick. */
export const ThumbnailBatch = z.object({
  concepts: z.array(z.object({
    name: z.string(),
    lever: z.string().describe('the one lever this concept pulls: result, stakes, curiosity, contrast or identity; the A/B pair must pull two different ones'),
    focalSubject: z.string(),
    emotion: z.string(),
    elements: z.array(z.string()).max(4),
    text: z.string(),
    background: z.string(),
    colors: z.array(z.string()).max(3),
    composition: z.string(),
    designer_brief: z.string().describe('what to shoot or build, camera and lighting notes'),
  })).min(4).max(6),
  ab_pick: z.object({ a: z.string(), b: z.string(), reason: z.string() }),
})
export type ThumbnailBatch = z.infer<typeof ThumbnailBatch>

/** `ai package-review`: verdict on a title + thumbnail pair, the promise it makes, issues and up to three rewrites. */
export const PackageReview = z.object({
  verdict: z.enum(['pass', 'revise', 'fail']),
  what_the_title_tells: z.string(),
  what_the_thumbnail_shows: z.string(),
  promise_the_video_must_keep: z.string(),
  issues: z.array(z.string()),
  rewrites: z.array(z.object({ title: z.string(), thumbnail_text: z.string(), why: z.string() })).max(3),
})
export type PackageReview = z.infer<typeof PackageReview>

/** `ai retention-map`: the first 30 seconds word for word, the payoff ladder, rehooks, cuts and chapters. */
export const RetentionMap = z.object({
  first_30_seconds_script: z.string().describe('word for word, states the promise inside 10 seconds'),
  payoff_ladder: z.array(z.object({ at: z.string(), moment: z.string() })),
  rehooks: z.array(z.object({ at: z.string(), device: z.string(), line: z.string() })),
  cuts: z.array(z.string()).describe('sections to remove or shorten'),
  chapter_titles: z.array(z.string()),
})
export type RetentionMap = z.infer<typeof RetentionMap>

/** `ai postmortem`: the narrative around a deterministic diagnosis, the next 48 hours, one rule, an optional sequel. */
export const PostMortemNarrative = z.object({
  bottleneck: z.enum(['idea', 'packaging', 'hook', 'retention', 'none', 'insufficient-data']),
  story: z.string().describe('three sentences on what happened, in plain language'),
  next_48_hours: z.array(z.string()).max(4),
  playbook_rule: z.string().describe('one sentence of learning to add to the playbook'),
  sequel_idea: z.string().optional(),
})
export type PostMortemNarrative = z.infer<typeof PostMortemNarrative>

/** `ai channel-audit`: positioning, proven formats, packaging patterns in winners and losers, the next five videos, one rule. */
export const ChannelAudit = z.object({
  positioning: z.string(),
  proven_formats: z.array(z.string()),
  packaging_patterns_in_winners: z.array(z.string()),
  packaging_patterns_in_losers: z.array(z.string()),
  next_five_videos: z.array(z.object({ title: z.string(), thumbnail: z.string(), why: z.string() })).length(5),
  one_rule: z.string(),
})
export type ChannelAudit = z.infer<typeof ChannelAudit>

/**
 * Engine name -> output schema. `package-fix` is the fix-round engine the
 * `package build` loop calls with the gate fixes and the previous round; it
 * returns the same shape as `thumbnail-factory` so the loop can feed it back.
 */
export const ENGINES = {
  'idea-engine': IdeaBatch,
  'title-lab': TitleBatch,
  'thumbnail-factory': ThumbnailBatch,
  'package-fix': ThumbnailBatch,
  'package-review': PackageReview,
  'retention-map': RetentionMap,
  'postmortem': PostMortemNarrative,
  'channel-audit': ChannelAudit,
} as const

/** A key of `ENGINES`. */
export type EngineName = keyof typeof ENGINES

/** The parsed output type of one engine. */
export type EngineOutput<E extends EngineName> = z.infer<(typeof ENGINES)[E]>

/** Engine names in help order. */
export const ENGINE_NAMES = Object.keys(ENGINES) as EngineName[]

/** True when `name` is a known engine (narrows the type). */
export function isEngineName(name: string | undefined): name is EngineName {
  return name !== undefined && Object.prototype.hasOwnProperty.call(ENGINES, name)
}
