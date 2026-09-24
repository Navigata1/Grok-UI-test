# Channel Booster

The YouTube Channel Booster: a pre-shoot check for YouTube packaging. It scores an idea against proven demand, gates the title and thumbnail before anything is shot, and reads every upload's numbers against the channel's own baseline. Everything about the booster itself is in [`channel-booster/README.md`](channel-booster/README.md).

## Layout

| Path | What it is |
| --- | --- |
| [`channel-booster/`](channel-booster/) | The package: engines, command line, playbook, Desk, tests. An npm workspace. |
| [`.claude/skills/booster*/`](.claude/skills/) | The Claude Code skills that operate it. |
| [`ops/mission/`](ops/mission/) | The mission locks and the evidence each gate wrote. |

## Commands

```bash
npm install                   # the first run writes package-lock.json; commit it so npm ci works
npm run booster -- help       # the command line from source (tsx)
npm run verify                # typecheck, every test, the bundle and the Desk
npm run test:package          # pack the bin, install it in an empty folder, and drive it
npm run test:desk             # drive the built Desk in Chromium (npx playwright install chromium once)
```

From source, keep a channel's files in a workspace: `npm run booster -- init ../my-channel`, then pass `--workspace ../my-channel` (or set `BOOSTER_HOME`). The packaged bin, `channel-booster`, is built by `npm run build` into `channel-booster/dist/`; the package is private until its owner decides to publish it.

## Licence

MIT, see [LICENSE](LICENSE). [NOTICE](NOTICE) records where the booster was built and the third-party material it carries.
