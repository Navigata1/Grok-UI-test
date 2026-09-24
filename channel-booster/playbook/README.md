# Playbook

The operating rules of the Channel Booster, one file per stage. They ship with the booster: the Claude-powered engines load every file in this folder into their system prompt, after `docs/02-strategist-playbook.md`, so a rule you add here changes what the engines recommend.

| Stage | File | Used by |
| --- | --- | --- |
| Idea | [idea-scorecard.md](idea-scorecard.md) | `booster idea score`, `/booster-idea-engine` |
| Title | [title-formulas.md](title-formulas.md) | `booster titles`, `/booster-title-lab` |
| Thumbnail | [thumbnail-brief-template.md](thumbnail-brief-template.md) | `booster thumbnail brief`, `/booster-thumbnail-factory` |
| Package | [packaging-review.md](packaging-review.md) | `booster package review`, `/booster-packaging-review` |
| Story | [first-30-seconds.md](first-30-seconds.md) | `/booster-retention-map` |
| Publish | [publish-checklist.md](publish-checklist.md) | `booster workflow` stage 8 |
| Learn | [post-mortem-template.md](post-mortem-template.md), [packaging-ledger.md](packaging-ledger.md) | `booster postmortem`, `/booster-postmortem` |
| Audit | [channel-audit.md](channel-audit.md) | `booster audit`, `/booster-channel-audit` |

## A channel's own rules

A channel's own rules live in its playbook folder (`playbook/` in the channel's workspace), not in this one. The prompt names a file from that folder `channel playbook/<file>`.

- `00-learned-rules.md` is compiled from the channel's ledger by `booster rules compile`. It loads right after `docs/02`, as hypotheses under observation, never as doctrine, and nobody edits it by hand.
- Rules a person accepted with `booster retro --accept-rule` sit under `## Learned rules` in the channel's own copy of a playbook file. That file loads after the shipped files, and its rules are part of the playbook.

From a source checkout with no workspace, the channel's folder is this one: `00-learned-rules.md` sits here, and accepted rules are appended to the files above.
