/**
 * One schema for every stored document. The CLI store, the Desk (via the
 * browser bundle), and agents all validate against these shapes, so there
 * is exactly one definition of an idea, a ledger row, or a rule.
 *
 * Ids are deterministic so an import applied twice changes nothing:
 * ideas `idea:<hash of text>`, ledger rows `<slug>`, decisions `<slug>:<bucket>`,
 * experiments `<slug>:<n>`, rules `rule:<hash>`.
 */
import { z } from 'zod'

export const SOURCE = z.string().regex(/^(desk|cli|agent:[a-z0-9_-]+)$/i).describe('who wrote the document')
export const ISO = z.string().min(10).describe('ISO-8601 timestamp')

export const IdeaStatus = z.enum(['banked', 'green', 'packaging', 'production', 'published', 'parked', 'retired'])
export type IdeaStatus = z.infer<typeof IdeaStatus>

export const IdeaScores = z.object({
  demand: z.number().min(0).max(5),
  packaging: z.number().min(0).max(5),
  fit: z.number().min(0).max(5),
  angle: z.number().min(0).max(5),
  payoff: z.number().min(0).max(5),
  feasibility: z.number().min(0).max(5),
})

export const IdeaSource = z.object({
  title: z.string(),
  multiplier: z.number().optional(),
  channel: z.string().optional(),
  date: z.string().optional(),
  url: z.string().optional(),
})

export const IdeaDoc = z.object({
  id: z.string(),
  idea: z.string().min(1),
  topicKey: z.string().optional(),
  sources: z.array(IdeaSource).default([]),
  scores: IdeaScores,
  status: IdeaStatus.default('banked'),
  weakestAxis: z.string().optional(),
  promise: z.string().optional(),
  packageId: z.string().optional(),
  series: z.string().optional(),
  sequelOf: z.string().optional(),
  parkedReason: z.string().optional(),
  createdAt: ISO,
  updatedAt: ISO,
  source: SOURCE.default('cli'),
})
export type IdeaDoc = z.infer<typeof IdeaDoc>

export const Stat = z.object({ median: z.number(), mad: z.number(), n: z.number().int() })
export type Stat = z.infer<typeof Stat>

export const BaselineTier = z.enum(['prior', 'thin', 'solid'])

export const Baselines = z.object({
  computedAt: ISO,
  bucket: z.enum(['48', '168']),
  n: z.number().int(),
  tier: BaselineTier,
  ctr: Stat.optional(),
  avpPct: Stat.optional(),
  retention30sPct: Stat.optional(),
  returningPct: Stat.optional(),
  views: Stat.optional(),
  impressions: Stat.optional(),
  /** The median moved by more than one MAD since the previous computation. */
  shift: z.boolean().default(false),
})
export type Baselines = z.infer<typeof Baselines>

export const Signature = z.object({
  colors: z.array(z.string()).min(1).max(3).describe('the channel colour pair, e.g. ["yellow", "black"]'),
  facePolicy: z.enum(['always', 'never', 'either']).default('either'),
  maxWords: z.number().int().min(0).max(5).default(3),
  framing: z.string().optional(),
  typeface: z.string().optional(),
  notes: z.string().optional(),
})
export type Signature = z.infer<typeof Signature>

export const Series = z.object({
  name: z.string(),
  promise: z.string(),
  cadence: z.string().optional(),
  parentSlug: z.string().optional(),
})

export const ProfileDoc = z.object({
  positioning: z.string().optional().describe('who watches, what they get every time, why they come back'),
  persona: z.string().optional().describe('the returning viewer in one sentence'),
  series: z.array(Series).default([]),
  signature: Signature.optional(),
  competitors: z.array(z.string()).default([]),
  maxPerWeek: z.number().min(0).default(1),
  publishDay: z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']).default('thu'),
  solo: z.boolean().default(true),
  store: z.enum(['db', 'local']).default('local'),
  thresholds: z.record(z.string(), z.number()).default({}),
  baselines: Baselines.optional(),
  previousBaselines: Baselines.optional(),
  neverAgain: z.array(z.string()).default([]).describe('packaging patterns from the bottom quartile'),
  updatedAt: ISO.optional(),
})
export type ProfileDoc = z.infer<typeof ProfileDoc>

export const Bucket = z.enum(['24', '48', '168', '672'])
export type Bucket = z.infer<typeof Bucket>
export { BUCKET_HOURS, BUCKETS } from './buckets.js'

export const LedgerRead = z.object({
  at: ISO,
  impressions: z.number().optional(),
  ctr: z.number().optional(),
  views: z.number().optional(),
  avdSec: z.number().optional(),
  avpPct: z.number().optional(),
  retention30sPct: z.number().optional(),
  returningPct: z.number().optional().describe('share of views from returning viewers'),
  subscriberSharePct: z.number().optional(),
  browseSuggestedPct: z.number().optional().describe('share of impressions from Browse plus Suggested'),
})
export type LedgerRead = z.infer<typeof LedgerRead>

export const Hypothesis = z.object({
  levers: z.array(z.string()).default([]),
  angle: z.string().optional(),
  predictedCtrMultiple: z.number().default(1),
  registeredAt: ISO.optional(),
})

export const LedgerRow = z.object({
  id: z.string(),
  slug: z.string(),
  videoId: z.string().optional(),
  publishedAt: ISO,
  title: z.string(),
  thumbA: z.string().optional(),
  thumbB: z.string().optional(),
  winner: z.enum(['A', 'B', 'none']).optional(),
  reads: z.object({ '24': LedgerRead.optional(), '48': LedgerRead.optional(), '168': LedgerRead.optional(), '672': LedgerRead.optional() }).default({}),
  bottleneck: z.string().optional(),
  decision: z.string().optional(),
  lever: z.string().optional().describe('one sentence of learning; required once the 168-hour read exists'),
  sequelOf: z.string().optional(),
  hypothesis: Hypothesis.optional(),
  repackagedAt: ISO.optional(),
  notes: z.string().optional(),
  updatedAt: ISO,
  source: SOURCE.default('cli'),
})
export type LedgerRow = z.infer<typeof LedgerRow>

export const ExperimentDoc = z.object({
  id: z.string(),
  slug: z.string(),
  kind: z.enum(['thumbnail', 'title', 'both']).default('thumbnail'),
  variants: z.array(z.object({ name: z.string(), impressions: z.number().optional(), ctr: z.number().optional(), watchTimeSharePct: z.number().optional(), avdSec: z.number().optional() })),
  startedAt: ISO,
  outcome: z.enum(['too-early', 'clear-winner', 'over-promise', 'no-difference']).optional(),
  winner: z.string().optional(),
  updatedAt: ISO,
  source: SOURCE.default('cli'),
})
export type ExperimentDoc = z.infer<typeof ExperimentDoc>

export const DecisionDoc = z.object({
  id: z.string(),
  slug: z.string(),
  bucket: Bucket,
  decision: z.enum(['REPACKAGE', 'RE-TEST-TITLE', 'SEQUEL', 'EXPAND', 'PARK', 'HOLD', 'WAIT']),
  numbers: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).default({}),
  flipCondition: z.string().optional(),
  approvedBy: z.string().optional(),
  approvedAt: ISO.optional(),
  appliedAt: ISO.optional(),
  updatedAt: ISO,
  source: SOURCE.default('cli'),
})
export type DecisionDoc = z.infer<typeof DecisionDoc>

export const RuleDoc = z.object({
  id: z.string(),
  rule: z.string(),
  lever: z.string().optional(),
  tests: z.number().int().default(0),
  wins: z.number().int().default(0),
  confidence: z.number().min(0).max(1).default(0),
  status: z.enum(['candidate', 'promoted', 'retired', 'pinned']).default('candidate'),
  slugs: z.array(z.string()).default([]),
  lastConfirmedAt: ISO.optional(),
  acceptedBy: z.string().optional(),
  pinned: z.boolean().default(false),
  updatedAt: ISO,
  source: SOURCE.default('cli'),
})
export type RuleDoc = z.infer<typeof RuleDoc>

export const WorkflowStatusDoc = z.object({
  id: z.string(),
  slug: z.string(),
  idea: z.string(),
  format: z.string(),
  stages: z.array(z.object({
    id: z.string(),
    status: z.enum(['pending', 'running', 'passed', 'failed', 'overridden']).default('pending'),
    startedAt: ISO.optional(),
    finishedAt: ISO.optional(),
    gateResult: z.string().optional(),
    overrideReason: z.string().optional(),
    agent: z.string().optional(),
  })),
  updatedAt: ISO,
  source: SOURCE.default('cli'),
})
export type WorkflowStatusDoc = z.infer<typeof WorkflowStatusDoc>

/** Collection name to schema, for the store and the sync bridge. */
export const COLLECTIONS = {
  ideas: IdeaDoc,
  ledger: LedgerRow,
  experiments: ExperimentDoc,
  decisions: DecisionDoc,
  rules: RuleDoc,
  workflows: WorkflowStatusDoc,
} as const
export type CollectionName = keyof typeof COLLECTIONS

/** Small stable hash for deterministic ids (FNV-1a, 32-bit, base36). */
export function stableId(prefix: string, text: string): string {
  let h = 0x811c9dc5
  const s = text.trim().toLowerCase()
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `${prefix}:${h.toString(36)}`
}
