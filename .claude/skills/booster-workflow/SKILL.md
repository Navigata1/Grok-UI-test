---
name: booster-workflow
description: Generate a per-video production workflow, the weekly operating cadence, or a publishing calendar for a YouTube channel. Use when the user asks for a plan, a checklist, a schedule, a content calendar, or "how do we run this".
---

# Workflow generator

- One video: `npm run booster -- workflow "<idea>" --format <talking-head|documentary|tutorial|challenge|vlog|listicle|interview> --days 14 --kickoff YYYY-MM-DD --out ./workflows` writes a Markdown runbook and a JSON spec with ten gated stages: demand check, packaging sprint, story spine, shoot plan, production, edit and retention pass, thumbnail production, publish package, 48-hour review, 7-day post-mortem. Owners: strategist, writer, creator, editor, designer, analyst (one person can hold several hats; keep the gates).
- The week: `npm run booster -- cadence` prints the six rituals (outlier scan, packaging sprint, production block, thumbnail review, 48-hour review, retro).
- The calendar: `npm run booster -- calendar --ideas "A;B;C" --start YYYY-MM-DD --per-week 1 --cycle-days 14`.

Adapt the checklist lines to the user's team and tools, but never remove a gate: the order (demand before packaging before script before shoot) is the system.
