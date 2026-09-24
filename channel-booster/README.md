# YouTube Channel Booster

A packaging-first operating system for a YouTube channel, built from the playbook of a strategist who runs 40+ channels: ideas from proven demand, package before you produce, clean thumbnails, storytelling that keeps the promise, and a funnel you read in order after every publish.

It ships as four layers that share one set of rules:

| Layer | What it is | Where |
| --- | --- | --- |
| Playbook | The rules, one file per stage. Edit these and every engine changes. The packaged bin carries them built in. | [`playbook/`](playbook/) |
| Engines | Deterministic TypeScript: outlier scan, idea bank, package builder with gates, thumbnail floor, hook and promise checks, workflow runner, funnel diagnosis, decision engine, review agent, retro and learned rules. Tested, offline. | [`src/`](src/), [`cli/main.ts`](cli/main.ts), [`bin/`](bin/) |
| Agents | Claude-powered versions of each engine that reason about your specific channel and return structured output the deterministic engines then score. | [`src/ai/`](src/ai/), [`.claude/skills/booster*`](../.claude/skills/), [`prompts/`](prompts/) |
| Desk | A single-file command center: the same engines in the browser over a shared idea bank, ledger, decisions and rules. | [`dashboard/`](dashboard/) |

The research behind it is in [`docs/`](docs/): the evidence-bounded video analysis, the strategist playbook (rules R1-R13 with evidence tags), the system architecture, and the routines that run it unattended. [`AGENTS.md`](AGENTS.md) is the contract for any agent that operates it, whatever host it runs in: what it may do alone and where it must stop for a person.

## Two ways to run it

- From this repository: `npm run booster -- <command>` at the repository root, exactly as before. Every command, flag and environment variable documented before the packaged tool existed still works, and with no workspace a source checkout keeps a channel's files where it always did (`channel-booster/data/`, `channel-booster/channel.json`).
- As a packaged tool: `channel-booster <command>`, installed from a tarball you build here. It runs on plain Node.js 22 or later, with no tsx and no copy of this repository, and keeps each channel in its own workspace folder. See [Run it as a packaged tool](#run-it-as-a-packaged-tool).

The commands and flags are the same in both. This README writes them as `booster <command>`.

## Quick start

```bash
npm ci
npm run booster -- help
npm run booster -- outliers channel-booster/examples/competitors.csv
npm run booster -- audit channel-booster/examples/my-channel.csv
npm run booster -- idea score "I lived off a solar generator for 30 days" --score "demand=auto,packaging=4,fit=4,angle=3,payoff=4,feasibility=4" --outliers channel-booster/examples/competitors.csv
```

The last line scores an idea against the example scan: YELLOW 72, with demand 3/5 from two solar-generator outliers. The bundled examples have fixed dates, so `outliers`, `audit` and the `demand=auto` read of `idea score` and `bank add` score them as of the date each file was written for: 2026-07-10 for the competitors and 2026-08-16 for the channel. Each prints `Example data: scored as of <date>, the date it was written for; pass --now to override.` Your own exports always use today's date, and `--now ISO` sets any date you choose.

The bundled exports also have names that work from any folder, in this repository and in the packaged tool: `example:competitors`, `example:my-channel` and `example:studio-content`. Use one wherever a command takes a CSV: `outliers`, `audit`, `idea score --outliers`, `bank add --csv`, `bank rescore` and its `--own`, `ingest`, and `ai <engine> --csv`. A name reads as of its file's own date, like the path does.

Export your own data from YouTube Studio (Content > Analytics > Advanced mode > Export) or any competitor-research tool as CSV with at least a title and a views column; published date, channel, and duration are used when present. Header names from common exports are recognised automatically.

## Run it as a packaged tool

The package is private: it is not on npm, so you build the tarball and install it yourself. From a checkout where `npm ci` has run:

```bash
npm run booster:build                              # at the repository root; npm run build inside channel-booster/ does the same
cd channel-booster && npm pack                     # writes channel-booster-0.1.0.tgz
npm install --global ./channel-booster-0.1.0.tgz   # or npm install <path to the .tgz> in a project and run npx channel-booster
channel-booster init ~/channels/my-channel --channel "My Channel"
cd ~/channels/my-channel
channel-booster outliers example:competitors --save
```

The build writes one bundle, `channel-booster/dist/channel-booster.mjs`, and rebuilds the Desk. zod and the Anthropic SDK stay out of the bundle and install as the package's dependencies. `init` prints the first three commands to run. Run them, and every later command, from inside the workspace folder, or from any folder with `--workspace <folder>` or `BOOSTER_HOME=<folder>`.

### The workspace

A workspace is one folder per channel. `booster init <folder> [--channel "<name>"]` creates it:

```
my-channel/
  booster-workspace.json   the marker that makes this folder a channel workspace
  channel.json             the channel profile: the default until you describe the channel (profile init ... --force, or edit it)
  data/                    the store (ideas, ledger, decisions, experiments, rules, workflows), last-scan.json, last-audit.json, reviews/
  packages/                packages/<slug>/ for every video, and the runbooks workflow "<idea>" writes
  inbox/                   Studio and competitor exports for review run and brief
  playbook/                this channel's rules: the compiled 00-learned-rules.md and the rules a person accepted
```

`init` refuses a folder that is already a workspace. With `--force` it creates whatever is missing and never overwrites `channel.json` or the data.

### How a command finds its files

A command looks for the workspace in this order: `--workspace <folder>`, then `BOOSTER_HOME`, then the nearest folder at or above the working directory that holds `booster-workspace.json`. If `--workspace` or `BOOSTER_HOME` names a folder without the marker, a command that reads or writes the channel's files stops, and `where` says so and exits 1. A typo never scatters a channel's files into a new folder.

Each location then takes the first of: its own flag, its own environment variable, the workspace, the legacy default.

| Location | Flag | Environment variable | In a workspace | Legacy default |
| --- | --- | --- | --- | --- |
| Store | `--data` | `BOOSTER_DATA` | `data/` | `channel-booster/data/` |
| Profile | `--path` | `BOOSTER_PROFILE` | `channel.json` | `channel-booster/channel.json` |
| Packages root | `--root` | none | the workspace folder | the working directory |
| Inbox | `--inbox` | none | `inbox/` | `channel-booster/inbox/` |
| Channel playbook | `--playbook` | none | `playbook/` | `channel-booster/playbook/` |

The legacy defaults are the folders a source checkout has always used, so an old runbook runs unchanged. The packaged bin has no legacy default, apart from the working directory for the packages root. Outside a workspace, a bin command that needs the store, the profile, the inbox or the playbook stops and tells you how to create one. `BOOSTER_DATA` and `BOOSTER_PROFILE` outrank every workspace, and `init` warns when either is set.

`booster where` shows what resolved: the workspace and how it was found, each location with its folder and where that came from (`flag`, `env`, `workspace`, `legacy` or `cwd`), and the hash of the doctrine this build ships. `booster where --json` prints the same as one object. Neither writes anything.

From this repository, `npm run booster` always starts at the repository root, so the workspace search starts there too, not in the folder you typed the command in. Keep the workspace outside the checkout, where `git add` cannot pick up a channel's numbers, and name it on each command: `npm run booster -- init ../my-channel`, then `--workspace ../my-channel` or `BOOSTER_HOME=<folder>`.

## The pipeline for one video

```
scan ──> idea bank ──> package ──> thumbnail ──> story ──> produce ──> publish ──> 48h review ──> 7d post-mortem
 │          │             │            │           │                                  │               │
 outliers   6-axis        10 titles    spec + QA   first 30s                          funnel          ledger
 + lift     scorecard     + review     + brief     + rehooks                          diagnosis       + rule
```

Each arrow is a gate. Demand before packaging, packaging before script, script before shoot. `booster workflow "<idea>"` writes the runbook with owners, due days, checklists and machine gates (in a workspace to its `packages/`; outside one, pass `--out packages`), and `booster workflow run <slug> --next` drives it one stage at a time: the agent stages run a `booster` command and check its artifact (`demand.json` verdict and bank status both green, `package.json` gates pass, `story.json` hook score, `shots.md`, `proof-sheet.html`, `publish-check.json`, `review-48.json`); the creative stages wait for a person's evidence file. Nothing advances past a failed gate without a recorded, reasoned override.

A booster stage runs in the same process as `workflow run`. The runner calls the command line's own `main()` with the run's store, profile, workspace and clock, so a stage needs no child process and no tsx. A runbook stores each stage command as `booster <verb> ...` and prints it the way this build is typed: `npm run booster -- ...` from source, `channel-booster ...` from the bin. Runbooks written earlier with `npm run booster -- ...` still run and record the same result. `--isolate`, or `BOOSTER_STAGE_ISOLATION=process`, runs each booster stage as a child process instead.

## Commands

`booster help` prints every command. `--json` on any of them gives machine-readable output, `--workspace <folder>` names the channel's workspace, `--data <dir>` and `--path <channel.json>` move the store and the profile, and `--now ISO` fixes the clock. Grouped by what they are for:

**Set up the channel**

```
booster init <folder> [--channel "<name>"] [--force]                          a channel workspace: booster-workspace.json, channel.json, data/, packages/, inbox/, playbook/
booster where [--json]                                                        every folder commands read and write, where each came from, and the doctrine this build ships
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
booster idea score "<idea>" --score "demand=auto,packaging=3,..." --outliers <csv> | idea score <slug> [--out packages/<slug>/demand.json]
booster bank add "<idea>" --score ".." [--promise ..] [--series ..] | bank list | bank approve <id> --yes | bank park|reject <id> --reason ".."
booster bank rescore <competitors.csv> | bank sequels | bank import <ideas.json> | bank wip
```

A bare `--save` writes the scan into the store: `outliers` to `<data>/last-scan.json`, `audit` to `<data>/last-audit.json`, so the two never overwrite each other. `--diff` and `direction --scan` take a bare file name and look for it in the store, so the examples above work from any directory and under any `--data`.

**Package before you produce**

```
booster package build "<idea>"|<idea:id>|<slug> --promise ".." [--title ".." [--lever ".."]] [--rounds 3] [--offline]   titles, concepts, QA, A/B pair, gates -> packages/<slug>/package.json + .md
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
booster workflow "<idea>" [--promise ".."] [--format talking-head] [--days 14] [--kickoff YYYY-MM-DD] [--out packages]   in a workspace the runbook goes to its packages/; outside one, pass --out packages
booster workflow run <slug> [--next | --stage <id>] [--agent <name>] [--dry-run] [--isolate]   one stage at a time, in this process; --override --reason ".." --yes is a person's call
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
booster retro [--since 7d] | retro --accept-rule ".." --into playbook/<file>.md --yes   the retro; the only writer to a file in the channel playbook folder
booster rules compile | rules show                                            00-learned-rules.md in the channel playbook folder, from the ledger: hypotheses under observation
booster ai <engine> ...                                                       see below
```

Human-only gates are marked `--yes`: the command prints what it is about to record and stops until a person re-runs it with the flag. Run with `npm run booster -- <command>` or `npx tsx channel-booster/cli/booster.ts <command>` from this repository, or `channel-booster <command>` once the package is installed.

## Claude-powered engines

```
booster ai idea-engine       --niche ".." [--channel ".."] [--csv competitors.csv | --csv example:competitors] [--count 10]
booster ai title-lab         --idea ".." [--channel ".."]
booster ai thumbnail-factory --idea ".." --title ".." [--channel ".."]
booster ai package-fix       --idea ".." --title ".." --fixes "a; b" [--previous round.json]
booster ai package-review    --title ".." --thumb ".." [--idea ".."]
booster ai retention-map     --idea ".." --title ".." (--script file.txt | --outline "..")
booster ai postmortem        --title ".." --ctr .. [--impressions ..] [--avp ..] [--retention30 ..] [--hours ..] [--baseline-ctr ..]
booster ai channel-audit     --csv my-channel.csv [--channel ".."]
```

They need `ANTHROPIC_API_KEY` (or an `ant auth login` profile). The default model is `claude-opus-5`; override with `--model` or `BOOSTER_MODEL`, and reasoning depth with `--effort low|medium|high|xhigh|max`. `--dry-run` prints the exact system blocks and user message and stops. `booster ai <engine> --dry-run --json` prints the same as one object: engine, model, effort, doctrine, channel playbook files, system blocks and user message. Neither calls the model, and the Anthropic SDK is loaded only when an engine really runs. `--out file.json` keeps the result (`booster bank import` reads the idea engine's). Without `--channel`, the channel line comes from the channel's `channel.json`. The model returns a structured answer and the deterministic scorer then runs over it, so a concept that breaks a rule is flagged even when the model liked it. `booster package build` uses the same engines as its generators and feeds every failed gate back through `package-fix` for up to three rounds; without a key it runs the offline thumbnail generator once and leaves the title to you (`--title`), because a formula with the topic pasted in is not a title. A title you pass with `--title` wins over the model's too. Tests never call the network.

The doctrine is built in. Every engine's cached system prompt starts from the doctrine this build ships: `docs/02-strategist-playbook.md` and the `playbook/*.md` files, with the `prompts/package-fix.md` template the fix rounds fill. The packaged bin carries these inside its bundle, so it never reads a docs or playbook folder from disk. From source they are read from the checkout. On top of the shipped doctrine the prompt loads the channel playbook folder: the workspace's `playbook/`, or `--playbook`. The order is fixed:

1. `docs/02-strategist-playbook.md`.
2. The channel's compiled `00-learned-rules.md`, when it exists. The system prompt calls these observations under test from a small sample that never override the doctrine.
3. The shipped `playbook/*.md` files.
4. The channel's other playbook files, which hold the rules a person accepted.

From a source checkout with no workspace, the channel playbook folder is `channel-booster/playbook/` itself, and the prompt is byte for byte the one earlier versions built.

The doctrine hash is 12 hex characters of sha256 over the names and text of `docs/02` and `playbook/*.md`. `where` prints it, the dry run shows it, and every real run prints a provenance line under its result: `Provenance: model claude-opus-5 · effort high · doctrine <hash> (<n> files) · overlay <folder>: <files>`. The same provenance goes into the `--json` and `--out` output as a `provenance` object. `--no-doctrine` leaves the shipped doctrine out on purpose: the prompt says the run has none, the channel playbook folder still loads, and the hash reads `none`.

In Claude Code, the same engines are skills: `/booster` routes, and `/booster-idea-engine`, `/booster-title-lab`, `/booster-thumbnail-factory`, `/booster-packaging-review`, `/booster-retention-map`, `/booster-workflow`, `/booster-postmortem`, `/booster-channel-audit` each run one stage. The skills write their commands as `npm run booster -- <command>`; outside this repository the same commands run as `channel-booster <command>` inside the channel's workspace. Any other agent host reads [`AGENTS.md`](AGENTS.md), and [`prompts/`](prompts/) has the same prompts as copy-paste text.

## The Desk

[`dashboard/index.html`](dashboard/index.html) is a single file: open it locally or publish it as an artifact. It runs the same engines in the browser (bundled from `src/` by `node channel-booster/dashboard/build.mjs`), keeps an idea bank and a packaging ledger, and, when published with the `db` and `sample` capabilities, shares those with your team and can ask Claude for titles and thumbnail concepts in place. Without those capabilities it falls back to the browser's local storage and says so in the header.

The Desk opens dark, in a Grok-style palette, whatever theme the host page or the operating system asks for. The Dark/Light control in the header switches it. The browser remembers the choice (localStorage key `booster.desk.theme`), so it applies to that browser only; where the browser blocks storage, the Desk opens dark every time. `node channel-booster/scripts/desk-runtime.mjs` (gate P1-G2) drives the built Desk in Chromium and checks the dark default, the light option, the in-page gates, zero network requests, the 390px phone layout and text contrast.

The page itself makes no network request (the shared db and Claude calls, when granted, go through the artifact host). Its fonts (Syne, IBM Plex Sans, IBM Plex Mono, each under the SIL Open Font License 1.1, in [`dashboard/fonts/`](dashboard/fonts/)) are inlined, and the two thumbnail exports you pick in Publish are read in the browser for their size and dimensions, never uploaded. Every human gate (approving a green idea, confirming the publish, approving a decision, accepting a rule, deleting an idea or a ledger row) asks inside the page, because a published artifact answers the browser's own confirm dialog with no. Its example scan is `examples/competitors.csv`, read as of 2026-07-10 as the CLI reads it. Offline, its title lab shows the formula shapes with a blank to write your own title from, not scored fills.

Rebuild after changing an engine, the template or a font (`npm run booster:build` rebuilds it too):

```bash
node channel-booster/dashboard/build.mjs
```

## Operating cadence

`booster cadence` prints the week: Monday outlier scan and idea bank, Tuesday packaging sprint, Wednesday to Friday production, Friday thumbnail review, a 48-hour review after every publish, Sunday retro. One packaging sprint per publish; fewer, better-packaged uploads beat more uploads.

The unattended half runs on three jobs against the channel's workspace ([`docs/routines.md`](docs/routines.md) has the schedules, how to point them at a workspace, and the agent prompt): `booster review run` every six hours (ingest `inbox/`, diagnose every read that is due, record a decision, prepare a swap, write the digest), `booster outliers <csv> --fresh --diff last-scan.json --save && booster bank rescore <csv> && booster brief --week` on Monday, and `booster rules compile && booster retro --since 7d` on Sunday. The agent prepares; a person approves ideas, picks the final package, publishes, applies swaps, types the two numbers Studio does not export, writes the 7-day lever and accepts rules.

## Checks

From `channel-booster/`, `npm run verify` typechecks, runs every test and builds the bundle and the Desk. Three scripts check what the tests cannot:

- `node channel-booster/scripts/package-smoke.mjs` (gate P0-G2; `npm run test:booster-package` at the repository root): packs the tarball, installs it into an empty folder, and drives the bin there. It checks the node shebang, that tsx is absent, that the installed doctrine matches the source doctrine, and that a first run writes nothing outside the workspace.
- `node channel-booster/scripts/standalone-check.mjs` (gate P0-G3): copies only the booster's files into an empty folder in the layout of its own repository (`scripts/split-template/` holds the root files), then runs `npm install` and `npm run verify` there.
- `node channel-booster/scripts/desk-runtime.mjs` (gate P1-G2): the Desk journey above.

## Data shape

CSV columns (aliases in parentheses): `title` (video, name), `views` (view count, plays), `published` (publish date, upload date), `channel` (channel title, uploader), `duration` (length, seconds, `12:34`, or `PT12M34S`), `url`. Counts like `1.2M` and `45K` are understood.

## Layout

```
channel-booster/
  README.md                 this file
  AGENTS.md                 the contract for any agent host: what an agent may do alone and where it stops for a person
  package.json              the channel-booster package (private): the bin, its two runtime dependencies, build and verify scripts
  bin/channel-booster.mjs   the packaged command line: checks for Node 22 or later, then runs main() from dist/
  dist/                     the bundle npm run build writes (git-ignored)
  channel.example.json      every profile field; a workspace's channel.json has the same shape
  docs/                     01 video analysis · 02 strategist playbook · 03 system architecture · routines · research/
  playbook/                 the shipped rules per stage, built into the bundle and loaded into every AI engine
  prompts/                  copy-paste prompts for any model; package-fix.md ships with the doctrine
  src/                      engines + tests (thresholds.ts holds every gate with its evidence tag; workspace.ts says where a channel's files live)
  src/ai/                   Claude-powered engines: the shipped doctrine, prompt assembly, schemas, the one file that calls the API
  cli/                      main.ts is the command line as one function; booster.ts runs it with tsx; commands/*.ts per group
  scripts/                  build.ts (the bundle), package-smoke.mjs, standalone-check.mjs with split-template/, desk-runtime.mjs
  dashboard/                template.html + fonts/ + build.mjs -> index.html (one file, no network requests)
  examples/                 sample exports, named example:<name> from any folder
  LICENSE, NOTICE           MIT, and where the booster was built and the third-party material it carries
```

In a workspace, a channel's files live in the workspace folder (see [The workspace](#the-workspace)). From a source checkout with no workspace, they sit in the legacy places, all ignored by git:

```
channel-booster/channel.json      your profile: positioning, series, signature, competitors, cadence, thresholds, baselines
channel-booster/data/             the store: ideas, ledger, decisions, experiments, rules, workflows (JSONL); last-scan.json and last-audit.json land here too
channel-booster/inbox/            drop Studio exports here for booster review run
channel-booster/playbook/00-learned-rules.md   compiled from the ledger, beside the shipped files; accepted rules are appended to the shipped files
packages/<slug>/                  under the working directory (the repository root for npm run booster) or --root: demand.json, package.json/.md, story.json, shots.md, proof-sheet.html, publish.md, review-48.json
```

## Honest limits

The deterministic scores are heuristics: they catch the obvious mistakes (six words on a thumbnail, a 70-character title, a face with no expression, a clone with no angle) so your judgment is spent on the rest. The video the system was built from could not be transcribed in the build environment; `docs/01-video-analysis.md` says exactly which claims rest on which evidence, and what to correct after watching it.
