# YouTube Channel Booster

A packaging-first operating system for a YouTube channel, built from the playbook of a strategist who runs 40+ channels: ideas from proven demand, package before you produce, clean thumbnails, storytelling that keeps the promise, and a funnel you read in order after every publish.

It ships as four layers that share one set of rules:

| Layer | What it is | Where |
| --- | --- | --- |
| Playbook | The rules, one file per stage. Edit these and every engine changes. | [`playbook/`](playbook/) |
| Engines | Deterministic TypeScript: outlier scan, idea scorecard, title lab, thumbnail QA, packaging review, post-mortem diagnosis, workflow generator. Tested, offline. | [`src/`](src/), [`cli/booster.ts`](cli/booster.ts) |
| Agents | Claude-powered versions of each engine that reason about your specific channel and return structured output the deterministic engines then score. | [`src/ai/`](src/ai/), [`.claude/skills/booster*`](../.claude/skills/) , [`prompts/`](prompts/) |
| Desk | A single-file command center with a shared idea bank and packaging ledger. | [`dashboard/`](dashboard/) |

The research behind it is in [`docs/`](docs/): the evidence-bounded video analysis, the strategist playbook, and the system architecture.

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

Each arrow is a gate. Demand before packaging, packaging before script, script before shoot. `booster workflow "<idea>"` prints the whole runbook with owners, due days, checklists, and gates.

## Commands

```
booster outliers <csv> [--threshold 10] [--min-age-days 7] [--top 20]   rank videos by views / channel median
booster audit <csv> [--threshold 5]                                      audit your own uploads: winners, format lift, proven formats
booster idea questions                                                   the six scorecard questions
booster idea score "<idea>" --score "demand=4,packaging=3,fit=4,angle=3,payoff=4,feasibility=5"
booster titles "<noun-phrase topic>" [--number ..] [--subject ..] [--audience ..]
booster titles score "<title>"
booster thumbnail brief "<idea>" --title ".." [--subject ..] [--stake ..] [--result ..]
booster thumbnail qa --subject ".." --elements "a,b,c" [--emotion ..] [--text ..] [--background ..] [--colors "yellow,black"] [--title ..]
booster package review --title ".." --thumb-text ".." [--elements "a,b,c"]
booster workflow "<idea>" [--format challenge] [--days 14] [--kickoff YYYY-MM-DD] [--out dir]
booster cadence
booster calendar --ideas "A;B;C" --start YYYY-MM-DD [--per-week 1] [--cycle-days 14]
booster postmortem --ctr 2.1 --impressions 24000 --avp 44 --retention30 68 --hours 48 --baseline-ctr 4.5 --baseline-avp 40 --baseline-views 6000
booster ai <engine> ...                                                  see below
```

Add `--json` to any command for machine-readable output. Run with `npm run booster -- <command>` or `npx tsx channel-booster/cli/booster.ts <command>`.

## Claude-powered engines

```
booster ai idea-engine       --niche ".." --channel ".." [--csv competitors.csv] [--count 10]
booster ai title-lab         --idea ".." [--channel ".."]
booster ai thumbnail-factory --idea ".." --title ".." [--channel ".."]
booster ai package-review    --title ".." --thumb ".." [--idea ".."]
booster ai retention-map     --idea ".." --title ".." (--script file.txt | --outline "..")
booster ai postmortem        --title ".." --ctr .. [--impressions ..] [--avp ..] [--retention30 ..] [--hours ..] [--baseline-ctr ..] [--baseline-avp ..]
booster ai channel-audit     --csv my-channel.csv --channel ".."
```

They need `ANTHROPIC_API_KEY` (or an `ant auth login` profile). The default model is `claude-opus-5`; override with `--model` or `BOOSTER_MODEL`, and reasoning depth with `--effort low|medium|high|xhigh|max`. Every engine loads `docs/02-strategist-playbook.md` and `playbook/*.md` as its system prompt with prompt caching, asks for a structured answer, and then runs the deterministic scorer over the model's output so a concept that breaks a rule is flagged even when the model liked it. Tests never call the network.

In Claude Code, the same engines are skills: `/booster` routes, and `/booster-idea-engine`, `/booster-title-lab`, `/booster-thumbnail-factory`, `/booster-packaging-review`, `/booster-retention-map`, `/booster-workflow`, `/booster-postmortem`, `/booster-channel-audit` each run one stage. For other assistants, [`prompts/`](prompts/) has the same prompts as copy-paste text.

## The Desk

[`dashboard/index.html`](dashboard/index.html) is a single file: open it locally or publish it as an artifact. It runs the same engines in the browser (bundled from `src/` by `node channel-booster/dashboard/build.mjs`), keeps an idea bank and a packaging ledger, and, when published with the `db` and `sample` capabilities, shares those with your team and can ask Claude for titles and thumbnail concepts in place. Without those capabilities it falls back to the browser's local storage and says so in the header.

Rebuild after changing an engine or the template:

```bash
node channel-booster/dashboard/build.mjs
```

## Operating cadence

`booster cadence` prints the week: Monday outlier scan and idea bank, Tuesday packaging sprint, Wednesday to Friday production, Friday thumbnail review, a 48-hour review after every publish, Sunday retro. One packaging sprint per publish; fewer, better-packaged uploads beat more uploads.

## Data shape

CSV columns (aliases in parentheses): `title` (video, name), `views` (view count, plays), `published` (publish date, upload date), `channel` (channel title, uploader), `duration` (length, seconds, `12:34`, or `PT12M34S`), `url`. Counts like `1.2M` and `45K` are understood.

## Layout

```
channel-booster/
  README.md                 this file
  docs/                     01 video analysis · 02 strategist playbook · 03 system architecture · research/
  playbook/                 the rules per stage (loaded into every AI engine)
  prompts/                  copy-paste prompts for any model
  src/                      engines + tests
  src/ai/                   Claude-powered engines
  cli/booster.ts            command line
  dashboard/                template.html + build.mjs -> index.html
  examples/                 sample exports
```

## Honest limits

The deterministic scores are heuristics: they catch the obvious mistakes (six words on a thumbnail, a 70-character title, a face with no expression, a clone with no angle) so your judgment is spent on the rest. The video the system was built from could not be transcribed in the build environment; `docs/01-video-analysis.md` says exactly which claims rest on which evidence, and what to correct after watching it.
