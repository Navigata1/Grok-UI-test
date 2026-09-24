---
name: booster-title-lab
description: Write and rank YouTube titles for a video idea using the title formulas and mobile-length rules. Use when the user asks for titles, a better title, or title options.
---

# Title lab

1. Pin the promise in one sentence and the thumbnail concept if it exists (the title must not repeat the thumbnail text).
2. Run `npm run booster -- titles "<noun-phrase topic>" [--number ..] [--subject ..] [--audience ..]` for the formula shapes (each with a blank and no score; they are templates, not titles), then write at least ten of your own using the levers in `channel-booster/playbook/title-formulas.md`: first-person test, result reveal, why question, nobody tells you, mistake frame, ranked list, stakes, contrast, identity, truth bomb, timebox, how I, stop doing, proof.
3. Score each with `npm run booster -- titles score "<title>"` (a formula with the topic pasted in is held under the gate as a template fill; rewrite it) and apply the rules: 30 to 55 characters, promise inside the first 40, one promise, a number or named thing, no shouting, no generic words.
4. Deliver: a ranked list with the lever and score per title, the top three, and one line on what the thumbnail must show so it does not repeat the title. The person picks the final one; it goes into the package with `npm run booster -- package build <slug> --title "<title>" --lever "<its lever>"`, never on the person's behalf (the lever pre-registers what the title tests, so `rules compile` can count it).

With an API key: `npm run booster -- ai title-lab --idea ".." --channel ".."`.
