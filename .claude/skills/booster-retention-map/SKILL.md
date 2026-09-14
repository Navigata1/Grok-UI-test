---
name: booster-retention-map
description: Write the first 30 seconds and a retention map (payoffs, rehooks, cuts, chapters) for a YouTube script or outline. Use when the user asks about hooks, intros, structure, retention, or "how do I open this video".
---

# Retention map

1. Inputs: the title, the thumbnail concept (the moment the thumbnail shows must happen on screen), and the script or outline.
2. Write the first 30 seconds word for word per `channel-booster/playbook/first-30-seconds.md`: promise inside 5 seconds, stake by 15, roadmap in one line, no intro.
3. Build the map: payoff ladder (what the viewer gets and when), a rehook every 60 to 90 seconds with the device named (question, reveal, escalation, contrast, countdown), the cuts (arrivals, goodbyes, setup, anything a viewer can skip), and chapter titles that match the beats.
4. Check: does the first line state the packaging promise? Is the thumbnail moment in the final third and teased in the open? Is the structure ordered (steps, ranks, countdown)?
5. Score it: `npm run booster -- hook score --script <file> --slug <slug>` writes `packages/<slug>/story.json` (hook score, promise in the first 25 words, rehook gaps, intro cruft, chapters, cuts) and exits 1 when the gate fails; `promise check --promise ".." --script <file>` catches drift on any surface.

With an API key: `npm run booster -- ai retention-map --idea ".." --title ".." --script file.txt`.
