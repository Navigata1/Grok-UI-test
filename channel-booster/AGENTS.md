# Agents: how to work this module

For any agent (Claude Code, Grok Build, a scheduled routine) operating the Channel Booster. The skills under `.claude/skills/booster*` are the Claude Code surface; this file is the surface for everyone else.

## The loop

One video moves through ten gated stages (see `docs/03-system-architecture.md`, section 3). The 28-day learn is not one of them: `rules compile` runs as the Sunday weekly job, across videos rather than on one. Drive the ten one stage at a time:

```
npm run booster -- workflow "<idea>" --format <format> --days 14 --out packages   # once, creates the runbook
npm run booster -- workflow run <slug> --next --agent <your-name>                   # repeat: runs the next stage, checks its gate
```

Every command stage is a `booster` command; every human stage stops and asks. Never advance past a failed gate. If you must, `--override --reason "..."` records it and the retro shows it.

The weekly rhythm is `booster cadence`. The reads that are due are `booster review due`. The one page a human reads is `booster brief`.

## Human-only gates

An agent prepares; a person decides. Stop and ask at these points, every time:

1. Approving a green idea (identity: the channel's own angle, not a clone).
2. Writing three titles of their own and picking the final title and the A/B thumbnail pair.
3. Writing and performing the script, shooting, editing.
4. Clicking publish, starting Test & Compare, applying a repackage swap (public, irreversible).
5. Typing the numbers Studio does not export (30-second retention, returning vs new, Test & Compare panel).
6. Writing the lever learned at 7 days, accepting or rewriting a playbook rule, raising `maxPerWeek`, moving a baseline the profile already carries (`booster profile refresh --yes`; `--dry-run` shows what would move).

Never simulate a review pass, never invent a lever to unblock a 7-day read, never write to `playbook/*.md` except through `booster retro --accept-rule`, never scrape YouTube. Numbers come from a Studio export in `inbox/`, the Desk, or the official Data API adapter with a key the user supplied.

## Where things live

- `channel.json`: the channel profile (positioning, persona, series, signature, competitors, cadence, computed baselines). Start from `channel.example.json`.
- `data/*.jsonl`: ideas, ledger, experiments, decisions, rules, workflows. Schema in `src/schema.ts`. Ignored by git; export with `booster ledger export`.
- `packages/<slug>/`: package.json, story.json, shots.md, publish.md, thumb-A.png, thumb-B.png, proof-sheet.html.
- `inbox/`: drop Studio exports here; `booster review run` ingests everything in it, and `booster ingest <file.csv>` takes one by path.
- `playbook/`: the rules. `playbook/00-learned-rules.md` is compiled from evidence; do not edit by hand.

## Evidence discipline

Every threshold prints its tag: `[sourced]`, `[unverified]`, or `[house]`. Do not state an unverified platform mechanic as fact in anything you write for the user; say what the tag says. `docs/01-video-analysis.md` explains why: the source video could not be transcribed in the build environment.
