# Title formulas

The title tells; the thumbnail shows. A title has one job: make the promise specific enough that the right viewer cannot scroll past it.

## Rules

1. 30 to 55 characters. The promise must survive truncation at 40 on a phone.
2. One promise. A title that makes two promises makes none.
3. Specific beats clever. A number, a named thing, a concrete result.
4. Front-load the hook: the first three words carry the click.
5. Never repeat the thumbnail text. If the thumbnail says "Day 30", the title does not.
6. No shouting: at most one capitalised word, no exclamation marks, no "video", "vlog", "episode".
7. Write ten before choosing one. The third title is usually the first honest one.

## Levers and formulas

| Lever | Formula | Example |
| --- | --- | --- |
| First-person test | I Tried X for N | I Tried 30 Days of Cold Showers |
| Result reveal | X: N Later | Cold Showers: 30 Days Later |
| Why question | Why X Is Not What You Think | Why Cold Showers Are Not What You Think |
| Nobody tells you | What Nobody Tells You About X | What Nobody Tells You About Cold Showers |
| Mistake frame | The X Mistake Everyone Makes | The Cold Shower Mistake Everyone Makes |
| Ranked list | N X Ranked Worst to Best | 7 Cold Therapies Ranked Worst to Best |
| Stakes | I Did X Until It Worked | I Took Cold Showers Until It Worked |
| Contrast | A vs B: Not Even Close | Ice Bath vs Cold Shower: Not Even Close |
| Identity | X for Y (Start Here) | Cold Showers for Runners (Start Here) |
| Truth bomb | The Truth About X | The Truth About Cold Showers |
| Timebox | X in N | Cold Adaptation in 14 Days |
| How I | How I X (Step by Step) | How I Stopped Dreading Cold Showers |
| Stop doing | Stop X Like This | Stop Taking Cold Showers Like This |
| Proof | X. I Have Proof. | Cold Showers Work. I Have Proof. |

These are shapes, not titles. `booster titles` prints each one with a blank (`I Tried ___ for 30 Days`) and no score: fill the blank in your own words, changing the verb and dropping the article where the sentence needs it, as the examples above do. A topic pasted into a formula ("I Did A $300 solar generator Until It Worked") is a template fill, and `booster titles score` holds it under the title gate. Offline, `booster package build` never picks a title for you; pass yours with `--title`.

## Testing

Ship the highest-scoring title. If CTR is below baseline at 48 hours with healthy impressions, swap to the most different candidate, not a synonym. Log both in the packaging ledger.
