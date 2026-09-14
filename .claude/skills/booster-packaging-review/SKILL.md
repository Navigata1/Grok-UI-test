---
name: booster-packaging-review
description: Review a YouTube title and thumbnail as a pair - does the title tell, does the thumbnail show, do they make one promise the video can keep. Use when the user asks "is this package good", "review my title and thumbnail", or before production.
---

# Packaging review

1. Run `npm run booster -- package review --title "<title>" --thumb-text "<text on thumbnail>" --elements "a,b,c"`.
2. Apply `channel-booster/playbook/packaging-review.md`: say what the title tells and what the thumbnail shows; cover each and test the other alone; name the promise in one sentence; confirm the promise appears in the first line of the script.
3. Verdict: pass, revise (one issue, fix now), fail (two or more issues, back to the packaging sprint). Give up to three concrete rewrites (title + thumbnail text + why).
4. Ask the user to log the pair and verdict in `channel-booster/playbook/packaging-ledger.md`.

With an API key: `npm run booster -- ai package-review --title ".." --thumb ".."`.
