# Routines: running the system unattended

Three jobs run without a person. Each is one `booster` command; each stops at the human-only gates in `AGENTS.md`.

## Point every job at a workspace

A routine runs against one channel's workspace, the folder `booster init` made. Give it the workspace in one of three ways:

- Run it from inside the workspace folder: `cd /path/to/my-channel && channel-booster review run`.
- Set `BOOSTER_HOME=/path/to/my-channel` in the routine's environment.
- Pass `--workspace /path/to/my-channel` on each command.

From this repository, `npm run booster` starts at the repository root, so use `BOOSTER_HOME` or `--workspace`. With neither, a source checkout falls back to its legacy folders under `channel-booster/`, as it always has, and the packaged bin stops and asks for a workspace. `where` shows which folders a job will use before you schedule it. The routine never creates the workspace: a person runs `init` once.

## The three jobs

The commands below are written for the packaged bin, run inside the workspace. From this repository, the same command is `npm run booster -- <command>` with `BOOSTER_HOME` set.

| When | Command | What it does |
| --- | --- | --- |
| Every 6 hours | `channel-booster review run` | Ingests anything in the workspace's `inbox/`, diagnoses every read that is due (24, 48, 168, 672 h), records a decision, prepares a repackage when one is warranted, writes `data/reviews/<date>.json` and a digest. Nothing happens unless a slug is due. |
| Monday, early | `channel-booster outliers <competitors.csv> --fresh --diff last-scan.json --save && channel-booster bank rescore <competitors.csv> && channel-booster brief --week` | Refreshes the outlier scan, wakes parked ideas whose topic got a fresh outlier, decays stale ones, and writes the Monday brief. A bare `--save` writes `<data>/last-scan.json`, and `--diff last-scan.json` looks for that name in the store, so the job works wherever it is run from. |
| Sunday, late | `channel-booster rules compile && channel-booster retro --since 7d` | Compiles learned rules from the ledger into the workspace's `playbook/00-learned-rules.md` and drafts the retro for the human to accept. |

## As a Claude Code Routine (recommended)

From any Claude Code session that can reach the channel's workspace, create a recurring session with a prompt like:

```
You are the Channel Booster review agent. Read AGENTS.md in the Channel Booster repository (channel-booster/AGENTS.md) first. The channel's workspace is /path/to/my-channel. Run `channel-booster review run --workspace /path/to/my-channel` (in the booster repository: `npm run booster -- review run --workspace /path/to/my-channel`), then the same with `brief --today`. If a decision awaits approval or a repackage is prepared, summarise it in one paragraph and stop; never approve, apply a swap, or write a lever yourself. If inbox/ is empty and nothing is due, say so in one line and stop. If the workspace is missing, say so and stop; never create one.
```

Schedule it every six hours. For the Monday and Sunday jobs, create two more routines with the commands above. The agent needs the workspace and either the installed bin or the repository checked out, and, for `booster ai` engines, an `ANTHROPIC_API_KEY`; it never needs YouTube credentials.

## As cron on your own machine

With the packaged bin, run from inside the workspace. Use the bin's full path if cron's `PATH` does not include it.

```
0 */6 * * *  cd /path/to/my-channel && channel-booster review run >> data/review.log 2>&1
0 6 * * 1    cd /path/to/my-channel && channel-booster outliers inbox/competitors.csv --fresh --diff last-scan.json --save && channel-booster bank rescore inbox/competitors.csv && channel-booster brief --week > data/brief.md
0 21 * * 0   cd /path/to/my-channel && channel-booster rules compile && channel-booster retro --since 7d > data/retro.md
```

From this repository, set `BOOSTER_HOME` and give file paths in full, because `npm run booster` resolves them from the repository root:

```
0 */6 * * *  cd /path/to/repo && BOOSTER_HOME=/path/to/my-channel npm run booster -- review run >> /path/to/my-channel/data/review.log 2>&1
0 6 * * 1    cd /path/to/repo && export BOOSTER_HOME=/path/to/my-channel && npm run booster -- outliers $BOOSTER_HOME/inbox/competitors.csv --fresh --diff last-scan.json --save && npm run booster -- bank rescore $BOOSTER_HOME/inbox/competitors.csv && npm run booster -- brief --week > $BOOSTER_HOME/data/brief.md
0 21 * * 0   cd /path/to/repo && export BOOSTER_HOME=/path/to/my-channel && npm run booster -- rules compile && npm run booster -- retro --since 7d > $BOOSTER_HOME/data/retro.md
```

Leave `BOOSTER_HOME` out and these run against the legacy folders under `channel-booster/`, exactly as before.

## As GitHub Actions

`data/` holds real channel numbers, and the repository ignores `channel-booster/data/` on purpose. A hosted workflow therefore needs the ledger committed to a private repository or restored from a private artifact before it runs, which is why the repository ships no such workflow and leaves the choice to you. A minimal job to write yourself, for the legacy layout:

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

If the private repository holds a workspace instead, set `BOOSTER_HOME` to its folder in the job and test for the ledger at `$BOOSTER_HOME/data/ledger.jsonl`. Keep the repository private if you commit a channel's data, and never add API keys to the workflow file; use repository secrets.

## Getting numbers in

The review agent reads `inbox/*.csv` in the workspace (a YouTube Studio Content export: Content > Analytics > Advanced mode > Export) and the Desk's shared database when `channel.json` sets `store: "db"`. Two numbers Studio does not export, 30-second retention and returning-viewer share, are typed once per read: `channel-booster set <slug> --bucket 48 --ret30 62 --returning 38` (from this repository, `npm run booster -- set ...` with the workspace named), or in the Desk's Review panel.
