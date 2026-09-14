---
name: booster
description: YouTube Channel Booster router. Use for any YouTube growth task - video ideas, titles, thumbnails, packaging, hooks and retention, publishing workflow, post-mortems, channel audits - or when the user says "booster", "channel booster", "thumbnail factory", "idea engine", "package this video", "why did this video flop".
---

# YouTube Channel Booster

A packaging-first operating system for a YouTube channel. The doctrine (from the strategist playbook in `channel-booster/docs/02-strategist-playbook.md`):

1. Content is judged per upload, so a first upload can win. Nothing is owed to a channel; everything is owed to a package.
2. Packaging (title + thumbnail + first 30 seconds) decides whether a video gets a chance. Make the package before the video.
3. Ideas come from proven demand: outliers in adjacent channels, remixed with an angle. Original ideas off the top of your head are the expensive way to learn this.
4. Clean thumbnails: one subject, three elements, three words, high contrast, phone first.
5. Fewer, better-packaged uploads beat more uploads.
6. Read the funnel in order after publish: impressions, CTR, first 30 seconds, retention. Fix the first broken stage only.

## Route the request

| The user wants | Skill | Deterministic command |
| --- | --- | --- |
| Video ideas, "what should I make", niche research | `/booster-idea-engine` | `npm run booster -- outliers <csv>` then `idea score` |
| Titles | `/booster-title-lab` | `npm run booster -- titles "<topic>"` |
| Thumbnails, thumbnail brief, thumbnail review | `/booster-thumbnail-factory` | `npm run booster -- thumbnail brief|qa` |
| Check a title + thumbnail pair | `/booster-packaging-review` | `npm run booster -- package review` |
| Hook, intro, script structure, retention | `/booster-retention-map` | playbook `first-30-seconds.md` |
| A production plan or calendar | `/booster-workflow` | `npm run booster -- workflow|cadence|calendar` |
| "Why did this video flop", 48-hour numbers | `/booster-postmortem` | `npm run booster -- postmortem` |
| Whole-channel review, "what's working" | `/booster-channel-audit` | `npm run booster -- audit <csv>` |

Every skill: run the deterministic command first when it applies (it is fast and honest), then reason on top of its output using the playbook rules. Never invent numbers; ask for a CSV export or Studio numbers when you need them. Output is a deliverable the user can act on today, not advice.

## Files

- `channel-booster/README.md` - system overview and commands
- `channel-booster/playbook/*.md` - the rules each stage runs on
- `channel-booster/docs/` - the video analysis, the strategist playbook, the architecture
- `channel-booster/examples/*.csv` - the export shape the commands expect (title, views, published, channel, duration)
