---
name: booster-postmortem
description: Diagnose why a YouTube video under- or over-performed from Studio numbers and decide whether to repackage. Use when the user asks "why did this flop", shares CTR / retention / impressions, or wants a 48-hour or 7-day review.
---

# Post-mortem

1. Collect: impressions, CTR, average view duration or percentage viewed, 30-second retention, hours since publish, and the channel baseline (median CTR, AVP, views). Ask for what is missing; do not guess.
2. Run `npm run booster -- postmortem --impressions .. --ctr .. --avp .. --retention30 .. --hours .. --baseline-ctr .. --baseline-avp .. --baseline-views ..`.
3. Read the funnel in order per `channel-booster/playbook/post-mortem-template.md`: idea (impressions), packaging (CTR), hook (30s), retention (AVP). The first broken stage is the bottleneck; do not prescribe fixes for later stages.
4. Deliver: the bottleneck, the evidence, the next 48 hours (repackage only when packaging is the bottleneck and impressions are healthy), one sentence for the playbook, and a sequel idea if the video is healthy. Ask the user to add the row to the packaging ledger.
5. When the video is in the ledger (`publish confirm` or `ledger add`), prefer the recorded path: `npm run booster -- decide --slug <slug> --bucket 48 --record` diagnoses the read against leave-one-out baselines and stores a numbered decision (REPACKAGE, RE-TEST-TITLE, SEQUEL, EXPAND, PARK, HOLD, WAIT; SEQUEL, EXPAND and PARK wait until five other videos have a 7-day read, and on a new channel a read is not called healthy or low before 2,000 impressions or 72 hours of data in the read itself: that read is a HOLD the 7-day read judges, and re-running later on the same numbers changes nothing); `repackage prepare <slug>` writes the swap plan. `review run` does all of it for every read that is due. Approving (`decide approve ... --yes`) and applying (`decide apply ... --yes`) are the person's.

With an API key: `npm run booster -- ai postmortem --title ".." --ctr .. ...`.

Outside this repository, run the same commands as `channel-booster <command>` inside the channel's workspace (see `/booster`).
