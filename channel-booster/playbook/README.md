# Playbook

The operating rules of the Channel Booster, one file per stage. The Claude-powered engines load every file in this folder as their system prompt, so a rule you add here changes what the engines recommend.

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
