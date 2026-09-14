---
name: booster-thumbnail-factory
description: Produce thumbnail concepts, a designer brief, and a pre-design QA score for a YouTube video. Use when the user asks for thumbnail ideas, a thumbnail brief, or a review of a thumbnail concept.
---

# Thumbnail factory

The factory produces concepts as structured specs so they can be scored before anyone opens a design tool.

1. Inputs: idea, leading title, the subject (who or what is on screen), the stake, the result. If the user has a channel signature (colour, framing, type), keep it.
2. Run `npm run booster -- thumbnail brief "<idea>" --title "<title>" --subject ".." --stake ".." --result ".."` for the five-lever brief (result, stakes, curiosity gap, contrast, identity).
3. Write four to six concepts as specs: focal subject, emotion, elements (max three), text (max three words, not the title), background, colour pair, composition, and a shoot or build note for the designer.
4. QA each spec: `npm run booster -- thumbnail qa --subject ".." --emotion ".." --elements "a,b,c" --text ".." --background ".." --colors "yellow,black" --title "<title>"`. Ship only grade "ship"; apply the fixes otherwise.
5. Pick A (strongest) and B (most different) for Test & Compare and say why. Include the QA checklist and the test plan from `channel-booster/playbook/thumbnail-brief-template.md`.

6. On the floor, per slug: `npm run booster -- thumbnail proof <slug> --images <dir>` renders the proof sheet (every concept at 120 px beside the top three competitors), `thumbnail render <slug>` writes one image prompt per ship-grade concept, and `thumbnail check <file.png>` verifies a delivered file (1280x720, 16:9, under 2 MB). The channel signature in `channel.json` (`signature set --colors ..`) is applied to every QA unless `--no-signature`.

If the user shares an existing thumbnail image, describe it as a spec first, then QA it the same way.

With an API key: `npm run booster -- ai thumbnail-factory --idea ".." --title ".." --channel ".."`.
