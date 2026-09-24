---
name: booster-workflow
description: Generate a per-video production workflow, the weekly operating cadence, or a publishing calendar for a YouTube channel. Use when the user asks for a plan, a checklist, a schedule, a content calendar, or "how do we run this".
---

# Workflow generator

- One video: `npm run booster -- workflow "<idea>" --promise "<one sentence the video keeps>" --format <talking-head|documentary|tutorial|challenge|vlog|listicle|interview> --days 14 --kickoff YYYY-MM-DD` writes a Markdown runbook and a JSON spec (in a workspace to its `packages/`; with no workspace, add `--out packages`) with ten gated stages: demand check, packaging sprint, story spine, shoot plan, production, edit and retention pass, thumbnail production, publish package, 48-hour review, 7-day post-mortem. Owners: strategist, writer, creator, editor, designer, analyst (one person can hold several hats; keep the gates).
- Drive it: `npm run booster -- workflow run <slug> --next --agent <name>` runs the next stage (a `booster` command for the eight agent stages: `idea score --out`, `package build`, `hook score`, `plan shots`, `thumbnail proof`, `publish check`, and `review run` twice) and checks its machine gate; only production and edit are human stages, and they wait for the person's evidence file (`footage.txt`, `cut.txt`) in `packages/<slug>/`. The demand stage passes only once a person has approved the idea to green, so it stops an agent that tried to start from a banked idea. `workflow status <slug>` shows where it stands. Never advance past a failed gate; a person may `--override --reason ".." --yes`.
- The shot list: `npm run booster -- plan shots <slug> --format <format>` turns `package.json` and `story.json` into `packages/<slug>/shots.md`: one setup per A/B thumbnail concept (expression, props, background, colours), a shot per payoff-ladder moment, B-roll per rehook, the first 30 seconds.
- The week: `npm run booster -- cadence` prints the six rituals (outlier scan, packaging sprint, production block, thumbnail review, 48-hour review, retro).
- The calendar: `npm run booster -- calendar --ideas "A;B;C" --start YYYY-MM-DD --per-week 1 --cycle-days 14`.

Adapt the checklist lines to the user's team and tools, but never remove a gate: the order (demand before packaging before script before shoot) is the system.

Outside this repository, run the same commands as `channel-booster <command>` inside the channel's workspace (see `/booster`).
