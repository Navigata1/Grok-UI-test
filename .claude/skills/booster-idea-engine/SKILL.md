---
name: booster-idea-engine
description: Generate and score YouTube video ideas from proven demand (outliers) for a specific channel. Use when the user asks for video ideas, what to make next, niche research, or "find outliers".
---

# Idea engine

Ideas are borrowed formats plus your angle. Never brainstorm from a blank page.

## Steps

1. Get demand data. Ask for one or more CSV exports (title, views, published, channel, duration) of adjacent channels, or use `channel-booster/examples/competitors.csv` (`example:competitors` from any folder) to demonstrate (a bundled example reads as of the date it was written for and prints a line saying so; report that date, not today's). Run:
   `npm run booster -- outliers <csv> --top 25`
   Read the multipliers and the format lift table.
2. Get the channel read: who watches, what the last three videos were, what already worked (`npm run booster -- audit <own csv>` if available).
3. Produce 10 ideas. For each: the outlier it borrows from (multiplier), the format cue, the angle you add, a working title, a one-line thumbnail concept (one subject, three elements, three words), and the six axis scores from `channel-booster/playbook/idea-scorecard.md`.
4. Score each with `npm run booster -- idea score "<idea>" --score "demand=..,packaging=..,fit=..,angle=..,payoff=..,feasibility=.."` and rank by total. At least two ideas must be yellow or red or the ranking is dishonest.
5. Deliver a ranked table plus the top three as fully packaged briefs (title, thumbnail concept, promise, first payoff). Bank the yellows with their weakest axis named.
6. Persist: `npm run booster -- bank add "<idea>" --score "demand=auto,..." --csv <csv> --promise ".."` banks an idea with its evidence (or `bank import <file.json>` for the AI engine's `--out`); `bank list` ranks the bank, sequels first. Approving an idea to green is the person's (`bank approve <id> --yes`).

With an API key, `npm run booster -- ai idea-engine --niche ".." --channel ".." --csv <csv>` does steps 3-4 in one call; still show your work.

Outside this repository, run the same commands as `channel-booster <command>` inside the channel's workspace (see `/booster`).
