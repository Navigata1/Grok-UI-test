# System architecture: the Channel Booster supersystem

Status: final design, 2026-09-14. Synthesised from three candidate designs and a judge panel; starts from the automation-first pipeline, keeps every component that survived scrutiny from the operating-system and experiment-loop designs, and drops what a solo creator cannot run.

Evidence conventions used throughout: **[S]** = sourced in the research findings JSON (`docs/research/sourced-findings.json`) or a listing/statement quoted in `01-video-analysis.md`; **[U]** = unverified there (search-snippet level, no page fetch, no transcript); **[H]** = house default: a number or rule this system chose, not the strategist's, tunable in `channel.json` and labelled as such wherever it prints.

What already exists and is not re-proposed: seven deterministic engines with 37 passing tests (`src/csv.ts`, `outliers.ts`, `ideas.ts`, `titles.ts`, `thumbnails.ts`, `postmortem.ts`, `workflow.ts`), the CLI (`cli/booster.ts`), seven Claude engines behind `booster ai` (`src/ai/index.ts`), nine skills under `.claude/skills/booster*`, eight copy-paste prompts, ten playbook files, `README.md`, `docs/01-video-analysis.md`, and a shipped single-file Desk (`dashboard/template.html` + `engine.ts` + `build.mjs` -> `index.html`, with a staleness test) that already keeps an idea bank and a packaging ledger in the artifact `db` and asks Claude for titles via `sample`. Everything below extends those files.

---

## 1. Purpose and doctrine

Purpose: run one YouTube channel the way a 40-channel operator runs forty, with a person deciding only where identity, taste, or a camera is required, and agents (Claude Code, Grok Build, scheduled routines) doing the rest against this repo and the published Desk.

The rules the system enforces, each with its evidence status and the gate that enforces it:

| Id | Rule | Evidence | Enforced by |
| --- | --- | --- | --- |
| R1 | Views are decided by packaging (title, thumbnail, first seconds) before content quality gets a vote. | [S] 1of10 doctrine: "titles and thumbnails are arguably more important than your video"; episode description opener; chapter "Content vs Packaging". | Workflow order: no `story` stage until a package passes review (runner gate, section 3). |
| R2 | The biggest mistake is ignoring packaging, i.e. producing before packaging. | [S] 1of10 "top mistakes: ignoring packaging"; chapter title. The "producing before packaging" phrasing is reconstruction. | Same gate as R1; `booster workflow` warns when no review pass is recorded for the slug. |
| R3 | Ideas come from over-performing videos (outliers = views vs channel median), not from a blank page. | [S] 1of10 doctrine; Mike Shake "don't reinvent the wheel, start with good ideas". | Idea scorecard hard gate (demand <= 1 is red); `suggestDemand()` attaches outlier evidence rows; harvest feeds the bank. |
| R4 | Packaging amplifies a good idea; it does not rescue a bad one. | [S] Mike Shake. | Scorecard weights (demand 25%, packaging 25%) and the red gate on either. |
| R5 | Create your own identity: borrow the format, add the angle. | [S] Mike Shake "create your own identity". | Angle axis stays human-scored; a green idea is approved by a person, never auto-promoted; signature registry keeps the channel's own look. |
| R6 | Fewer, better-optimised uploads: improve titles, thumbnails, storytelling and positioning rather than frequency. | [S] Trech Media stated method. | Cadence governor: calendar warns above `profile.maxPerWeek`; WIP caps in the bank. |
| R7 | Returning-viewer loyalty is the growth engine. | [S] TubeLab profile of Jake Bryant (returning-viewer loyalty, thumbnail optimisation). | Returning share is a 7-day input; sequel gate keys on it. |
| R8 | Clean thumbnails, one consistent format the audience recognises. | [S] that he originated a format many creators copied and that the long cut has a chapter on keeping thumbnails clean; [U] what the format looks like (no public spec). | `qaThumbnail` rules (one subject, <= 3 elements, <= 3 words, contrast) plus the signature registry, which stores the user's own spec and says so. |
| R9 | Storytelling from film craft keeps the promise the packaging made. | [S] chapter on film background improving storytelling; content of the chapter is reconstruction. | Promise contract checked in title, first 30 seconds, description line 1; hook score gates the shoot. |
| R10 | Each upload is judged on its own, so a first upload can win. | [S] episode title and the "500 views to 100k on the first video" chapter; [U] the platform mechanism (video-level signals, small test batch, expansion on CTR and watch time). | Cold-start mode: absolute priors, stricter data gates, "baseline is borrowed" printed on every verdict. |
| R11 | Read the funnel in order after publish (impressions, CTR, first 30 s, retention) and fix only the first broken stage. | [H] house doctrine (playbook/post-mortem-template.md), consistent with the analyst rule of thumb the findings mark [U]. | `diagnose()` order; decision engine refuses to prescribe later stages. |
| R12 | Test & Compare decides on watch-time share, not CTR; a CTR winner that loses watch time over-promises. | [U] Test & Compare mechanics (three variants, winner by watch-time share, Winner/Preferred/None). | `judgeTest()` over-promise verdict; experiment rows never count while inconclusive. |
| R13 | Compare CTR against your own history, not a universal number. | [U] YouTube Help (2-10% band, varies by traffic source). | Computed baselines replace typed flags; every verdict prints the baseline it used and its tier. |

Rules R11-R13 and every numeric threshold live in one file (`src/thresholds.ts`) with their evidence tag, and `docs/02-strategist-playbook.md` carries this same table so `loadPlaybook()` injects the evidence status into every AI system prompt.

---

## 2. The system map

Each component: what it is, the doctrine it serves, and the command, skill, prompt or file that implements it. Components are shipped unless a line says "(not shipped)"; the file names in each heading say where it lives, and `booster help` lists the commands.

### 2.1 Channel profile and computed baselines
One JSON document (`channel-booster/channel.json`, zod-validated by `src/profile.ts`) holds who the channel serves (positioning sentence, returning-viewer persona), the visual signature (colour pair, face policy, max words, framing, typeface), the competitor set, `maxPerWeek`, `store` (`db` or `local`), threshold overrides, and the computed baselines: leave-one-out median and MAD of CTR, AVP, 30-second retention, returning share, views at 48 h and 7 d over the trailing 10 published videos aged >= 7 days [H], with a tier (`prior` n < 5, `thin` 5-9, `solid` 10+ [H]) and a shift flag when the median moves more than one MAD. Replaces the free-text `--channel` flag on every AI engine and the typed `--baseline-*` flags on `postmortem`. Commands: `booster profile init|show|refresh`. The Desk's `settings/baseline` document becomes the computed object with an explicit override, never a hand-typed number. Serves R13, R6, R7.

### 2.2 Studio ingest (`src/csv.ts`, `src/store.ts`)
`ALIASES` gains the real YouTube Studio Content-tab headers: `Impressions`, `Impressions click-through rate (%)`, `Average view duration` (hh:mm:ss via `parseDuration`), `Average percentage viewed (%)`, `Watch time (hours)`, `Subscribers`, `Content` (video id), `Video publish time`; `readStudioRows()` drops the `Total` row and reports unrecognised columns. `VideoRow` gains `videoId`, `thumbnailUrl`, and the metric fields. Reads are bucketed at 24, 48, 168 and 672 hours after publish [H] and stored one line per video per bucket in `data/videos.jsonl`; the two numbers Studio does not export (30-second retention, returning vs new) are typed with `booster set <slug> --bucket 48 --ret30 62 --returning 38` or in the Desk. Fixture: `examples/studio-content.csv`. Serves R11, R13.

### 2.3 Demand radar: outlier miner v2 (`src/outliers.ts`)
Fixes the verified gap where `minAgeDays` filters only the baseline pool and `velocity` is computed but unused: videos younger than `minAgeDays` are ranked by `velocityMultiplier` (views per day vs the channel's median velocity) and a `fresh` tier flags age <= 21 days with velocity >= 3x [H]; a `sinceDays` window (default 90, the number the scorecard already promises) bounds the baseline; `formatLift` gets `minCount` 3 and Laplace smoothing so one winner cannot produce a 5.0 lift; the first-person regex becomes sentence-initial; `topicKey()` (top two content tokens) groups outliers across channels into topic demand; `diffScans(prev, next)` lists what is new since last Monday; `saturation` discounts a format most competitor channels already carry in the window [H]. Command: `booster outliers <csv> --since 90 --fresh --diff data/last-scan.json --by topic`. Skill `/booster-idea-engine` step 1 uses `--fresh`. Serves R3.

### 2.4 Idea bank with lifecycle (`src/bank.ts`; `src/ideas.ts`)
Persists ideas as data instead of a printed list: `{id, idea, topicKey, sources[] (outlier title, multiplier, channel, date), scores, verdict, weakestAxis, status: banked|green|packaging|production|published|parked|retired, promise?, packageId?, createdAt, updatedAt}`. `suggestDemand(topic, ranked, {windowDays})` derives the demand axis with evidence rows (0 no match, 3 one >= 5x match, 5 three >= 10x matches in 90 days [H]) and the CLI accepts `demand=auto`; the other five axes stay human or AI-with-confirmation. Triggers: a fresh outlier on a parked idea's topic reopens it; an idea with no new evidence for 180 days decays demand by one [H]; any own video at >= 5x median auto-creates a sequel candidate with demand 5 at the front of the queue (sequel-first). WIP caps: 3 in packaging, 2 in production [H], as warnings. `booster ai idea-engine --json` output imports directly. Commands: `booster bank add|list|approve|park|reject|rescore|import`. The Desk's existing `ideas` collection keeps its shape and gains `status`, `topicKey`, `sources[]`. Serves R3, R4, R5, R6.

### 2.5 Package builder with deterministic QA loop (`src/package.ts`; `cli/booster.ts`)
One command produces a complete package and refuses to emit it until the deterministic gates pass: `scoreTitle >= 60` [H], `qaThumbnail` grade `ship` on at least two concepts with different `angle` enums, `titleThumbnailOverlap < 0.67` [H], and the package review verdict `pass`. The inlined review in `cli/booster.ts` (which today never calls `qaThumbnail`, so colour, emotion and background rules are skipped on the fast path) moves to `reviewPackage()` in `src/package.ts` and calls it. With a key, generation is `ai title-lab` + `ai thumbnail-factory`, and each failed gate's `fixes` are fed back as a "fix these before returning" turn for up to three rounds (`prompts/package-fix.md`); with `--offline`, generation is `generateTitles` + `buildThumbnailBrief` so the loop is tested without the network. Output: `packages/<slug>/package.json` `{promise, titles[], chosenTitle?, thumbnails[] with qa, abPick, designerBrief, hypothesis, rounds, gateReport}` plus `package.md`. Human writes three titles of their own on the sheet (the sheet has three blank lines) and picks the final pair. Command: `booster package build "<idea>"|<idea:id> --promise ".." [--rounds 3] [--offline]`, `booster package review --title ".." --thumb-text ".." [--elements ..]`. Serves R1, R2, R4.

### 2.6 Promise contract (`src/promise.ts`, used by 2.5, 2.9, 2.10)
A single `promise` string is written at package time and checked deterministically wherever the promise must survive: the title's first 40 characters share content tokens with it, the first ~25 words of the script share them (hook score), and the description's first line restates it. Drift blocks the stage. This is the anti-clickbait guard that keeps a CTR gain from becoming a hook failure. Tokeniser is `tokens()` exported from `src/titles.ts` (today inlined in `titleThumbnailOverlap`). Serves R9, R12.

### 2.7 Thumbnail factory floor (`src/thumbnails.ts`; `src/signature.ts`, `src/proofsheet.ts`, `src/imagemeta.ts`)
Fix the verified regex defect (`looksLikePerson` lacks a trailing word boundary, so "here", "meter", "herbs" trigger the face deduction). Signature registry: `channel.json.signature` feeds `qaThumbnail(spec, signature?)`, which deducts 10 and reports `signature drift` when the colour pair or word count misses it [H]; a deliberate drift must be written on the sheet; `describeSignature()` is injected into the thumbnail-factory prompt as "Channel signature:". Proof sheet: `renderProofSheet()` writes a self-contained HTML file (inline CSS, no CDN) showing each concept at 120 px wide beside the top three competitor titles in light and dark, so the "would you click yours" ritual runs on the same stimulus every week; when the delivered PNGs exist they are inlined as data URIs (local file only; the published Desk cannot load external thumbnail URLs under its CSP). Render hook: `booster thumbnail render <slug>` writes one image-generation prompt per QA-passed concept (spec to prompt, with the signature) so any external image tool, including the Desk's future image step, can build it; acceptance is `booster thumbnail check <png>` which reads the PNG IHDR / JPEG SOF header (pure Node, no image library) for 1280x720 and <= 2 MB. Commands: `booster signature show|set`, `booster thumbnail proof|render|check`. Serves R8.

### 2.8 Direction: positioning, series, shot list (`channel.json`, `src/workflow.ts`; `src/direction.ts`)
The part of the ask the other designs under-served. `channel.json` carries the positioning sentence, the returning-viewer persona, and a `series[]` list (name, promise, cadence, parent video); the bank tags ideas to a series; `booster direction` prints the channel's bets (proven formats from the audit, series with their returning-share trend, the "never again" packaging list) and is the input to the quarterly `ai channel-audit`. The `plan` stage generates a shot list from the package and story: every payoff-ladder moment gets a shot, the thumbnail moment is a named setup with the concept's expression and props, and rehooks get their B-roll. Command: `booster direction`, `booster plan shots <slug>`. Serves R6, R7, R9.

### 2.9 Story spine and hook gate (`src/hook.ts`; `src/ai/index.ts` retention-map)
A deterministic checker any writer runs on a script or outline: promise overlap in the first ~25 words, thumbnail-moment position (first third / middle / final third / missing), rehook gaps > 90 s flagged [H], intro cruft ("welcome back", "before we start", "in this video") detected, timestamps estimated from word count at 150 wpm when no markers. Output `packages/<slug>/story.json {hookScore, promiseLineIndex, payoffLadder, rehooks, cuts, chapters}`; the runner gates the shoot on `hookScore >= profile.thresholds.hook` (70 [H]). (not shipped) The AI retention-map engine will receive the deterministic report the way postmortem receives `diagnose()` and its schema will gain `promise_line_index`; today `ai retention-map` sends the script alone, and `hook score --payoffs <retention-map.json>` carries its payoff ladder into story.json. Command: `booster hook score --script file.txt --slug <slug>`. Skill `/booster-retention-map` step 4 runs it first. Serves R9.

### 2.10 Publish package and Test & Compare protocol (`src/publish.ts`)
Assembles what Studio needs from the artifacts so publishing is copy-paste and the checklist is machine-checked: description line 1 = promise, chapters from `story.json`, pinned-comment question the sequel answers, community post, two Shorts cut points from the payoff ladder, publish time from the profile's returning-viewer window, Test & Compare instructions with A and B named. `judgeTest(variants, {minImpressions: 1000 [H], hours: 72 [H], overPromiseDrop: 10% [H]})` returns `too-early | clear-winner | over-promise | no-difference`; an over-promise result routes to the hook, not to another thumbnail round (R12). `booster publish confirm <slug> --video-id <id> --at ISO` writes the ledger row that starts the review clock. Commands: `booster publish pack|check|confirm`, `booster test judge`. Serves R6, R12.

### 2.11 Ledger and channel memory (`src/ledger.ts`, `src/schema.ts`)
The playbook says "log it in the ledger" in five places and nothing writes one outside the Desk. One zod schema module, `src/schema.ts`, defines every stored document (profile, idea, package, workflow status, ledger row, experiment, decision, rule) and is exported through `dashboard/engine.ts` so the CLI store, the Desk, and agents share exactly one shape. The ledger row is the Desk's existing `ledger` document extended: `{id, slug, videoId?, publishedAt, title, thumbA, thumbB, winner?, reads: {24?, 48?, 168?, 672?}, bottleneck, decision, lever, sequelOf?, notes}`. Derived, never typed: baselines (2.1), own outliers (>= 5x), lever tally, `renderLedgerMarkdown()` replacing the empty table in `playbook/packaging-ledger.md`. `--record` on `decide` and `test judge`, and `publish confirm --yes`, write rows; a 7-day row without `lever` is refused. No hash chain and no lane locks: git is the audit log and a solo creator plus a scheduled agent are not a fleet. Commands: `booster ledger add|show|baseline|levers|export`. Serves R7, R11, R13.

### 2.12 Store of record and sync (`src/store.ts`; `booster sync` not shipped)
Two places can hold the same documents, so the rule is explicit. When the Desk is published (`profile.store = "db"`), the artifact db is the record of human decisions (idea approvals, final picks, typed Studio numbers, repackage confirmations) and `data/*.jsonl` is the agents' working copy; when it is not (`profile.store = "local"`), `data/*.jsonl` is canonical and the local Desk uses `localStorage` as it already does. `booster sync pull` and `push` (not shipped) would move documents by id with `updatedAt` last-writer-wins and the db's `version` pinned on every write; in Claude Code the agent uses the Artifact `read_db`/`write_db` actions with `out_dir` and `batch`, and for any other agent or a human the Desk exposes Export bundle / Import bundle buttons producing the same JSON. Every document id is deterministic (`slug`, `slug:48`, `idea:<hash>`) so an import applied twice changes nothing. Serves the whole loop.

### 2.13 Workflow runner v2 (`src/types.ts`, `src/workflow.ts`; `src/runner.ts`)
Today `WorkflowStage.gate` is prose and `booster workflow` writes a static runbook. Each stage gains `run: {kind: 'command'|'human', command?: string[], artifact: string, evidence?: string}`, `gate: {kind: 'json-path-min'|'json-path-eq'|'file-exists'|'all-of', ...}`, `status`, `startedAt`, `finishedAt`, `gateResult`; the prose gate is kept as `gateText` so `workflow.test.ts` stays green. `evaluateGate(stage, cwd)` is pure and tested with fake artifacts; `runStage()` spawns `npm run booster -- ...` via `node:child_process`. `booster workflow run <slug> --next --agent <name>` executes the next runnable stage, evaluates its gate, writes status and a ledger event, and refuses to advance on failure; `--override --reason` is recorded and shown in the retro. Stages `demand`, `packaging`, `story`, `thumbnail`, `publish`, `review48`, `postmortem` are commands; `plan`, `production`, `edit`, final pick and publish click are `human` with a required evidence file. `weeklyCadence({publishDay, perWeek, solo})` anchors the 48-hour review to a real weekday; `governCalendar()` warns (not refuses) above `maxPerWeek` and requires a written reason to proceed [H]. Serves R1, R2, R6.

### 2.14 Funnel diagnosis v2 and cold start (`src/postmortem.ts`; `src/thresholds.ts`)
Verified defects: the `idea` bottleneck is unreachable without `--baseline-views` (300 impressions at 60 h reads "every stage is healthy"); CTR between 0.75x and 0.9x baseline with AVP present falls through to `none` / "Double down". Fixes: `impressionsLow` also when `baseline.views` is absent and impressions < 1,000 at >= 24 h; never `none` under 1,000 impressions; the borderline band becomes `packaging-soft` with no repackage; expected impressions come from the profile's own 24/48/168 h medians. Additions: `mode: 'established' | 'cold-start'` (cold start when the baseline tier is `prior`), with absolute priors (CTR 4% = midpoint of the [U] 2-10% band, 30 s 60% [U], AVP 40% [H]) and a 24-to-48 h impression-growth read [H] instead of "vs your median"; a Wilson interval on CTR given impressions so a verdict is `insufficient-data` when the interval straddles the threshold [H]; `returningViewerPct`, `subscriberViewSharePct`, `trafficSources` on `PostMortemInput` with the read "not yet algorithmic" when browse + suggested < 40% of impressions [H]; every verdict prints the baseline used and whether it is computed, borrowed or default. All constants move to `src/thresholds.ts` with evidence tags and profile overrides. Serves R10, R11, R13.

### 2.15 Decision engine and repackage autopilot (`src/decide.ts`, `src/repackage.ts`)
Turns the boolean `repackage` into a numbered decision with the numbers that made it and what would flip it: REPACKAGE when packaging is the bottleneck with adequate confidence, impressions are still being served (>= 0.8x expected at 48 h or still rising [H]), inside 72 h [H], no swap in the last 7 days [H], and the expected gain (remaining impressions x CTR gap x retention factor) clears 500 views or 5% of baseline views [H]; SEQUEL when the 7-day multiplier >= 3x [H] and returning share >= 0.9x baseline [H]; EXPAND at 1.5-3x with healthy retention; RE-TEST TITLE in the packaging-soft band; PARK below 0.7x with an idea bottleneck. `prepareRepackage()` picks the most angle-distant QA-passed concept and the next-best title from `package.json`, writes `repackage.json`, and opens a human task; it never applies the swap. Thumbnail first, then title, one swap per 7 days. Commands: `booster decide --slug <slug> --bucket 48|168`, `booster repackage prepare <slug>`. Serves R6, R11, R12.

### 2.16 Scheduled review agent and weekly brief (`src/review.ts`, `src/brief.ts`)
`dueReviews(ledger, now)` computes which slugs hit 24, 48, 168 or 672 h; `runReviews()` ingests whatever landed in `inbox/` (Studio export or Desk-typed numbers via sync), diagnoses with profile baselines, runs `decide()`, prepares repackages, and writes `data/reviews/<date>.json` plus a Markdown digest. `buildBrief(store, now)` lists reads due, experiments to close, decisions awaiting approval, rules promoted or decayed, baseline shifts, loyalty drift, idea movers and the three ideas whose scores justify the next sprint. Scheduling: a CCR Routine (`docs/routines.md` gives the prompt) or `.github/workflows/booster-review.yml` (cron every 6 h, runs only when `data/ledger.jsonl` exists). The agent never approves a decision or applies a swap. Commands: `booster review due|run [--now ISO]`, `booster brief [--week|--today]`. Serves R11.

### 2.17 Learning flywheel: retro and learned rules (`src/retro.ts`, `src/rules.ts`)
Two paths into the playbook, both landing in files `loadPlaybook()` already concatenates into the cached system block, so the AI engines change behaviour the next call with no code change. Human path: `booster retro --since 7d` tallies levers, drafts one candidate rule with its ledger slugs, and `booster retro --accept-rule "..." --into playbook/<file>.md` appends it under `## Learned rules` with date and slug refs (the only write to `playbook/*.md`). Compiled path: `booster rules compile` writes `playbook/00-learned-rules.md` (sorted first by the alphabetical loader, kept under 8k chars) from evidence: a lever is promoted at >= 3 tests and smoothed win rate >= 0.6, retired at <= 0.35, and confidence halves every 90 days without a confirming observation [H], so the channel's rules cannot fossilise around one trend; the `SYSTEM_PREAMBLE` says to prefer learned rules over generic doctrine when they conflict and states the evidence counts so the model does not amplify n = 1. AI output gains a provenance line listing the playbook files loaded. Serves R5, R7.

### 2.18 Agent interface and doctrine file (`src/ai/index.ts`, `.claude/skills/booster/SKILL.md`; `docs/02-strategist-playbook.md`, `AGENTS.md`)
`parse()` splits into `assemblePrompt(engine, flags)` (pure, exported, tested offline) and `callModel()`; `--dry-run` prints the assembled system and user prompt; zod schemas move to `src/ai/schemas.ts` with fixture tests; `--effort` is validated; `--out <file>` lands on every AI verb (`--record` is not shipped; `bank import` takes the idea engine's file). The SDK surface already in the file (`messages.parse`, `output_config.format` + `effort`, `thinking: {type: 'adaptive'}`, model `claude-opus-5`, `stop_reason === 'refusal'` with `stop_details`) was checked against the current API reference on 2026-09-14 and is correct for `@anthropic-ai/sdk` 0.125. `docs/02-strategist-playbook.md` carries the R-table from section 1 so the router skill's dangling reference resolves and every AI call inherits the evidence labels. `AGENTS.md` at `channel-booster/` gives any agent (Claude Code, Grok Build, a routine) the stage loop and the human-only gates: approve a green idea, pick the final pair, shoot, click publish, apply a repackage swap, write the lever learned, accept a rule. `cli/booster.ts` gets a boolean-flag allowlist (verified defect: `booster titles --json "cold showers"` fails because `--json` eats the positional) and a `cli.test.ts`. No command manifest, no lane locks, no drift script: the skills plus `AGENTS.md` are the surface.

### 2.19 Optional data adapters (off by default)
The honest primary path is a Studio export dropped in `inbox/` plus four numbers typed in the Desk at 48 h and 7 d. Two optional adapters reduce that friction without new dependencies: `booster fetch channel <handle|id>` reads public video lists and view counts through the YouTube Data API v3 with native `fetch` and `YOUTUBE_API_KEY` from the environment (official API, quota-free at this scale; tests stub the transport), writing the same CSV shape into `inbox/`; and an Analytics API reader for the creator's own channel behind OAuth, sketched only as an interface (`src/adapters/analytics.ts`) because it needs credentials the repo must never hold. Agents must not scrape.

---

## 3. The pipeline for one video

Default cycle 14 days (`--days`), 7 in cold start. Any agent drives it with `booster workflow run <slug> --next`; the order never changes because the gates depend on it.

| # | Stage | Owner | Run | Gate (machine-checked) | Artifact |
| --- | --- | --- | --- | --- | --- |
| 1 | Demand | agent | `outliers --fresh --since 90`, `bank rescore`, `idea score ... demand=auto` | idea verdict `green`, or `yellow` with a named fix and `--override --reason`; human approves the green (R5) | `data/ideas.jsonl` row, status `green` |
| 2 | Package | agent, then human | `package build <id> [--offline]`, QA loop up to 3 rounds; human writes three titles of their own and picks the pair; `package review --title --thumb-text` | `gateReport.pass == true`; in solo mode the review timestamp is >= 12 h after the build [H] | `packages/<slug>/package.json`, `package.md`, `proof-sheet.html` |
| 3 | Story | human writes, agent checks | `hook score --script`, `ai retention-map` | `story.json.hookScore >= 70` and promise line found in the first 25 words | `packages/<slug>/story.json` |
| 4 | Plan | agent | `plan shots <slug>` | every payoff-ladder moment has a shot; the thumbnail moment is a named setup | `packages/<slug>/shots.md` |
| 5 | Production | human | `human` stage | evidence file exists (footage manifest listing the first 30 s, every payoff, the thumbnail photos) | `packages/<slug>/footage.txt` |
| 6 | Edit | human, agent assists | `human`; `ai retention-map` on the cut's transcript if available | evidence file (cut path) plus promise on screen in the first line, confirmed by the editor | `packages/<slug>/cut.txt` |
| 7 | Thumbnail production | designer or image tool, agent checks | `thumbnail render` (prompts), external build, `thumbnail check <png>`, `thumbnail proof` | two files pass the header check and their specs graded `ship` with different angles; signature drift either absent or written down | `packages/<slug>/thumb-A.png`, `thumb-B.png`, `proof-sheet.html` |
| 8 | Publish | agent assembles, human clicks | `publish pack`, `publish check`, then human uploads with Test & Compare on, `publish confirm --video-id --at` | every checklist line true; ledger row with `publishedAt` exists | `packages/<slug>/publish.md`, ledger row |
| 9 | 48-hour decision | agent computes, human confirms | `review run` (ingest, diagnose, decide, repackage prepare) | decision recorded; if REPACKAGE, human applies the swap and confirms | `data/reviews/<date>.json`, `repackage.json`, ledger read `48` |
| 10 | 7-day post-mortem | agent computes, human writes one sentence | `review run`, `test judge`, `ledger add --lever` | ledger read `168` present and `lever` non-empty; sequel candidate created if >= 5x | ledger row complete, bank sequel row |
| 11 | 28-day learn | agent | `rules compile`, hypothesis scored | rule diff written for the retro | `playbook/00-learned-rules.md`, `data/rules.json` |

Human touchpoints total about 30 minutes per video outside writing, shooting and editing: the green approval, the pair pick, the publish click, the 48-hour confirm, the 7-day sentence.

---

## 4. The operating cadence

Anchored to one publish day (default Thursday, `booster week --publish thu [--solo]`).

Weekly:
- Monday, 45 min, strategist. Agent has already run harvest overnight: `outliers --fresh --diff`, `bank rescore`, `brief --week`. Human reads the brief, approves at most three greens (WIP cap), parks the rest with the weakest axis named.
- Tuesday, 60 min. Agent builds packages for the greens; human writes three own titles per package, picks the pair, records the review. Solo mode: the review pick happens Wednesday morning (12-hour gap stands in for the second reviewer).
- Wednesday, 30 min, writer. First 30 seconds word for word; `hook score`; cold-reader test on a person who has not seen the title.
- Wednesday to Friday, creator. Production to the shot list; thumbnail photos at the emotional peak.
- Friday, 30 min, designer or image tool. `thumbnail render`, build, `check`, `proof`; lock A and B.
- Publish day, 20 min. `publish pack`, upload, Test & Compare on, `publish confirm`.
- Every 6 hours, agent. `review run`: nothing happens unless a slug is due.
- Sunday, 30 min, strategist. `retro --since 7d`: which lever won, accept or rewrite one rule, acknowledge any baseline shift or loyalty-drift alert, lock next week's three ideas.

Per publish (event-driven): T+24 h distribution read only (no verdict, no swap); T+48 h decision; T+7 d post-mortem and lever; T+28 d rules and hypothesis calibration.

Monthly: signature review (any deliberate drift logged, was it worth it); cadence governor check (a second weekly upload is allowed only when the trailing four rows are at or above 0.9x baseline CTR and each had a Test & Compare [H]).

Quarterly: `profile refresh`, `direction`, `ai channel-audit`; positioning sentence rewritten; "never again" list refreshed; `baseline reset --since` only after a deliberate strategy change.

Cold start (fewer than 5 published videos or no ledger): same order on a 7-day cycle; the first three packages are deliberate lever tests (three different title levers, three different thumbnail angles) so lever statistics exist from video four [H]; no packaging verdict before 2,000 impressions or 72 h [H]; the 7-day read outranks the 48-hour read; the runbook says which numbers to ignore in the first day.

---

## 5. The experiment loop and metrics

Every published package is a pre-registered hypothesis: at `package build` the strategist records the title lever(s), the thumbnail angle, the heuristic scores, the promise and a predicted CTR multiple vs baseline (default 1.0). The 48-hour and 7-day reads score the prediction; rules compile only from pre-registered packages, which blocks hindsight lessons, and the channel gets a calibration score (mean absolute error of the predicted multiple over the last 10; target under 0.2x [H]).

Every threshold, its default, and its source:

| Metric or gate | Default | Source |
| --- | --- | --- |
| Outlier multiplier (competitors) | >= 10x channel median | [S] 1of10 outlier concept; the number is [H] |
| Own winner / sequel trigger | >= 5x own median | [H] (playbook) |
| Fresh outlier | age <= 21 d and velocity >= 3x channel median velocity | [H] |
| Demand window | 90 days | [H] (playbook) |
| Format lift | minCount 3, Laplace alpha 1 | [H] |
| Idea verdict | green >= 75, yellow >= 55; demand or packaging <= 1 is red | [H] |
| Title score gate | >= 60; length 30-55 chars | [H] |
| Thumbnail QA | ship >= 80, revise >= 60; <= 3 elements, <= 3 words | [H] |
| Title/thumbnail overlap | < 0.67 | [H] |
| Hook score gate | >= 70; rehook gap <= 90 s | [H] |
| Baseline | leave-one-out median + MAD, trailing 10 videos aged >= 7 d; tiers prior < 5, thin 5-9, solid >= 10; shift flag > 1 MAD | [H]; "compare against your own history" is [U] YouTube Help |
| Impressions healthy (idea stage) | >= 2x median views, or >= expected from own 24/48/168 h curve | [H] |
| Insufficient data | < 1,000 impressions at < 24 h; Wilson interval straddling the CTR threshold | [H] |
| CTR healthy / low | >= 0.9x baseline and >= 3%; low < 0.75x or < 2.5%; between = packaging-soft | [H]; the 2-10% band is [U] |
| Hook broken | 30-second retention < 60% | [U] (YouTube guidance on the intro segment) |
| Retention soft | AVP < 0.85x baseline | [H] |
| Cold-start priors | CTR 4%, 30 s 60%, AVP 40%; verdict only after 2,000 impressions or 72 h; 24-to-48 h growth > 30% is healthy | [H], derived from [U] figures |
| Traffic gate | browse + suggested < 40% of impressions = not yet algorithmic | [H]; the traffic-source taxonomy is [U] |
| Repackage | packaging bottleneck, inside 72 h, impressions >= 0.8x expected or rising, no swap in 7 d, expected gain >= max(500 views, 5% of baseline views); thumbnail before title | [H] |
| Test & Compare | inconclusive under 1,000 impressions per variant or 72 h (2,000 / 7 d in cold start); winner by watch-time share; over-promise when the CTR winner's AVD is >= 10% lower | [U] mechanics; numbers [H] |
| Sequel | 7-day multiple >= 3x and returning share >= 0.9x baseline and AVP >= 0.9x | [H]; returning-viewer emphasis is [S] |
| Loyalty drift | returning viewers on video n / video n-1 < 0.8 for two consecutive videos | [H] |
| Packaging travel | new-viewer CTR / returning-viewer CTR < 0.6 means the package only works on fans | [H] |
| Lever rule | promote at >= 3 tests and smoothed win rate >= 0.6; retire <= 0.35; confidence halves after 90 d unconfirmed | [H] |
| WIP caps | 3 in packaging, 2 in production | [H] |
| Cadence governor | warn above `maxPerWeek`; second weekly upload needs trailing 4 rows >= 0.9x baseline CTR with Test & Compare | [H]; "fewer, better uploads" is [S] |
| Solo review gap | 12 h between package build and review pick | [H] |

Sample-size honesty: at one upload per 14 days the channel produces about 26 packages and perhaps 15 conclusive tests a year, so lever rules will be thin in year one. The gates above make the system say "not yet" rather than guess; the brief shows evidence counts next to every rule.

---

## 6. Automation map

Runs unattended (routine or cron, no human):
- Nightly Monday harvest: `outliers --fresh --diff --save`, `bank rescore`, `brief --week`.
- Every 6 hours: `review run` (ingest, diagnose, decide, repackage prepare).
- Sunday night: `rules compile`, `ledger export --md`, retro draft.
- On every runner step: the status document is updated (`sync push` is not shipped; the Desk's db and `data/*.jsonl` are reconciled by hand or by the Desk's export).

An agent runs on request (Claude Code, Grok Build, or a person at the terminal):
- `workflow run <slug> --next` for any command stage; `package build`; `hook score`; `plan shots`; `thumbnail render|check|proof`; `publish pack|check`; `ai *` engines with `--dry-run` when there is no key; `direction`; `profile refresh`.

A human decides (agents stop and ask; `AGENTS.md` lists these and the runner marks them `human`):
- Approve a green idea (identity, R5).
- Write three own titles and pick the final title and A/B pair (voice).
- Write and perform the script; shoot; edit.
- Click publish, start Test & Compare, apply a repackage swap (public, irreversible).
- Type the numbers Studio does not export (30-second retention, returning vs new, Test & Compare panel).
- Write the lever learned; accept or rewrite a playbook rule; raise `maxPerWeek`; reset the baseline.

---

## 7. The nuances the user did not ask for, and why each earns its place

1. **Promise contract propagation.** The only mechanism that enforces "title tells, thumbnail shows, video delivers" rather than describing it; it is what stops a CTR win from becoming a hook loss (R9, R12).
2. **Computed, leave-one-out baselines with tiers and a shift flag.** A video is never judged against a median it is part of; a viral outlier does not silently raise the bar; the system says "prior/thin/solid" instead of pretending (R13).
3. **Cold-start mode as a first-class state.** The episode is about the first upload; today `DEFAULT_BASELINE` is applied silently. Absolute priors plus 24-to-48 h growth plus "baseline is borrowed" on every verdict is how a strategist judges video one (R10).
4. **Pre-registered packaging hypotheses with a calibration score.** Rules compile only from packages whose lever and predicted CTR were written before publish, which blocks hindsight lessons and gives the creator a number for how well they understand their audience.
5. **Confidence-gated verdicts (Wilson interval, per-bucket allowed verdicts, traffic gate).** Stops the most expensive solo-creator mistake: swapping a thumbnail on 800 impressions from a subscriber notification burst.
6. **Test & Compare over-promise decoding.** A CTR winner with lower watch-time share is routed to the hook, not crowned; the losing concept is retained as the repackage candidate (R12).
7. **Sequel-first and idea reopen triggers.** A proven video is the strongest demand signal on the platform; parked ideas wake when a fresh outlier lands on their topic; stale ideas decay, so "bank, do not bin" happens without anyone remembering (R3).
8. **Rising-outlier and saturation scoring.** Velocity ranks fresh momentum above stale totals, and a format most competitors already carry is discounted, which is how a trend is started rather than copied after it saturates (R3, R5).
9. **Signature registry with deliberate-drift logging.** The "clean format" is data the QA checks against; an intentional experiment must be written down so the ledger can evaluate it later; the registry stores the user's own spec and says the strategist's is not public (R8).
10. **Proof sheet as a ritual object.** The "would you click yours next to the top three" question runs on the same stimulus every week, light and dark, phone scale.
11. **Cadence governor as a warning with a written reason.** "Fewer, better uploads" becomes something the tool applies, without blocking a creator who knows why (R6).
12. **Returning-viewer share as a required 7-day input, loyalty carry, and packaging travel.** The loyalty signal the strategist optimises for becomes visible; a signature's effect on strangers vs fans becomes measurable (R7).
13. **Learned rules with a half-life, loaded ahead of generic doctrine.** The AI engines learn the channel's own evidence with no prompt surgery, and cannot fossilise around a 2026 trend (R5).
14. **Evidence tags on every rule and threshold, injected into the system prompt.** The findings mark most platform mechanics unverified; the engines must not assert them as fact, and the creator can see which gate rests on what.
15. **Solo second reviewer is time.** A 12-hour gap between build and pick replaces the second person in the packaging review.
16. **Deliberate lever tests in the first three uploads.** Lever statistics exist by video four instead of month nine.
17. **Header-only image checks and a render hook.** The factory produces prompts and accepts files without an image library, so the no-new-deps rule holds while the thumbnail stops being only a spec.
18. **Shot list from the payoff ladder.** Direction as a deliverable: the thumbnail moment is a named setup on set, not something found in the edit.

---

## 8. Dashboard spec (the published command center)

The shipped Desk is the base: single file, engines bundled from `src/` by `build.mjs`, `db` + `sample` capabilities with `localStorage` fallback, stages Scan, Ideas, Titles, Package, Review, Ledger. The spec below extends it; the build and staleness test stay as they are.

Panels (rail order):
1. **Today.** Output of `buildBrief()` run in the browser: reads due (which slug hit 24/48/168/672 h), decisions awaiting a click, experiments to close, ideas that moved since last week, alerts (baseline shift, loyalty drift, inbox empty for 14 days, cadence above cap). Each item is one button.
2. **Profile.** Positioning sentence, returning-viewer persona, series list, signature (colour pair, face policy, max words, framing), competitor set, `maxPerWeek`, computed baselines with tier and the date computed, threshold overrides with their evidence tag shown read-only.
3. **Scan.** Exists; adds fresh tier, diff since last scan, topic table, saturation, "to bank" with sources attached.
4. **Ideas.** Exists; adds status chips, weakest axis, sources, sequel-first rows pinned, reopen notices, WIP counters, `demand=auto` button.
5. **Package.** Exists (titles, thumb text, attach); adds the QA loop (deterministic in the browser, Claude `sample` for generation), three "your own" title lines that must be filled, the promise field, A/B pick, proof sheet rendered inline from concept cards, review record with reviewer and timestamp, solo 12-hour gate shown as a countdown.
6. **Story.** Paste the script; `scoreHook()` in the browser; promise line highlighted; rehook gaps flagged; chapters generated.
7. **Publish.** Publish pack rendered with copy buttons; checklist as booleans; `publish confirm` form (video id, time) that starts the review clock.
8. **Review.** Exists (diagnose, log); adds bucket selector, the four typed numbers, decision card from `decide()` with the numbers and the flip condition, one-key confirm, repackage card with the prepared swap, Test & Compare form and `judgeTest()` verdict.
9. **Ledger.** Exists; adds reads per bucket, lever tally, own outliers, calibration score, export/import bundle buttons.
10. **Retro.** Sunday form pre-filled: lever won and lost, rule drafted with slugs, accept (writes a `rules` document the agent turns into the playbook append), next week's three ideas.

Data model (shared db collections; shapes from `src/schema.ts`, ids deterministic):
- `settings/profile` (one doc: the `channel.json` content including computed baselines with `computedAt`, `tier`, `override?`). Replaces `settings/baseline`.
- `ideas/<id>`: bank row (section 2.4).
- `packages/<slug>`: package.json content plus `review {reviewer, at, verdict}`, `hypothesis`, `storyScore`.
- `workflows/<slug>`: stage statuses, gate results, lock-free; agents write, page reads.
- `ledger/<slug>`: the ledger row with `reads {24,48,168,672}`, decisions, lever, winner.
- `experiments/<slug>:<n>`: Test & Compare variants and outcome.
- `decisions/<slug>:<bucket>`: decision, numbers, flipCondition, `approvedBy`, `approvedAt`.
- `rules/<id>`: learned rule with evidence counts, status, `pinned`, `acceptedBy`.
- `data/users/me/prefs`: per-viewer conveniences only (current stage, collapsed cards) when the `user` capability is declared; otherwise `localStorage`.
Write rules: viewers with `interact` can write `ideas`, `packages.review`, `ledger.reads`, `experiments`, `decisions.approved*`, `rules.accepted*`; agents write everything else through the Artifact `write_db` actions with `version` pinned (`sync push` is not shipped); every document carries `updatedAt` and `source: 'desk'|'cli'|'agent:<name>'`.

The in-page Claude `sample` call does narrative only, never numbers: title batches, thumbnail concepts, the package-review reasoning, the retro's drafted rule, the brief's three-move headline. Each call's prompt is the corresponding `prompts/*.md` with placeholders filled and the deterministic engine output pasted in (the Desk today inlines its own shorter prompt text at two places in `template.html`; the fix is to embed the prompt files into the bundle so page and CLI reason from identical rules). Every generated title or concept is scored by the bundled engines before it is shown. No API keys, no Studio credentials, no scraping from the page; the published artifact keeps its private default and the bundle export never includes keys.

Before the next publish: load the artifact-capabilities skill and confirm the `db` API the page uses (`collection().onSnapshot`, `doc().set/update`, `add`) and the `sample` call match the current contract, and add `version` handling for concurrent writes from the page and the sync command.

---

## 9. Risks and honest limits

- **The transcript was not captured.** The episode's chapters, listings and the guest's public statements are sourced; what he actually said in each chapter, the look of the thumbnail format he originated, the channels behind the 400k, 100M-monthly and 23M cases, and the mechanics of the 500-to-100k first video are reconstruction or unverified. `01-video-analysis.md` says exactly which claims to correct after watching; the R-table and `thresholds.ts` carry the same labels so the engines never assert them as fact.
- **Most platform mechanics are unverified.** Cold-start seeding, the 2-10% CTR band, the 30-second intro figure, Test & Compare's watch-time rule and title testing availability are search-snippet level. They are priors and profile settings, not gates the system trusts blindly; the repackage agent prepares and never applies.
- **Data acquisition is the weakest link.** Studio does not export 30-second retention, returning vs new, or Test & Compare results; competitor data is an export or the optional Data API adapter. If `inbox/` stays empty the review agent produces nothing; the Today panel shows that as an alert rather than letting the cadence stall silently. The Data API adapter is optional and must never become scraping.
- **Small samples.** About 26 packages and 15 conclusive tests a year at the default cadence; lever rules, calibration and cohort metrics stay thin for months. The gates say "not yet"; the brief shows evidence counts; nothing promotes a rule on n = 1.
- **Heuristic scores are checklists, not predictions.** `scoreTitle` and `qaThumbnail` catch the obvious mistakes; teams will optimise for the number. The retro correlates scores with realised CTR on this channel and every output says the score is a checklist.
- **Clone risk.** Outlier-driven ideation can drift into copy content, which contradicts R5 and touches YouTube's inauthentic-content monetisation policy [U]. The angle axis stays human, the green approval stays human, and the signature registry keeps the channel's own look.
- **Two stores.** The Desk db and `data/*.jsonl` mirror each other; the rule in 2.12 (record of decisions vs working copy, deterministic ids, `updatedAt`, pinned versions) is the mitigation, and `sync` is the only bridge. If the user never publishes the Desk, there is one store.
- **Ritual load.** Eight touchpoints a week is what kills systems by week three. Solo mode halves minutes and merges Monday and Tuesday; the two non-negotiables are the 12-hour review gap and the 48-hour decision; everything else is a warning, not a blocker.
- **Cost.** The package QA loop can spend up to three high-effort Claude rounds per package with a 16k-token cap; the playbook block is cached; `--offline` and `--rounds` bound it; the Desk's `sample` call is one batch per click.
- **Platform drift.** Studio export headers, traffic-source names and Test & Compare change; the alias table has fixtures and names unknown columns; thresholds live in one file; the quarterly audit re-checks them.
- **Privacy.** The shared db holds real channel numbers; keep the artifact private by default, never put credentials in the page or the bundle, and do not post the brief to shared channels without the user's say.
- **Agent overreach.** An agent could simulate a review pass or append a lever to unblock a workflow. `AGENTS.md` and the runner's `human` stages, `decide approve --by`, the refusal of a 7-day row without a lever, and playbook writes only through `--accept-rule` are the guards; git history is the audit trail.

---

## Build order

Phase 1 (this week, everything else depends on it): the four verified fixes with regression tests; `thresholds.ts`; `schema.ts` + `ledger.ts` + `store.ts` aligned with the Desk's collections; `profile.ts` with computed baselines; Studio ingest; `docs/02-strategist-playbook.md`; `assemblePrompt` + `--dry-run`; CLI boolean flags + `cli.test.ts`.
Phase 2 (produces a better package next week): `package.ts` QA loop with `--offline`; promise contract; signature and proof sheet; hook scorer; outlier v2 and `suggestDemand`; bank with lifecycle.
Phase 3 (closes the loop): runner v2; publish pack + `judgeTest`; diagnosis v2 + cold start; decide + repackage prepare; review scheduler + brief; retro + rules; sync; Desk panels; `AGENTS.md`.
Phase 4 (optional leverage): direction + shot list; render hook + header check; Data API adapter; routines.
