# The strategist playbook

The rules the Channel Booster runs on, distilled from the 1of10 Podcast episode with Jake Bryant and from his and the host's public statements, with every rule tagged by evidence. This file is loaded into every Claude-powered engine as its doctrine, so the tags travel into the model's reasoning: an engine must never assert an unverified platform mechanic as fact.

Tags: **[sourced]** a listing, quote, or statement captured in `research/findings.json` and cited in `01-video-analysis.md` · **[unverified]** a widely repeated figure or mechanism the research could not confirm at source (the transcript was not capturable; see the evidence statement in `01-video-analysis.md`) · **[house]** a default this system chose; tune it in `channel.json` and it prints as `[house]` on every verdict.

## The thirteen rules

| Id | Rule | Evidence | Enforced by |
| --- | --- | --- | --- |
| R1 | Views are decided by packaging (title, thumbnail, first seconds) before content quality gets a vote. | [sourced] 1of10 doctrine: "titles and thumbnails are arguably more important than your video because if no one clicks it doesn't matter how good your video is"; the episode's description opener; chapter "Content vs Packaging". | Workflow order: no story stage until a package passes review. |
| R2 | The biggest mistake is ignoring packaging: producing before packaging. | [sourced] 1of10's top mistakes list ("Ignoring packaging"); chapter "The biggest mistake YouTubers make". The phrasing "producing before packaging" is reconstruction. | Same gate as R1; `booster workflow` warns when no review is recorded for the slug. |
| R3 | Ideas come from over-performing videos (outliers: views against the channel median), not from a blank page. | [sourced] 1of10: "Coming up with an 'original idea' off the top of your head is a waste of time... study over performing videos"; Mike Shake: "don't reinvent the wheel, start with good ideas". | Idea scorecard hard gate (demand at 1 or below is red); `suggestDemand()` attaches outlier evidence; the outlier scan feeds the bank. |
| R4 | Packaging amplifies a good idea; it does not rescue a bad one. | [sourced] Mike Shake: "great packaging can amplify good ideas". | Scorecard weights (demand 25%, packaging 25%) and the red gate on either. |
| R5 | Create your own identity: borrow the format, add the angle. | [sourced] Mike Shake: "Create your own identity and leverage it. Don't try to be someone else." | The angle axis stays human-scored; a green idea is approved by a person; the signature registry keeps the channel's own look. |
| R6 | Fewer, better-optimised uploads: improve titles, thumbnails, storytelling and positioning rather than frequency. | [sourced] Trech Media: "growth on YouTube isn't about posting more"; "fewer, better-optimized uploads". | Cadence governor warns above `maxPerWeek`; WIP caps in the bank. |
| R7 | Returning-viewer loyalty is the growth engine. | [sourced] TubeLab profile of Jake Bryant: "increasing loyal viewers who return to watch every upload". | Returning share is a required 7-day input; the sequel decision keys on it. |
| R8 | Clean thumbnails, one consistent format the audience recognises. | [sourced] he originated a format "lots of creators stole"; the long cut has a chapter on whether keeping thumbnails clean is common across his channels. [unverified] what the format looks like: no public spec. | `qaThumbnail` rules (one subject, at most three elements, at most three words, contrast) plus the signature registry, which stores your own spec and says so. |
| R9 | Storytelling from film craft keeps the promise the packaging made. | [sourced] chapter "how his film background helped him tell better stories"; the chapter's content is reconstruction. | Promise contract checked in the title, the first 30 seconds, and the description's first line; the hook score gates the shoot. |
| R10 | Each upload is judged on its own, so a first upload can win. | [sourced] the episode title and the chapter "How to go from 500 views to 100k views on the first video". [unverified] the platform mechanism (video-level signals, a small test audience, expansion on CTR and watch time). | Cold-start mode: absolute priors, stricter data gates, "baseline is borrowed" printed on every verdict. |
| R11 | Read the funnel in order after publish (impressions, CTR, first 30 seconds, retention) and fix only the first broken stage. | [house] doctrine consistent with the analyst rule of thumb the research marks unverified. | `diagnose()` order; the decision engine refuses to prescribe later stages. |
| R12 | Test & Compare decides on watch-time share, not CTR; a CTR winner that loses watch time over-promises. | [unverified] Test & Compare mechanics (up to three variants, winner by watch-time share, Winner / Preferred / None). | `judgeTest()` returns over-promise and routes to the hook; inconclusive tests never count. |
| R13 | Compare CTR against your own history, not a universal number. | [unverified] YouTube Help: half of channels sit between 2% and 10% CTR and it varies by traffic source. | Computed baselines replace typed flags; every verdict prints the baseline it used and its tier. |

## The method, stage by stage

### Ideas

- Start from demand. Export adjacent channels and rank every video by views divided by its channel's median (`booster outliers`). A video at ten times its median is the audience voting with time [sourced concept, house number].
- Weight recency and momentum: a fresh video climbing at three times the channel's typical velocity is a format to catch before it saturates [house].
- Borrow the format, never the video. Your angle is a constraint, a stake, a contrast, a first-person test, or a contrarian claim (R5).
- Score six axes before writing a word: demand, packaging, fit, angle, payoff, feasibility. Demand and packaging carry half the score; either at 1 is red (R3, R4).
- Bank, do not bin. Yellows sit in the bank with their weakest axis named and wake when a fresh outlier lands on their topic; ideas with no new evidence for 180 days decay [house].
- Sequel first. Any video of yours at five times your median creates a demand-5 sequel candidate at the front of the queue [house rule; the demand signal is sourced doctrine].

### Packaging

- The title tells; the thumbnail shows. Together they make one promise the video keeps. Never repeat the thumbnail's words in the title (R1, R9).
- Write ten titles, keep two, then write three of your own by hand. Thirty to fifty-five characters, promise inside the first forty, one promise, a number or a named thing, no shouting [house numbers].
- A thumbnail is a spec before it is an image: one focal subject, at most three elements, at most three words, a specific emotion on any face, high contrast, a clean background, phone first (R8; counts are house).
- Five concepts, five levers: the result, the stakes, the curiosity gap, the contrast, the identity. Ship the strongest and the most different as A and B.
- The promise is written once at package time and checked everywhere it must survive: the title, the first 25 words of the script, the description's first line. Drift blocks the stage.
- Spend as much time planning the package as making the video [sourced, 1of10].

### Story

- The first 30 seconds, word for word: the promise on screen inside five seconds, the stake by fifteen, the roadmap in one line, then start. No intro, no logo, no "in this video".
- A rehook every 60 to 90 seconds: a new question, a reveal, an escalation, a countdown [house].
- The thumbnail moment happens on screen, in the final third, and is teased in the open.
- Shoot the ending first so the open can tease it honestly; shoot the thumbnail photo as its own setup at the emotional peak, never as a frame grab.

### Publishing and testing

- Description line one restates the promise. Chapters follow the payoff ladder. The pinned comment asks the question the sequel answers. Two Shorts from the two strongest payoff moments inside 48 hours.
- Test & Compare with A and B from the start; let watch-time share decide; a CTR winner that loses watch time over-promised, so fix the open, not the image (R12).
- Fewer, better uploads: one packaging sprint per publish. A second weekly upload needs four trailing videos at or above 0.9x baseline CTR, each with a test [house].

### Reading the numbers

- Read the funnel in order: impressions (did the system find an audience?), CTR (did they click?), 30-second retention (did the open keep the promise?), average percentage viewed (did the middle hold?). Fix the first broken stage only (R11).
- Compare against your own history: leave-one-out median and MAD over your last ten videos, with a tier (prior under 5, thin 5 to 9, solid 10 and up) and a shift flag when the median moves by more than one MAD (R13, house numbers).
- Do not judge under 1,000 impressions or inside 24 hours; on a first upload, do not call packaging low or the video healthy under 2,000 impressions or 72 hours [house]. Print the baseline used on every verdict.
- Repackage only when packaging is the bottleneck, impressions are still being served, inside 72 hours, no swap in the last seven days, and the expected gain clears a floor. Thumbnail first, then title. Prepare by agent, apply by human [house].
- Sequel when the 7-day multiple is three or more and returning share holds; expand between 1.5 and 3; park below 0.7 with an idea bottleneck. None of the three until the 7-day median rests on five videos' 7-day reads; before that, hold and show the multiple [house].

### Learning

- Every published package is a pre-registered hypothesis: levers, angle, predicted CTR multiple. Rules compile only from packages registered before publish, so hindsight cannot write the playbook.
- A lever is marked winning so far at three or more tests with a smoothed win rate of 0.6, losing so far at 0.35, and its confidence halves every 90 days without a confirming observation [house]. Either way it is a hypothesis under observation from the channel's own small sample, not doctrine, and it never overrides this playbook; only a person accepts a rule into the playbook, with `booster retro --accept-rule`.
- One sentence of learning per video at seven days; the ledger is the channel's memory; the Sunday retro drafts one candidate rule, and a person decides whether it enters the playbook.

## Numbers used by the engines

| Number | Value | Tag | Where |
| --- | --- | --- | --- |
| Outlier multiple (competitors) | 10x channel median | house (concept sourced) | `outliers` |
| Own winner / sequel trigger | 5x own median | house | `audit`, bank |
| Demand window | 90 days | house | `outliers --since` |
| Title length | 30 to 55 characters, promise in the first 40 | house | `titles`, `package review` |
| Title gate | heuristic score 60 | house | `package` |
| Thumbnail elements / words | 3 / 3 | house (clean doctrine sourced) | `thumbnail qa` |
| Title and thumbnail overlap | under 0.67 | house | `package review` |
| Hook gate | score 70; rehook gap 90 s | house | `hook score` |
| Minimum sample | 1,000 impressions and 24 h; cold start 2,000 and 72 h | house | `postmortem` |
| CTR bands | healthy at 0.9x baseline and 3%; low under 0.75x or 2.5%; between is packaging-soft | house; the 2 to 10% band is unverified | `postmortem` |
| 30-second retention | 60% | unverified | `postmortem` |
| Retention soft | AVP under 0.85x baseline | house | `postmortem` |
| Repackage window | 72 h; one swap per 7 days | house | `decide` |
| Test & Compare | 1,000 impressions per variant and 72 h; over-promise at a 10-point drop | unverified mechanics, house numbers | `test judge` |
| Cold-start priors | CTR 4%, AVP 40%, 30 s 60% | unverified / house | `postmortem` |

The full table with notes lives in `src/thresholds.ts`; `booster thresholds` prints it.

## What to correct after watching the video

`01-video-analysis.md` lists the chapters and what each most likely argues. When you watch it, the four things most likely to change this file are: what the thumbnail format he originated looks like (R8), what the 500-to-100k first video actually changed (R10), how he runs ideation (R3), and which of the case-study channels are named. Update the rule table's evidence column and the playbook files, then rerun the engines: they read this file.
