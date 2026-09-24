# YouTube Channel Booster

A packaging-first operating system for a YouTube channel, built from the playbook of a strategist who runs 40+ channels: ideas from proven demand, package before you produce, clean thumbnails, storytelling that keeps the promise, and a funnel you read in order after every publish.

It ships as four layers that share one set of rules:

| Layer | What it is | Where |
| --- | --- | --- |
| Playbook | The rules, one file per stage. Edit these and every engine changes. | [`playbook/`](playbook/) |
| Engines | Deterministic TypeScript: outlier scan, idea bank, package builder with gates, thumbnail floor, hook and promise checks, workflow runner, funnel diagnosis, decision engine, review agent, retro and learned rules. Tested, offline. | [`src/`](src/), [`cli/booster.ts`](cli/booster.ts) |
| Agents | Claude-powered versions of each engine that reason about your specific channel and return structured output the deterministic engines then score. | [`src/ai/`](src/ai/), [`.claude/skills/booster*`](../.claude/skills/) , [`prompts/`](prompts/) |
| Desk | A single-file command center: the same engines in the browser over a shared idea bank, ledger, decisions and rules. | [`dashboard/`](dashboard/) |

The research behind it is in [`docs/`](docs/): the evidence-bounded video analysis, the strategist playbook (rules R1-R13 with evidence tags), the system architecture, and the routines that run it unattended. [`AGENTS.md`](AGENTS.md) is the contract for any agent that operates it: what it may do alone and where it must stop for a person.

## Quick start

```bash
npm ci
npm run booster -- help
npm run booster -- outliers channel-booster/examples/competitors.csv
npm run booster -- audit channel-booster/examples/my-channel.csv
```

Export your own data from YouTube Studio (Content > Analytics > Advanced mode > Export) or any competitor-research tool as CSV with at least a title and a views column; published date, channel, and duration are used when present. Header names from common exports are recognised automatically.

## The pipeline for one video

```
scan ──> idea bank ──> package ──> thumbnail ──> story ──> produce ──> publish ──> 48h review ──> 7d post-mortem
 │          │             │            │           │                                  │               │
 outliers   6-axis        10 titles    spec + QA   first 30s                          funnel          ledger
 + lift     scorecard     + review     + brief     + rehooks                          diagnosis       + rule
```

Each arrow is a gate. Demand before packaging, packaging before script, script before shoot. `booster workflow "<idea>"` writes the runbook with owners, due days, checklists and machine gates, and `booster workflow run <slug> --next` drives it one stage at a time: the agent stages run a `booster` command and check its artifact (`demand.json` verdict and bank status both green, `package.json` gates pass, `story.json` hook score, `shots.md`, `proof-sheet.html`, `publish-check.json`, `review-48.json`); the creative stages wait for a person's evidence file. Nothing advances past a failed gate without a recorded, reasoned override.

## Commands

`npm run booster -- help` prints every command; `--json` on any of them gives machine-readable output, `--data <dir>` and `--path <channel.json>` move the store and the profile, `--now ISO` fixes the clock. Grouped by what they are for:

**Set up the channel**

```
booster profile init [--positioning ..] [--persona ..] [--colors "yellow,black"] [--competitors "A, B"] [--max-per-week 1] [--publish-day thu] [--solo|--team]
booster profile show | profile refresh [--window 10] [--min-age-days 7] [--dry-run] [--yes]   the profile and its computed baselines (median + MAD, tier prior/thin/solid); moving a baseline it already has needs --yes
booster signature show | signature set --colors "yellow,black" [--face ..] [--max-words 3]
booster thresholds [<key>]                                                    every gate as "key value [evidence] note"; override any in channel.json
```

**Find demand and bank ideas**

```
booster outliers <csv> [--since 90] [--fresh] [--by topic] [--saturation] [--diff last-scan.json] [--save]   competitors: views / channel median
booster audit <csv> [--threshold 5] [--diff last-audit.json] [--save]         your own uploads: winners, format lift, proven formats
booster direction [--scan last-audit.json]                                    positioning, proven formats, series trends, never-again, three bets
booster idea score "<idea>" --score "demand=auto,packaging=3,..." --outliers <csv> | idea score <slug> [--out demand.json]
booster bank add "<idea>" --score ".." [--promise ..] [--series ..] | bank list | bank approve <id> --yes | bank park|reject <id> --reason ".."
booster bank rescore <competitors.csv> | bank sequels | bank import <ideas.json> | bank wip
```

A bare `--save` writes the scan into the store: `outliers` to `<data>/last-scan.json`, `audit` to `<data>/last-audit.json`, so the two never overwrite each other. `--diff` and `direction --scan` take a bare file name and look for it in the store, so the examples above work from any directory and under any `--data`.

**Package before you produce**

```
booster package build "<idea>"|<idea:id>|<slug> --promise ".." [--title ".."] [--rounds 3] [--offline]   titles, concepts, QA, A/B pair, gates -> packages/<slug>/package.json + .md
   offline the builder never picks a title: the title gate fails until you write one (--title); every rebuild, the workflow's included, keeps it
booster titles "<topic>" | titles score "<title>"   the formulas as shapes with a blank (no scores); score what you write from them
booster thumbnail brief "<idea>" --title ".." | thumbnail qa --subject ".." --elements "a,b,c" [--text ..]
booster thumbnail proof <slug> [--images dir] | thumbnail render <slug> | thumbnail check <file.png>
booster package review --title ".." --thumb-text ".."
booster hook score --script <file> --slug <slug> [--payoffs retention-map.json]   packages/<slug>/story.json; exit 1 when the hook gate fails
   the payoff ladder comes from --payoffs, else from packages/<slug>/payoffs.json if it is there: {"payoffLadder": [{"atSec": 45, "moment": ".."}]}
   the shoot plan's gate needs at least one payoff, because a shot list with nothing to prove is not a shoot plan
booster promise check --promise ".." [--title ..] [--script <file>] [--description ..] [--thumb-text ..]
booster plan shots <slug> [--format ..]                                       the shoot's shot list from package.json + story.json
```

**Run the workflow and publish**

```
booster workflow "<idea>" [--promise ".."] [--format talking-head] [--days 14] [--kickoff YYYY-MM-DD] --out packages
booster workflow run <slug> [--next | --stage <id>] [--agent <name>] [--dry-run]   one stage at a time; --override --reason ".." --yes is a person's call
booster workflow status <slug> | cadence | calendar --ideas "A;B;C" --start YYYY-MM-DD
booster publish pack <slug> | publish check <slug> | publish confirm <slug> --video-id <id> --at <ISO> [--levers "a,b"] [--predicted-ctr 1.3] --yes
booster test judge --slug <slug> --a "impr,ctr" --b ".." --hours 72 [--record]
```

**Read the numbers and decide**

```
booster ingest <studio-content.csv> [--bucket 24|48|168|672]                  a Studio export as ledger reads
booster set <slug> --bucket 48 --ret30 62 --returning 38 [--lever ".." --yes]  the numbers Studio does not export; the 7-day lever
booster ledger show|baseline|levers|winners|due|export
booster postmortem --ctr 4.2 --impressions 24000 --avp 38 --hours 48 [--mode cold-start]
booster decide --slug <slug> --bucket 48 --record | decide approve <slug> --bucket 48 --by <name> --yes | decide apply ... --yes
booster repackage prepare <slug> [--bucket 48]                                the swap plan; a person applies it in Studio
booster review due | review run [--slug <slug> --bucket 48]                  the review agent: ingest, diagnose, decide, prepare, digest
```

**Learn**

```
booster brief [--week | --today]                                              the Monday page
booster retro [--since 7d] | retro --accept-rule ".." --into playbook/<file>.md --yes   the retro; the only writer to playbook/*.md
booster rules compile | rules show                                            playbook/00-learned-rules.md from the ledger: hypotheses under observation
booster ai <engine> ...                                                       see below
```

Human-only gates are marked `--yes`: the command prints what it is about to record and stops until a person re-runs it with the flag. Run with `npm run booster -- <command>` or `npx tsx channel-booster/cli/booster.ts <command>`.

## Claude-powered engines

```
booster ai idea-engine       --niche ".." [--channel ".."] [--csv competitors.csv] [--count 10]
booster ai title-lab         --idea ".." [--channel ".."]
booster ai thumbnail-factory --idea ".." --title ".." [--channel ".."]
booster ai package-fix       --idea ".." --title ".." --fixes "a; b" [--previous round.json]
booster ai package-review    --title ".." --thumb ".." [--idea ".."]
booster ai retention-map     --idea ".." --title ".." (--script file.txt | --outline "..")
booster ai postmortem        --title ".." --ctr .. [--impressions ..] [--avp ..] [--retention30 ..] [--hours ..] [--baseline-ctr ..]
booster ai channel-audit     --csv my-channel.csv [--channel ".."]
```

They need `ANTHROPIC_API_KEY` (or an `ant auth login` profile). The default model is `claude-opus-5`; override with `--model` or `BOOSTER_MODEL`, and reasoning depth with `--effort low|medium|high|xhigh|max`. `--dry-run` prints the exact system blocks and user message and stops; `--out file.json` keeps the result (`booster bank import` reads the idea engine's). Every engine loads the doctrine in a fixed order as its cached system prompt: `docs/02-strategist-playbook.md`, then `playbook/00-learned-rules.md` when it exists (the channel's compiled rules, which the system prompt calls observations under test from a small sample that never override the doctrine), then the other `playbook/*.md` files; without `--channel`, the channel line comes from `channel.json`. The model returns a structured answer and the deterministic scorer then runs over it, so a concept that breaks a rule is flagged even when the model liked it. `booster package build` uses the same engines as its generators and feeds every failed gate back through `package-fix` for up to three rounds; without a key it runs the offline thumbnail generator once and leaves the title to you (`--title`), because a formula with the topic pasted in is not a title. A title you pass with `--title` wins over the model's too. Tests never call the network.

In Claude Code, the same engines are skills: `/booster` routes, and `/booster-idea-engine`, `/booster-title-lab`, `/booster-thumbnail-factory`, `/booster-packaging-review`, `/booster-retention-map`, `/booster-workflow`, `/booster-postmortem`, `/booster-channel-audit` each run one stage. For other assistants, [`prompts/`](prompts/) has the same prompts as copy-paste text.

## The Desk

[`dashboard/index.html`](dashboard/index.html) is a single file: open it locally or publish it as an artifact. It runs the same engines in the browser (bundled from `src/` by `node channel-booster/dashboard/build.mjs`), keeps an idea bank and a packaging ledger, and, when published with the `db` and `sample` capabilities, shares those with your team and can ask Claude for titles and thumbnail concepts in place. Without those capabilities it falls back to the browser's local storage and says so in the header.

Rebuild after changing an engine or the template:

```bash
node channel-booster/dashboard/build.mjs
```

## Operating cadence

`booster cadence` prints the week: Monday outlier scan and idea bank, Tuesday packaging sprint, Wednesday to Friday production, Friday thumbnail review, a 48-hour review after every publish, Sunday retro. One packaging sprint per publish; fewer, better-packaged uploads beat more uploads.

The unattended half runs on three jobs ([`docs/routines.md`](docs/routines.md) has the schedules and the agent prompt): `booster review run` every six hours (ingest `inbox/`, diagnose every read that is due, record a decision, prepare a swap, write the digest), `booster outliers <csv> --fresh --diff last-scan.json --save && booster bank rescore <csv> && booster brief --week` on Monday, and `booster rules compile && booster retro --since 7d` on Sunday. The agent prepares; a person approves ideas, picks the final package, publishes, applies swaps, types the two numbers Studio does not export, writes the 7-day lever and accepts rules.

## Data shape

CSV columns (aliases in parentheses): `title` (video, name), `views` (view count, plays), `published` (publish date, upload date), `channel` (channel title, uploader), `duration` (length, seconds, `12:34`, or `PT12M34S`), `url`. Counts like `1.2M` and `45K` are understood.

## Layout

```
channel-booster/
  README.md                 this file
  AGENTS.md                 what an agent may do alone and where it stops for a person
  channel.json              your profile: positioning, series, signature, competitors, cadence, thresholds, baselines (see channel.example.json)
  docs/                     01 video analysis · 02 strategist playbook · 03 system architecture · routines · research/
  playbook/                 the rules per stage (loaded into every AI engine); 00-learned-rules.md is compiled from the ledger
  prompts/                  copy-paste prompts for any model
  src/                      engines + tests (thresholds.ts holds every gate with its evidence tag)
  src/ai/                   Claude-powered engines: prompt assembly, schemas, the one file that calls the API
  cli/                      booster.ts routes; commands/*.ts per group
  dashboard/                template.html + build.mjs -> index.html
  examples/                 sample exports
  data/                     the store: ideas, ledger, decisions, experiments, rules, workflows (JSONL, git-ignored); last-scan.json and last-audit.json land here too
  inbox/                    drop Studio exports here for booster review run (git-ignored)
  packages/<slug>/          demand.json, package.json/.md, story.json, shots.md, proof-sheet.html, publish.md, review-48.json (git-ignored)
```

## Honest limits

The deterministic scores are heuristics: they catch the obvious mistakes (six words on a thumbnail, a 70-character title, a face with no expression, a clone with no angle) so your judgment is spent on the rest. The video the system was built from could not be transcribed in the build environment; `docs/01-video-analysis.md` says exactly which claims rest on which evidence, and what to correct after watching it.
