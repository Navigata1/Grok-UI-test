# Agents: how to work this module

For any agent operating the Channel Booster, in any host: Claude Code, Codex, Grok Build, Hermes, OpenClaw, Pi, or a scheduled routine. Every one of them reads this file. The skills under `.claude/skills/booster*` are the Claude Code surface on top of it.

## The loop

One video moves through ten gated stages (see `docs/03-system-architecture.md`, section 3). The 28-day learn is not one of them: `rules compile` runs as the Sunday weekly job, across videos rather than on one. Drive the ten one stage at a time, inside the channel's workspace:

```
channel-booster workflow "<idea>" --format <format> --days 14      # once, creates the runbook in the workspace's packages/
channel-booster workflow run <slug> --next --agent <your-name>       # repeat: runs the next stage, checks its gate
```

From this repository the same commands are `npm run booster -- ...` with `--workspace <folder>`. With no workspace at all (a source checkout's legacy layout), add `--out packages` to the first command so `workflow run` finds the runbook.

Every command stage is a `booster` command, and `workflow run` runs it in the same process; every human stage stops and asks. Never advance past a failed gate. If you must, `--override --reason "..."` records it and the retro shows it.

The weekly rhythm is `booster cadence`. The reads that are due are `booster review due`. The one page a human reads is `booster brief`.

## Running it from any agent host

- Use the installed bin: `channel-booster <command>`. In this repository, `npm run booster -- <command>` is the same command line. The skills and docs write commands in that form; outside this repository, run the same command as `channel-booster <command>`.
- Run inside the channel's workspace, or pass `--workspace <folder>` (or run with `BOOSTER_HOME` set to it). `npm run booster` always starts at the repository root, so from this repository name the workspace on every command.
- Never create a workspace on the person's behalf. `init` decides where a channel's private numbers live, so it is theirs to run. If a command stops with "No channel workspace", ask which workspace to use.
- Never pass `--yes` for a human gate on the person's behalf. Run the command without it, show the person what it prints, and let them re-run it.
- When unsure what a command will read or write, run `where --json` first. It names the workspace and how it was found, each location with its folder and source (`flag`, `env`, `workspace`, `legacy`, `cwd`), and the doctrine hash, and it writes nothing.
- `ai <engine> --dry-run --json` shows the exact prompt, doctrine and channel playbook files without calling the model.

## Human-only gates

An agent prepares; a person decides. Stop and ask at these points, every time:

1. Approving a green idea (identity: the channel's own angle, not a clone).
2. Writing three titles of their own and picking the final title and the A/B thumbnail pair. The pick goes in with `booster package build <slug> --title "<title>"`, and every rebuild keeps it. Offline the builder never chooses a title, so the packaging gate stays shut until a person writes one. `--title` carries the person's pick: an agent never fills it with a formula fill or a title it chose itself. `booster package build <slug> --title "<title>" --lever "<lever>"` also names what that title tests (the person's call too), so the lever is pre-registered with the two A/B angles and `rules compile` counts it.
3. Writing and performing the script, shooting, editing.
4. Clicking publish, starting Test & Compare, applying a repackage swap (public, irreversible).
5. Typing the numbers Studio does not export (30-second retention, returning vs new, Test & Compare panel).
6. Writing the lever learned at 7 days, accepting or rewriting a playbook rule, raising `maxPerWeek`, moving a baseline the profile already carries (`booster profile refresh --yes`; `--dry-run` shows what would move).

Never simulate a review pass, never invent a lever to unblock a 7-day read, never write to `playbook/*.md` except through `booster retro --accept-rule`, never scrape YouTube. Numbers come from a Studio export in `inbox/`, the Desk, or the official Data API adapter with a key the user supplied.

## Where things live

A channel's files live in its workspace: one folder per channel, marked by `booster-workspace.json`. The paths below are relative to it. From a source checkout with no workspace, the same files sit under `channel-booster/` as before, except `packages/`, which sits under the working directory. `where` shows which applies.

- `channel.json`: the channel profile (positioning, persona, series, signature, competitors, cadence, computed baselines). `init` writes a default one and `booster profile init` describes the channel; `channel-booster/channel.example.json` shows every field.
- `data/*.jsonl`: ideas, ledger, experiments, decisions, rules, workflows. Schema in `src/schema.ts`. It holds real channel numbers, so keep it private; export with `booster ledger export`. `last-scan.json`, `last-audit.json` and `reviews/` sit beside them.
- `packages/<slug>/`: package.json, story.json, shots.md, publish.md, thumb-A.png, thumb-B.png, proof-sheet.html. The runbook `workflow "<idea>"` writes sits beside it as `packages/<slug>.md` and `.json`.
- `inbox/`: drop Studio exports here; `booster review run` ingests everything in it, and `booster ingest <file.csv>` takes one by path.
- `playbook/`: this channel's rules. `playbook/00-learned-rules.md` is compiled from evidence; do not edit by hand. Its compiled rules are hypotheses under observation from the channel's own small sample, not doctrine: never present one to the user as a rule to follow, mention it as a hypothesis worth testing with its tests and wins, and let only `booster retro --accept-rule` (a person) move a rule into the playbook. The rules a person accepted sit in this folder too.
- The shipped doctrine (`docs/02-strategist-playbook.md` and `channel-booster/playbook/*.md`) is built into the bin and is the base of every AI engine's prompt. It never lives in a workspace, and the bin never writes into it.

## Evidence discipline

Every threshold prints its tag: `[sourced]`, `[unverified]`, or `[house]`. Do not state an unverified platform mechanic as fact in anything you write for the user; say what the tag says. `docs/01-video-analysis.md` explains why: the source video could not be transcribed in the build environment.
