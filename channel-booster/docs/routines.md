# Routines: running the system unattended

Three jobs run without a person. Each is one `booster` command; each stops at the human-only gates in `AGENTS.md`.

| When | Command | What it does |
| --- | --- | --- |
| Every 6 hours | `npm run booster -- review run` | Ingests anything in `inbox/`, diagnoses every read that is due (24, 48, 168, 672 h), records a decision, prepares a repackage when one is warranted, writes `data/reviews/<date>.json` and a digest. Nothing happens unless a slug is due. |
| Monday, early | `npm run booster -- outliers <competitors.csv> --fresh --diff data/last-scan.json --save data/last-scan.json && npm run booster -- bank rescore <competitors.csv> && npm run booster -- brief --week` | Refreshes the outlier scan, wakes parked ideas whose topic got a fresh outlier, decays stale ones, and writes the Monday brief. |
| Sunday, late | `npm run booster -- rules compile && npm run booster -- retro --since 7d` | Compiles learned rules from the ledger into `playbook/00-learned-rules.md` and drafts the retro for the human to accept. |

## As a Claude Code Routine (recommended)

From any Claude Code session with this repository attached, create a recurring session with a prompt like:

```
You are the Channel Booster review agent. In /channel-booster run `npm run booster -- review run`, then `npm run booster -- brief --today`. Read AGENTS.md first. If a decision awaits approval or a repackage is prepared, summarise it in one paragraph and stop; never approve, apply a swap, or write a lever yourself. If inbox/ is empty and nothing is due, say so in one line and stop.
```

Schedule it every six hours. For the Monday and Sunday jobs, create two more routines with the commands above. The agent needs the repository checked out and, for `booster ai` engines, an `ANTHROPIC_API_KEY`; it never needs YouTube credentials.

## As cron on your own machine

```
0 */6 * * *  cd /path/to/repo && npm run booster -- review run >> channel-booster/data/review.log 2>&1
0 6 * * 1    cd /path/to/repo && npm run booster -- outliers inbox/competitors.csv --fresh --diff data/last-scan.json --save data/last-scan.json && npm run booster -- bank rescore inbox/competitors.csv && npm run booster -- brief --week > channel-booster/data/brief.md
0 21 * * 0   cd /path/to/repo && npm run booster -- rules compile && npm run booster -- retro --since 7d > channel-booster/data/retro.md
```

## As GitHub Actions

`data/` is ignored by git on purpose: it holds real channel numbers. A hosted workflow therefore needs the ledger committed to a private fork or restored from a private artifact before it runs. A minimal job:

```yaml
name: booster-review
on:
  schedule: [{ cron: '0 */6 * * *' }]
  workflow_dispatch:
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci --ignore-scripts
      - run: test -f channel-booster/data/ledger.jsonl && npm run booster -- review run || echo "no ledger, nothing to review"
```

Keep the repository private if you commit `data/`, and never add API keys to the workflow file; use repository secrets.

## Getting numbers in

The review agent reads `inbox/*.csv` (a YouTube Studio Content export: Content > Analytics > Advanced mode > Export) and the Desk's shared database when `channel.json` sets `store: "db"`. Two numbers Studio does not export, 30-second retention and returning-viewer share, are typed once per read: `npm run booster -- set <slug> --bucket 48 --ret30 62 --returning 38`, or in the Desk's Review panel.
