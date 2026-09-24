/**
 * Claude-powered engines. Each engine wraps one deterministic engine with a
 * model that can reason about a specific channel and returns structured
 * output validated against the engine's Zod schema (`./schemas.ts`).
 *
 * The prompt is assembled by `./prompt.ts` (pure, tested); this file is the
 * only place that talks to the network, and it loads the Anthropic SDK only
 * when an engine actually runs, so every offline command (`--dry-run`
 * included) works without it. The shipped doctrine (`./doctrine.ts`) plus the
 * channel playbook folder is the cached system block, and the channel's
 * `channel.json` supplies the channel line when `--channel` is absent; both
 * folders resolve from the same flags and workspace as every other command
 * (`src/workspace.ts`). `--dry-run` prints exactly what would be sent and
 * stops. All output goes through `src/io.ts`.
 */
import { existsSync, writeFileSync } from 'node:fs'
import type Anthropic from '@anthropic-ai/sdk'
import type { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { cliName } from '../build-info.js'
import { scoreIdea } from '../ideas.js'
import { writeOut } from '../io.js'
import type { GenerateHooks } from '../package.js'
import { describeProfile, diagnoseBaseline, loadProfile } from '../profile.js'
import { scoreTitle } from '../titles.js'
import { qaThumbnail } from '../thumbnails.js'
import { findWorkspace, NoWorkspaceError, resolvePlaybookDir, resolveProfileFile, type ResolveOptions } from '../workspace.js'
import { shippedDoctrine } from './doctrine.js'
import {
  assemblePrompt, DEFAULT_EFFORT, describeDoctrine, describeOverlay, formatDryRun, loadPlaybook, parseEffort,
  type AssembledPrompt, type DoctrineSummary, type Effort, type Flags, type PromptContext,
} from './prompt.js'
import {
  ENGINES, ENGINE_NAMES, isEngineName,
  type ChannelAudit, type EngineName, type EngineOutput, type IdeaBatch, type PackageReview, type PostMortemNarrative, type RetentionMap, type ThumbnailBatch, type TitleBatch,
} from './schemas.js'

export { assemblePrompt, formatDryRun, loadPlaybook, parseEffort, ROOT } from './prompt.js'
export { ENGINES, ENGINE_NAMES, isEngineName } from './schemas.js'
export type { EngineName, EngineOutput } from './schemas.js'
export type { AssembledPrompt, DoctrineSummary, Flags, PromptContext } from './prompt.js'

export const DEFAULT_MODEL = 'claude-opus-5'

/** Output budget per call; the largest engine (a 12-idea batch with scores) fits in a quarter of it. */
export const MAX_TOKENS = 16_000

function flag(flags: Flags, key: string): string | undefined {
  const v = flags[key]
  return typeof v === 'string' ? v : undefined
}

function bool(flags: Flags, key: string): boolean {
  return flags[key] === true || flags[key] === 'true'
}

/** The model for a run: `--model`, then `BOOSTER_MODEL`, then the default. */
export function modelFrom(flags: Flags): string {
  return flag(flags, 'model') ?? process.env.BOOSTER_MODEL ?? DEFAULT_MODEL
}

/**
 * The channel line and the diagnosis baseline from the channel's
 * channel.json (`--path`, `BOOSTER_PROFILE`, the workspace, or the legacy
 * default), when the file exists and parses. `--channel` still wins inside
 * `assemblePrompt()`; a missing or broken profile is ignored here because the
 * CLI already warned about it at startup.
 */
export function profileContext(flags: Flags, options: ResolveOptions = {}): Pick<PromptContext, 'profileText' | 'baseline'> {
  try {
    const file = resolveProfileFile(flags, options).path
    if (!existsSync(file)) return {}
    const profile = loadProfile(file)
    return { profileText: describeProfile(profile), baseline: diagnoseBaseline(profile) }
  } catch {
    return {}
  }
}

/**
 * The channel playbook folder the prompt lays over the shipped doctrine:
 * `--playbook`, the workspace's playbook/, or channel-booster/playbook from
 * source, the folder `rules compile` and `retro --accept-rule` write. The
 * packaged bin outside any workspace has none, and the engines run on the
 * shipped doctrine alone; a `--workspace` or `BOOSTER_HOME` that is not a
 * workspace is still an error.
 */
export function overlayDir(flags: Flags, options: ResolveOptions = {}): string | undefined {
  findWorkspace(flags, options)
  try {
    return resolvePlaybookDir(flags, options).path
  } catch (error) {
    if (error instanceof NoWorkspaceError) return undefined
    throw error
  }
}

/** Assemble the prompt for an engine with the shipped doctrine, the channel playbook folder and the profile its flags resolve to. */
export function preparePrompt(engine: string, flags: Flags, context: PromptContext = {}): AssembledPrompt {
  const doctrine = shippedDoctrine()
  const playbook = loadPlaybook(overlayDir(flags), { doctrine, noDoctrine: bool(flags, 'no-doctrine') })
  return assemblePrompt(engine, flags, {
    playbookText: playbook.text,
    playbookFiles: playbook.files,
    doctrine: playbook.doctrine,
    overlay: playbook.overlay,
    overlayDir: playbook.overlayDir,
    packageFixTemplate: doctrine.packageFixTemplate,
    ...profileContext(flags),
    ...context,
  })
}

/** The two SDK entry points a run needs. */
export interface Sdk {
  Anthropic: typeof Anthropic
  zodOutputFormat: typeof zodOutputFormat
}

/** The SDK modules as `import()` returns them. */
export type SdkModules = [typeof import('@anthropic-ai/sdk'), typeof import('@anthropic-ai/sdk/helpers/zod')]

function importSdk(): Promise<SdkModules> {
  return Promise.all([import('@anthropic-ai/sdk'), import('@anthropic-ai/sdk/helpers/zod')])
}

function isMissingModule(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  return code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND'
}

/**
 * Load the Anthropic SDK on first use. Only a real engine run calls this, so
 * the SDK is never loaded by a command that does not talk to the model. A
 * missing SDK is an error that says how to install it.
 */
export async function loadSdk(load: () => Promise<SdkModules> = importSdk): Promise<Sdk> {
  try {
    const [core, helpers] = await load()
    return { Anthropic: core.default, zodOutputFormat: helpers.zodOutputFormat }
  } catch (error) {
    if (!isMissingModule(error)) throw error
    const detail = error instanceof Error ? ` (${error.message})` : ''
    throw new Error(`${cliName()} ai needs the Anthropic SDK, and @anthropic-ai/sdk is not installed${detail}. Install it next to channel-booster with: npm install @anthropic-ai/sdk`)
  }
}

/** The SDK's error when it finds no API key, token or profile: it names its own options, never the variable a person sets. */
function isMissingCredentials(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Could not resolve authentication method')
}

/**
 * One structured call: the assembled system blocks (the doctrine block
 * cached), the engine's schema as the output format, adaptive thinking and
 * the requested effort. A refusal or an empty parse is an error, never a
 * silent fallback.
 */
async function callModel<E extends EngineName>(engine: E, assembled: AssembledPrompt, flags: Flags): Promise<EngineOutput<E>> {
  const sdk = await loadSdk()
  const system = assembled.system
    .filter((b) => b.text.trim().length > 0)
    .map((b) => (b.cache ? { type: 'text' as const, text: b.text, cache_control: { type: 'ephemeral' as const } } : { type: 'text' as const, text: b.text }))
  let response
  try {
    response = await new sdk.Anthropic().messages.parse({
      model: modelFrom(flags),
      max_tokens: MAX_TOKENS,
      thinking: { type: 'adaptive' },
      system,
      messages: [{ role: 'user', content: assembled.user }],
      output_config: { format: sdk.zodOutputFormat(ENGINES[engine]), effort: parseEffort(flags) },
    })
  } catch (error) {
    if (isMissingCredentials(error)) throw new Error(`${cliName()} ai ${engine} needs ANTHROPIC_API_KEY (or an \`ant auth login\` profile) to call the model; --dry-run shows the prompt without one`)
    throw error
  }
  if (response.stop_reason === 'refusal') {
    throw new Error(`the model declined this request${response.stop_details?.explanation ? `: ${response.stop_details.explanation}` : ''}`)
  }
  if (!response.parsed_output) throw new Error('the model returned no parsable output; retry with --effort high')
  return response.parsed_output as EngineOutput<E>
}

/** Run one engine: assemble its prompt from the flags' locations and call the model. */
export async function runEngine<E extends EngineName>(engine: E, flags: Flags, context: PromptContext = {}): Promise<EngineOutput<E>> {
  return callModel(engine, preparePrompt(engine, flags, context), flags)
}

/** What a run was made with: the model, the effort, the shipped doctrine and the channel playbook files. */
export interface Provenance {
  model: string
  effort: Effort
  doctrine: DoctrineSummary
  overlay: string[]
  overlayDir: string | null
}

/** The provenance of one run, from its assembled prompt and flags. */
export function provenanceOf(assembled: AssembledPrompt, flags: Flags): Provenance {
  return {
    model: modelFrom(flags),
    effort: parseEffort(flags),
    // preparePrompt() always records the doctrine; a prompt assembled by hand without one says so.
    doctrine: assembled.doctrine ?? { hash: 'unknown', files: [] },
    overlay: assembled.overlay,
    overlayDir: assembled.overlayDir ?? null,
  }
}

/** The provenance line printed under every real run: model, effort, doctrine hash and the channel playbook files. */
export function provenanceLine(p: Provenance): string {
  return `Provenance: model ${p.model} · effort ${p.effort} · ${describeDoctrine(p.doctrine)} · ${describeOverlay(p.overlay, p.overlayDir ?? undefined)}`
}

/** The `--dry-run --json` object: the doctrine and overlay it carries, then everything a real run would send. */
export function dryRunJson(assembled: AssembledPrompt, flags: Flags): Provenance & { engine: EngineName; playbookFiles: string[]; system: AssembledPrompt['system']; user: string } {
  return { engine: assembled.engine, ...provenanceOf(assembled, flags), playbookFiles: assembled.playbookFiles, system: assembled.system, user: assembled.user }
}

/**
 * The hooks `buildPackage()` calls when the model is on: title-lab and
 * thumbnail-factory on round 1, then title-lab with the gate fixes appended
 * and package-fix with the fixes plus the previous concepts on later rounds.
 * The chosen title of the round reaches the concepts hook through
 * `FixContext.title`, so the concepts are designed against the title the
 * gates score.
 */
export function packageHooks(flags: Flags, input: { idea: string; promise: string }): GenerateHooks {
  const base: Flags = { ...flags, idea: input.idea }
  return {
    titles: async ({ round, fixes }) => {
      const idea = round === 1 || fixes.length === 0
        ? `${input.idea}\nPromise the video keeps: ${input.promise}`
        : `${input.idea}\nPromise the video keeps: ${input.promise}\n\nThe last round failed these gates; fix every one:\n${fixes.map((f) => `- ${f}`).join('\n')}`
      const result = await runEngine('title-lab', { ...base, idea })
      return result.titles.map((t) => ({ title: t.title, lever: t.lever, notes: [t.why] }))
    },
    concepts: async ({ round, fixes, previous, title }) => {
      const withTitle: Flags = { ...base, title: title?.trim() || input.idea }
      const result = round === 1 || !previous
        ? await runEngine('thumbnail-factory', withTitle)
        : await runEngine('package-fix', withTitle, { fixes, previous })
      return result.concepts.map((c) => ({
        name: c.name,
        angle: c.lever,
        focalSubject: c.focalSubject,
        emotion: c.emotion,
        elements: c.elements,
        text: c.text,
        background: c.background,
        colors: c.colors,
        composition: c.composition,
        designerBrief: c.designer_brief,
      }))
    },
  }
}

export const AI_HELP = `${cliName()} ai <engine> [--dry-run] [--out result.json] [--json]

  idea-engine       --niche ".." [--channel ".."] [--csv competitors.csv | --csv example:competitors] [--count 10]
  title-lab         --idea ".."  [--channel ".."]
  thumbnail-factory --idea ".." --title ".." [--channel ".."]
  package-fix       --idea ".." --title ".." (--fixes "a; b" | --fixes-file fixes.txt) [--previous round.json | --previous-json '{..}']
  package-review    --title ".." --thumb ".." [--idea ".."]
  retention-map     --idea ".." --title ".." (--script file.txt | --outline "..")
  postmortem        --title ".." --ctr .. [--impressions ..] [--avp ..] [--retention30 ..] [--hours ..] [--baseline-ctr ..] [--baseline-avp ..] [--baseline-views ..]
  channel-audit     --csv my-channel.csv [--channel ".."]

Options: --model ${DEFAULT_MODEL} · --effort low|medium|high|xhigh|max (default ${DEFAULT_EFFORT}) · --dry-run prints the prompt and stops (--json for one object) · --out writes the JSON result · --no-doctrine runs without the shipped doctrine
The prompt carries the doctrine this build ships, then the channel playbook folder (the workspace's playbook/, or --playbook): its compiled learned rules and the rules a person accepted. Every run prints the doctrine hash.
--channel ".." describes the channel; without it the description comes from the channel's channel.json (the workspace, or --path). Engines: ${ENGINE_NAMES.join(', ')}.
Needs ANTHROPIC_API_KEY or an "ant auth login" profile.
`

function print(value: unknown, flags: Flags, render: () => string): void {
  writeOut(flags.json ? `${JSON.stringify(value, null, 2)}\n` : `${render()}\n`)
}

/** Run the deterministic scorer over the model's output and render both: the JSON the CLI prints with --json and the text without it. */
export function renderResult(engine: EngineName, result: unknown, flags: Flags): { json: unknown; text: string } {
  switch (engine) {
    case 'idea-engine': {
      const r = result as IdeaBatch
      const ranked = r.ideas.map((i) => ({ ...i, verdict: scoreIdea(i.scores) })).sort((a, b) => b.verdict.total - a.verdict.total)
      const json = { channel_read: r.channel_read, ideas: ranked }
      return { json, text: [r.channel_read, '', ...ranked.map((i, n) => `${n + 1}. [${i.verdict.verdict.toUpperCase()} ${i.verdict.total}] ${i.working_title}\n   idea: ${i.idea}\n   thumb: ${i.thumbnail_concept}\n   demand: ${i.demand_evidence}\n   angle: ${i.angle}`), '', 'Bank the greens: booster bank import <file> after --out file.json'].join('\n') }
    }
    case 'title-lab': {
      const r = result as TitleBatch
      const scored = r.titles.map((t) => ({ ...t, heuristic: scoreTitle(t.title).score })).sort((a, b) => b.heuristic - a.heuristic)
      return { json: { ...r, titles: scored }, text: ['Score  Lever            Title', ...scored.map((t) => `${String(t.heuristic).padStart(5)}  ${t.lever.padEnd(16).slice(0, 16)} ${t.title}  — ${t.why}`), '', `Top three: ${r.top_three.join(' | ')}`, `Thumbnail must show: ${r.thumbnail_pairing_note}`].join('\n') }
    }
    case 'thumbnail-factory':
    case 'package-fix': {
      const r = result as ThumbnailBatch
      const title = flag(flags, 'title')
      const graded = r.concepts.map((c) => ({ ...c, qa: qaThumbnail({ focalSubject: c.focalSubject, emotion: c.emotion, elements: c.elements, text: c.text, background: c.background, colors: c.colors, title }) }))
      return { json: { ...r, concepts: graded }, text: [...graded.map((c, i) => `${i + 1}. ${c.name} (${c.lever}) · QA ${c.qa.score}/100 ${c.qa.grade.toUpperCase()}\n   focal: ${c.focalSubject} (${c.emotion})\n   elements: ${c.elements.join(', ')}\n   text: ${c.text || '(none)'} · colours: ${c.colors.join('/')} · bg: ${c.background}\n   composition: ${c.composition}\n   brief: ${c.designer_brief}${c.qa.fixes.length ? `\n   fix: ${c.qa.fixes.join(' ')}` : ''}`), '', `A/B: ${r.ab_pick.a} vs ${r.ab_pick.b} — ${r.ab_pick.reason}`].join('\n') }
    }
    case 'package-review': {
      const r = result as PackageReview
      return { json: r, text: [`Verdict: ${r.verdict.toUpperCase()}`, `Title tells: ${r.what_the_title_tells}`, `Thumbnail shows: ${r.what_the_thumbnail_shows}`, `Promise to keep: ${r.promise_the_video_must_keep}`, '', ...r.issues.map((i) => `  - ${i}`), '', ...r.rewrites.map((w) => `Rewrite: "${w.title}" + thumb text "${w.thumbnail_text}" — ${w.why}`)].join('\n') }
    }
    case 'retention-map': {
      const r = result as RetentionMap
      return { json: r, text: [`First 30 seconds:\n${r.first_30_seconds_script}`, '', 'Payoff ladder:', ...r.payoff_ladder.map((p) => `  ${p.at}  ${p.moment}`), '', 'Rehooks:', ...r.rehooks.map((h) => `  ${h.at}  [${h.device}] ${h.line}`), '', 'Cuts:', ...r.cuts.map((c) => `  - ${c}`), '', `Chapters: ${r.chapter_titles.join(' · ')}`].join('\n') }
    }
    case 'postmortem': {
      const r = result as PostMortemNarrative
      return { json: r, text: [`Bottleneck: ${r.bottleneck.toUpperCase()}`, r.story, '', 'Next 48 hours:', ...r.next_48_hours.map((a) => `  - ${a}`), '', `Playbook rule: ${r.playbook_rule}`, ...(r.sequel_idea ? [`Sequel: ${r.sequel_idea}`] : []), '', 'Accept the rule only after the 7-day read: booster retro --accept-rule ".." --into playbook/<file>.md'].join('\n') }
    }
    case 'channel-audit': {
      const r = result as ChannelAudit
      return { json: r, text: [`Positioning: ${r.positioning}`, `Proven formats: ${r.proven_formats.join(', ')}`, '', 'Winners share:', ...r.packaging_patterns_in_winners.map((p) => `  + ${p}`), 'Losers share:', ...r.packaging_patterns_in_losers.map((p) => `  - ${p}`), '', 'Next five:', ...r.next_five_videos.map((v, i) => `  ${i + 1}. ${v.title} · thumb: ${v.thumbnail} · ${v.why}`), '', `Rule: ${r.one_rule}`].join('\n') }
    }
  }
}

export async function runAiCommand(engine: string | undefined, _rest: string[], flags: Flags): Promise<number> {
  if (!engine || engine === 'help' || flags.help === true) {
    writeOut(AI_HELP)
    return 0
  }
  if (!isEngineName(engine)) throw new Error(`unknown ai engine "${engine}".\n${AI_HELP}`)
  const assembled = preparePrompt(engine, flags)
  if (flags['dry-run'] === true) {
    writeOut(flags.json ? `${JSON.stringify(dryRunJson(assembled, flags), null, 2)}\n` : `${formatDryRun(assembled)}\n`)
    return 0
  }
  const result = await callModel(engine, assembled, flags)
  const rendered = renderResult(engine, result, flags)
  const provenance = provenanceOf(assembled, flags)
  const json = { ...(rendered.json as Record<string, unknown>), provenance }
  const outFile = flag(flags, 'out')
  if (outFile) writeFileSync(outFile, `${JSON.stringify(json, null, 2)}\n`)
  print(json, flags, () => [rendered.text, '', provenanceLine(provenance), ...(outFile ? [`Wrote ${outFile}`] : [])].join('\n'))
  return 0
}
