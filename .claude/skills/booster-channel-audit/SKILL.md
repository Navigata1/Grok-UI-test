---
name: booster-channel-audit
description: Audit a YouTube channel from an export of its uploads - proven formats, packaging patterns in winners and losers, positioning, and the next five videos. Use when the user asks "what's working on my channel", for a channel review, or before a strategy change.
---

# Channel audit

1. Ask for an export of the channel's uploads (title, views, published, duration). Run `npm run booster -- audit <csv>`.
2. Follow `channel-booster/playbook/channel-audit.md`: winners at 5x median and their formats; the bottom quartile and what their packaging shares; format lift; positioning in one sentence; cadence check (fewer, better-packaged uploads).
3. Deliver: proven formats, the "never again" packaging list, the next five videos as title + thumbnail concept each borrowing a proven format with a new angle, and one rule to add to the playbook.
4. When the channel has a profile and a ledger, `npm run booster -- direction --scan data/last-scan.json` (after `audit <csv> --save`) prints the positioning page from evidence: proven formats from own winners and the scan, each series with its returning-viewer trend, the never-again findings from the bottom quartile, three bets. Use it as the input to the audit, not a replacement for reading the numbers.

With an API key: `npm run booster -- ai channel-audit --csv <csv> --channel ".."`.
