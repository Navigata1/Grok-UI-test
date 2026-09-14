/**
 * Shared domain types for the YouTube Channel Booster.
 *
 * The system is packaging-first: an idea is only "real" once it has a title,
 * a thumbnail concept, and a demand signal behind it. Every engine in this
 * module reads or writes one of these shapes.
 */

/** One row of a video export (your own uploads or a competitor's). */
export interface VideoRow {
  title: string
  views: number
  /** ISO date or anything Date.parse() understands. */
  published?: string
  channel?: string
  durationSec?: number
  url?: string
  /** YouTube video id, when the export carries one (Studio "Content" column). */
  videoId?: string
  thumbnailUrl?: string
  /** Studio metrics, when the export is your own channel's. */
  metrics?: VideoMetrics
}

/** Per-video metrics as YouTube Studio exports them. All optional; absent means "not in this export". */
export interface VideoMetrics {
  impressions?: number
  /** Impressions click-through rate, percent. */
  ctr?: number
  avdSec?: number
  /** Average percentage viewed, percent. */
  avpPct?: number
  watchTimeHours?: number
  subscribers?: number
  likes?: number
  comments?: number
  shares?: number
}

/** A video row enriched with outlier statistics. */
export interface OutlierRow extends VideoRow {
  /** Views divided by the channel median for the comparison window. */
  multiplier: number
  /** Median used as the baseline for this row's channel. */
  baseline: number
  /** Views per day since publish, when a publish date is available. */
  velocity?: number
  /** "outlier" at >= the configured threshold, "strong" at >= half of it, else "normal". */
  tier: 'outlier' | 'strong' | 'normal'
  /** Format cues extracted from the title (list, challenge, versus, transformation...). */
  formats: string[]
}

export interface OutlierOptions {
  /** Multiplier above which a video counts as an outlier. 1of10-style default is 10x. */
  threshold?: number
  /** Ignore videos younger than this many days (they have not had time to earn views). */
  minAgeDays?: number
  /** Reference "now" for velocity and age math. Defaults to the current time. */
  now?: Date
}

/** The six-axis idea scorecard. Each axis is 0-5. */
export interface IdeaScore {
  /** Proven demand: outliers, search volume, audience requests. */
  demand: number
  /** Packaging potential: can you see the thumbnail and title already? */
  packaging: number
  /** Audience fit: the same viewer who watched your last videos wants this. */
  fit: number
  /** Differentiation: a new angle, not a clone. */
  angle: number
  /** Payoff: the video can deliver on the promise in the first minute and keep delivering. */
  payoff: number
  /** Feasibility: you can make it at the quality bar within the budget and timeline. */
  feasibility: number
}

export interface IdeaVerdict {
  score: IdeaScore
  /** Weighted 0-100 total. */
  total: number
  verdict: 'green' | 'yellow' | 'red'
  /** The weakest axes with a concrete instruction for each. */
  fixes: string[]
}

export interface IdeaInput {
  idea: string
  score: IdeaScore
}

/** A single title candidate with its formula and heuristic score. */
export interface TitleCandidate {
  title: string
  formula: string
  score: number
  notes: string[]
}

export interface TitleLabInput {
  /** The core topic or promise, e.g. "I built a solar generator from scrap". */
  topic: string
  /** Optional concrete number, result, or stake to plug into formulas. */
  number?: string
  /** Optional named entity or subject (a product, a person, a place). */
  subject?: string
  /** Who the video is for; used for "for X" formulas. */
  audience?: string
}

/** A thumbnail concept as a structured spec that can be scored before it is designed. */
export interface ThumbnailSpec {
  /** The one thing the eye lands on first. */
  focalSubject: string
  /** Emotion or expression on the subject if it is a person, e.g. "shocked", "none". */
  emotion?: string
  /** Every distinct visual element, including the subject and any text. */
  elements: string[]
  /** Text on the thumbnail, or empty. */
  text?: string
  /** Background treatment: e.g. "clean gradient", "blurred workshop". */
  background?: string
  /** Dominant colour pair, for contrast checks, e.g. ["yellow", "black"]. */
  colors?: string[]
  /** The title this thumbnail ships with; used for the complement check. */
  title?: string
}

export interface ThumbnailQa {
  score: number
  grade: 'ship' | 'revise' | 'rethink'
  passes: string[]
  failures: string[]
  fixes: string[]
}

export interface ThumbnailBrief {
  idea: string
  title: string
  concepts: ThumbnailConcept[]
  rules: string[]
  qaChecklist: string[]
  testPlan: string[]
}

export interface ThumbnailConcept {
  name: string
  angle: 'result' | 'stakes' | 'curiosity' | 'contrast' | 'identity'
  focalSubject: string
  supportingElement: string
  text: string
  composition: string
  whyItWorks: string
}

/** Metrics you can read from YouTube Studio 24 to 72 hours after publish. */
export interface PostMortemInput {
  impressions?: number
  /** Click-through rate as a percentage, e.g. 4.5. */
  ctr?: number
  views?: number
  /** Average view duration in seconds. */
  avdSec?: number
  /** Video length in seconds. */
  durationSec?: number
  /** Average percentage viewed, e.g. 42. */
  avpPct?: number
  /** Retention at 30 seconds as a percentage of viewers still watching. */
  retention30sPct?: number
  /** Your channel's typical values, for relative diagnosis. */
  baseline?: { ctr?: number; avpPct?: number; views?: number }
  /** Hours since publish, for velocity context. */
  hoursSincePublish?: number
}

export interface Diagnosis {
  /** The single most likely bottleneck. "packaging-soft" is the borderline CTR band: re-test the title, do not swap the thumbnail. */
  bottleneck: 'idea' | 'packaging' | 'packaging-soft' | 'hook' | 'retention' | 'none' | 'insufficient-data'
  headline: string
  evidence: string[]
  actions: string[]
  /** Is this video worth a packaging swap (new title/thumbnail) right now? */
  repackage: boolean
  /** Where the comparison baseline came from. "default" means the cold-start priors were used; say so. */
  baselineSource: 'provided' | 'default'
  /** Threshold evidence tags used in this verdict, for printing. */
  thresholdsUsed: string[]
}

/** A production workflow generated for one video. */
export interface Workflow {
  idea: string
  slug: string
  format: WorkflowFormat
  stages: WorkflowStage[]
  /** Calendar-day offsets from kickoff for each stage's due date. */
  timelineDays: number
}

export type WorkflowFormat = 'talking-head' | 'documentary' | 'tutorial' | 'challenge' | 'vlog' | 'listicle' | 'interview'

/**
 * A machine-checkable gate. Every `path` is relative to the package directory
 * `packages/<slug>/`; `jsonPath` is a dotted path with optional `[n]` indices
 * into the JSON artifact at `path` (for example `gateReport.pass`).
 */
export type GatePredicate =
  | { kind: 'file-exists'; path: string }
  | { kind: 'json-path-min'; path: string; jsonPath: string; min: number }
  | { kind: 'json-path-eq'; path: string; jsonPath: string; value: string | number | boolean }
  | { kind: 'all-of'; checks: GatePredicate[] }

/** How a stage is executed: a `booster` command the runner spawns, or a human step that leaves an evidence file. */
export interface WorkflowRun {
  kind: 'command' | 'human'
  /** argv for `command` stages; `<slug>` and `<dir>` (packages/<slug>) are substituted at run time. */
  command?: string[]
  /** The file the stage produces, relative to packages/<slug>/. */
  artifact: string
  /** For `human` stages: the evidence file (relative to packages/<slug>/) that must exist before the gate is checked. */
  evidence?: string
}

export interface WorkflowStage {
  id: string
  name: string
  owner: 'strategist' | 'creator' | 'writer' | 'editor' | 'designer' | 'analyst'
  dueDay: number
  inputs: string[]
  outputs: string[]
  checklist: string[]
  /** The gate in prose, for the runbook and the Desk. */
  gate: string
  /** How the runner executes the stage. Absent on hand-written workflows: the runner then only evaluates `check`. */
  run?: WorkflowRun
  /** The machine-checkable gate. Absent means the runner cannot pass the stage without `--override --reason`. */
  check?: GatePredicate
}
