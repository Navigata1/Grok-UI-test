# Packaging sprint

The human ritual behind `booster package build`. Sixty minutes, once per publish, before a single frame is shot (R1, R2). Copy this into the session notes and tick it off in order. An agent prepares steps 1 to 3; a person does the rest.

## Before the room

1. Pick the green idea from the bank: `npm run booster -- bank list --status green`. One idea per sprint.
2. Write the promise in one sentence: who watches, what they get, what changes. It goes into the package and is checked on the title, the script's first 25 words and the description's first line. If you cannot write it, the idea is not ready.
3. Build the package: `npm run booster -- package build "<idea>" --promise "<sentence>" [--offline] [--rounds 3]`. Read `packages/<slug>/package.md`. If any gate reads FAIL, the sheet says which fixes were fed back and what still failed; fix the promise or the inputs and rebuild before you gather anyone.

## In the room (or alone, with a 12-hour gap before step 8)

4. Read the chosen title aloud. Say what it tells. Cover it and look only at the A concept: say what it shows. If both sentences are the same, one of them is wasted; fix it now.
5. Write three titles of your own on the three blank lines of the sheet, by hand, in the channel's voice. Do not look at the generated list while you write. Score them: `npm run booster -- titles score "<title>"`. Keep any that beats the chosen one.
6. Sketch the A and B concepts on paper at phone size (about 6 cm wide). Ask the only question: next to the three strongest competing videos, would you click yours? Open `proof-sheet.html` if it exists and answer again on the light feed and the dark feed.
7. Name the thumbnail moment: the second of the video where the thumbnail happens on screen. Put it on the shot list. It is shot as its own setup, not grabbed from a frame.
8. Pick the final title and the final A/B pair. Solo: do this the next morning, not now; the 12-hour gap is the second reviewer.
9. Run the review: `npm run booster -- package review --title "<final title>" --thumb-text "<A text>"`. The command prints the verdict and records nothing, so write the verdict, your name and the time on the sheet yourself. Pass proceeds to the story spine; revise fixes the one issue in the room and re-checks; fail sends the idea back to step 3 with the promise rewritten. Never "fix it in the edit".

## After the room

10. Register the hypothesis on the sheet: which lever you expect to win (result, stakes, curiosity, contrast, identity) and the CTR multiple you predict against your baseline. The 7-day read will judge it.
11. Fill the thumbnail brief for the designer from the package's designer section: focal subject, expression, elements, text, colour pair, background, composition, signature to keep.
12. Move the idea to packaging in the bank: `npm run booster -- bank status <id> packaging`. Do not start the script until the review in step 9 says pass.

## What the gates refuse

- A title under the title gate score (house default 60). Rewrite; do not test a thumbnail on a weak title.
- Thumbnail text that repeats two-thirds or more of the title's words. The title tells, the thumbnail shows.
- Fewer than two concepts at grade "ship" with different levers. Test & Compare needs two ideas, not one idea twice.
- A promise that does not survive on the title or the thumbnail text. Drift here becomes a hook failure at 30 seconds.
