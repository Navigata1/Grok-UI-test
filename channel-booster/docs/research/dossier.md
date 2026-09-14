# Research Dossier: "This YouTube Genius Proves Anyone Can Crack The Algorithm With Your First Upload" (1of10 Podcast, Jake Bryant)

Target: https://youtu.be/tuv_XPF6cH8
Compiled: 2026-09-14
Companion file: `findings.json` (the raw findings array from six research angles, pretty-printed)

---

## 1. Evidence statement (read this first)

**What could not be captured.** The video's transcript and frames were NOT capturable. The session's egress proxy blocks YouTube and every mirror/transcript service that was tried, so no line of dialogue and no frame of the video has been seen. Everything about the episode's content below is reconstructed from (a) search-index snippets of the episode's platform listings and descriptions (YouTube, Apple Podcasts, Spotify, the Anchor and Riverside RSS feeds) and (b) public statements by the guest and host on X, LinkedIn, Instagram, company sites and third-party directories.

**Search budget exhaustion.** The session's WebSearch budget (200 calls) was fully consumed during the first two research angles (Episode Forensics and Jake Bryant's Frameworks). The remaining four angles (1of10's Method, 2026 Algorithm and Cold Start, Thumbnail Factory Practice, and Ideation/Packaging/Operating Systems) executed **zero** searches and were written entirely from model knowledge (cutoff June 2026). Those findings carry `status: "unverified"`, an empty `evidence_quote`, and a `source_url` that is the primary source that *should* be checked, not a page that was fetched. WebSearch itself returns LLM-condensed snippets, so even "sourced" quotes are verbatim copies of a condensed search result, not of the underlying page.

**Corpus composition (exact counts from `findings.json`).**

| Angle | Sourced | Unverified | Total |
|---|---|---|---|
| Episode forensics | 31 | 1 | 32 |
| Jake Bryant's frameworks | 43 | 1 | 44 |
| 1of10's method | 0 | 49 | 49 |
| 2026 algorithm and cold start | 1* | 21 | 22 |
| Thumbnail factory practice | 0 | 56 | 56 |
| Ideation, packaging, operating systems | 0 | 93 | 93 |
| **Total** | **75** | **221** | **296** |

\* The single "sourced" item in the algorithm angle is a restatement of prior context (the "500 views to 100k views on the first video" chapter), not an independent search hit; it is treated as sourced only because the underlying chapter title is independently sourced in the Episode Forensics angle.

**Which claims rest on which source type.**

| Claim family | Source type | Reliability |
|---|---|---|
| Video title, upload recency (~Sept 9), description opener, description names Jake and links his X | Search-index snippet of the YouTube watch page | Sourced; snippet-level |
| Audio episode title, date (July 29), duration (17 min), chapter lists, topic lists, show-note links | Search-index snippets of Apple Podcasts, Spotify, Anchor RSS, Riverside RSS | Sourced; two description variants conflict on timestamps (see section 9) |
| Jake Bryant's numbers, bio, business, social posts | Snippets of X, Instagram, LinkedIn, YT Jobs, Trech Media, TubeLab, IMDb, fandom wiki | Sourced; identity linkage across LinkedIn/IMDb profiles is circumstantial |
| Host identity and 1of10 company facts | Snippets of VidSummit, 1of10.com/richardyts, Podstatus, Rephonic | Sourced |
| Anything Jake actually *said* in the episode (his arguments, his thumbnail format, the 500-to-100k mechanism, the 23M-view case) | **Nothing** — not captured | Reconstruction only, labeled as such |
| 1of10 outlier method, tool features, thresholds | Model knowledge | Unverified |
| YouTube recommendation mechanics, CTR/AVD benchmarks, Test & Compare rules, 2025-26 platform changes | Model knowledge | Unverified |
| Thumbnail factory rules, pricing, tooling, SOPs | Model knowledge | Unverified |
| Creator operating-system rules (MrBeast doc, Paddy Galloway, Nate Black, etc.) | Model knowledge | Unverified |

**Reading convention.** Every sourced claim is followed by an inline markdown link to its `source_url`. Every claim from the unverified angles is marked **[unverified]** and grouped under an "Unverified" subheading inside each section so it can never be mistaken for a sourced fact. Unverified claims are never upgraded, even where they are plausible and consistent with the sourced material.

---

## 2. The episode

### 2.1 Identity (sourced)

- **Target video.** `watch?v=tuv_XPF6cH8` is titled *"This YouTube Genius Proves Anyone Can Crack The Algorithm With Your First Upload"*. It was uploaded ~5 days before 2026-09-14 (i.e. ~Sept 9, 2026). The snippet parses it as being "by a creator named Jake" (Jacob R. Bryant), and the description provides his Twitter/X handle. [YouTube watch page](https://www.youtube.com/watch?v=tuv_XPF6cH8)
- **Description opener.** The description begins: *"What if the reason your videos get no views has nothing to do with how good they are?"* [YouTube watch page](https://www.youtube.com/watch?v=tuv_XPF6cH8)
- **Audio episode (earlier release).** The 1of10 Podcast published an audio episode titled *"19 Minutes Inside The Mind of A Top 1% YouTube Strategist"* (Spotify slug `19-Minutes-Inside-The-Mind-of-A-Top-1-YouTube-Strategist`) on Wednesday, July 29, 2026; Apple Podcasts lists it as 17 minutes long. [Apple Podcasts](https://podcasts.apple.com/in/podcast/1of10-podcast/id1870599992), [Spotify](https://open.spotify.com/show/4z9KeRGFT8DeT1zKDGJrOJ)
- **Guest's announcement.** Jake Bryant posted on X on July 28, 2026: *"Shout out to @1of10media for having me on the pod!"* with a link to the episode. [X post 2082174136319668553](https://x.com/JacobRBryant1/status/2082174136319668553)
- **Show and host.** The 1of10 Podcast is hosted by Richard (@Richard_YTS), founder of 1of10, "an AI-powered YouTube tool used by more than 10,000 channels"; he "interviews prominent figures in the creator space". [VidSummit speaker page](https://www.vidsummit.com/speakers-2025/richard-the-youtube-strategist). Before 1of10, Richard "worked as a content strategist for MrBeast and ran an agency serving 100+ YouTubers (still operating today as 1of10's strategy division)"; 1of10 "was co-founded in 2023 with Riad, an ex-Microsoft AI engineer". [1of10.com/richardyts](https://1of10.com/richardyts)
- **Show positioning.** "The 1of10 Podcast is a podcast by 1of10 Media in the Marketing and Business categories with 93 episodes. It interviews some of the top people in the YouTube industry and learns their strategies to achieving success." [Podstatus](https://podstatus.com/podcasts/1of10-podcast-1252892). The Anchor RSS describes it as "a marketing podcast where they interview some of the top people in the YouTube industry". [Anchor RSS](https://anchor.fm/s/110bc6964/podcast/rss). Rephonic says the show "launched 4 months ago and published 83 episodes to date" and "shares a similar audience with ... The Think Media Podcast, The Colin and Samir Show, The Game with Alex Hormozi, and My First Million". [Rephonic](https://rephonic.com/podcasts/1of10-podcast)
- **Distribution endpoints.** Apple Podcasts id1870599992; Spotify show 4z9KeRGFT8DeT1zKDGJrOJ; Anchor RSS anchor.fm/s/110bc6964/podcast/rss; Riverside RSS api.riverside.fm/hosting/DmOclTBN.rss (the show is hosted on Riverside.fm); Castbox channel 7144994; Podcast Addict 6895364; Podstatus 1252892; Podwise podcast 15050; YouTube channel UCFmWPX3f0zi0g--uYziLNxA (@1of10pod). [Riverside RSS](https://api.riverside.fm/hosting/DmOclTBN.rss)
- **Show notes.** The episode notes include: "You can try 1of10 for $1 at https://1of10.com/affiliate/podcast/ ... Jacob Bryant (X: https://x.com/JacobRBryant1)"; the podcast promotes the 1of10 newsletter at 1of10.com/newsletter and a "Book a call with us" option at 1of10.com/strategy. [Anchor RSS](https://anchor.fm/s/110bc6964/podcast/rss)
- **Transcript status.** 1of10's blog says it is "a resource where you can find full transcripts from each episode of their podcast", but no Jake Bryant transcript or article surfaced in any search. [1of10 Podcast Articles](https://1of10.com/blog/podcast-articles/)
- **Do not conflate.** A 1of10 blog post from the same period, *"How To Get Millions Of Views In Any Niche (From An Expert)"* (May 5, 2026), is about Ollie, 1of10's Head of Strategy ("helped grow Kallaway from 0 to 300,000 subscribers in just over a year and has worked with top creators like Will Tennyson"), not Jake. [1of10 blog](https://1of10.com/blog/how-to-get-millions-of-views-in-any-niche-from-an-expert/)

### 2.2 Chapters and timestamps (sourced; two variants)

**Variant A — Apple Podcasts chapter markers (July 29 audio episode).** [Apple Podcasts](https://podcasts.apple.com/in/podcast/1of10-podcast/id1870599992)

| Time | Chapter |
|---|---|
| 00:00 | Meet the top 0.1% strategists |
| 00:29 | Content vs Packaging |
| 01:55 | The biggest mistake YouTubers make |
| 04:09 | 0 to 400,000 subscribers in 2 years |
| 05:19 | Working with Mike Shake |
| 06:59 | What works on YouTube in 2026 |
| 11:55 | Thumbnail breakdown |
| 14:19 | Revealing my exact ideation process |

A second parse of the same Apple listing returned the same chapter names shifted by one slot ("Content vs Packaging" (01:55), "The biggest mistake YouTubers make" (04:09), "0 to 400,000 subscribers in 2 years" (05:19), "What works on YouTube in 2026" (06:59)). [Apple Podcasts](https://podcasts.apple.com/in/podcast/1of10-podcast/id1870599992). See section 9 for resolution.

**Variant B — RSS/Spotify/Podcast Addict description (question-style topics).** [Anchor RSS](https://anchor.fm/s/110bc6964/podcast/rss), [Spotify](https://open.spotify.com/show/4z9KeRGFT8DeT1zKDGJrOJ)

- 0:00 — Meet Jacob Bryant
- Who are the biggest creators he's worked with in LA?
- The secret to 100M monthly views
- How to blow up on YouTube in 2026
- Common mistakes YouTubers make
- How he started a thumbnail trend
- How his film background helped him tell better stories on YouTube
- How to go from 500 views to 100k views on the first video
- How packaging got him 23M views on an entertainment channel ("his packaging strategy has contributed to channels achieving high view counts, including 23M views on an entertainment channel")
- 23:39 — Is keeping thumbnails clean a common strategy across all the channels he work with?

The 23:39 timestamp is beyond the 17-19 minute audio cut, "implying the Sept 9 YouTube video is a longer edit with this chapter". [Anchor RSS](https://anchor.fm/s/110bc6964/podcast/rss)

### 2.3 Every recovered claim and quote about the episode (sourced)

- The episode "explores the idea that 'the reason your videos get no views has nothing to do with how good they are.'" [YouTube watch page](https://www.youtube.com/watch?v=tuv_XPF6cH8)
- The Apple description "frames him as a 'top 0.1%' strategist" and lists "revealing an exact ideation process". [Apple Podcasts](https://podcasts.apple.com/in/podcast/1of10-podcast/id1870599992)
- A chapter is literally titled "How to go from 500 views to 100k views on the first video". [Apple Podcasts](https://podcasts.apple.com/in/podcast/1of10-podcast/id1870599992)
- "The episode also covers how packaging helped Jacob get 23M views on an entertainment channel." [Apple Podcasts](https://podcasts.apple.com/in/podcast/1of10-podcast/id1870599992)
- Reaction: a commenter on Jake's X post "mentioned wishing the episode was longer and wanted more coverage of packaging with titles and thumbnails". One search parse attributed the wish to Jake himself ("Jake mentioned wishing the episode was longer"); the other to a commenter. [X post](https://x.com/JacobRBryant1/status/2082174136319668553). Either way, the reaction signals packaging (titles + thumbnails) is the material the audience wanted more of.
- No X post from @1of10media promoting the Jake Bryant episode or the Sept 9 video was found. No other podcast appearance by Jake was indexed: "The search results reference his appearance on the 1of10 podcast" only, with unrelated Jake Bryants (McKinsey, musician) otherwise. [X post](https://x.com/JacobRBryant1/status/2082174136319668553)

### 2.4 Relationship between the Sept 9 video and the July 29 audio (unverified)

- **[unverified]** The Sept 9 video appears to be the full/extended video edition of the July 29 17-minute audio interview (same guest, same show, "first upload" framing matches the "500 views to 100k views on the first video" chapter), but no source explicitly links the two. Supporting evidence is the 23:39 chapter in the RSS description (sourced above), which cannot fit in a 17-minute cut.
- **[unverified]** The 1of10 Podcast uses recurring title templates such as "This YouTube Genius ..." and "[N] Minutes Inside The Mind of ..."; an episode described as "YouTube genius who helped creators make 100M" most likely means 100M *views* and may be this same Bryant conversation (whose description promises "the secret to 100M monthly views").

### 2.5 Best-effort reconstruction of the argument spine — RECONSTRUCTION, NOT TRANSCRIPT

The following is inferred from the chapter titles, the description opener, the guest's public statements and the host company's published doctrine. No sentence below is a quote from the video.

1. **Thesis (from the description opener and "Content vs Packaging" at 00:29).** Views are gated by packaging (idea + title + thumbnail), not by production quality. Consistent with the host's own doctrine: "Titles and thumbnails are arguably more important than your video because if no one clicks it doesn't matter how good your video is." [1of10 TikTok](https://www.tiktok.com/@1of10media/video/7463482203373079841)
2. **The biggest mistake (01:55).** Most plausibly: making the video before designing its packaging, or over-investing in content and under-investing in packaging. Trech's public method says the same in different words: growth "isn't about posting more, it's about uploading smarter, optimized content". [Trech Media](https://www.trechmedia.com/). The 1of10 doctrine adds "Ignoring packaging" and "Bad ideas ... study over performing videos" as top mistakes. [1of10 TikTok](https://www.tiktok.com/@1of10media/video/7463482203373079841)
3. **Proof cases (04:09, 05:19, plus RSS topics).** A channel taken from 0 to 400,000 subscribers in 2 years; work with Mike Shake (~4.93M subscribers, thumbnail-focused, "great packaging can amplify good ideas" [Mike Shake on X](https://x.com/MikeshakeYT?lang=en)); a channel at 100M monthly views; an entertainment channel where packaging produced 23M views; the "biggest creators he's worked with in LA" (background suggests the Hi5 Studios network and possibly Hudson Matter / Mark Manson — see section 3). Which channel is which is unresolved.
4. **What works in 2026 (06:59).** Unknown in detail. Public positioning suggests: fewer, better-packaged uploads; returning-viewer loyalty ("increasing loyal viewers who return to watch every upload through strategies like thumbnail optimization and targeted content planning" [TubeLab](https://tubelab.net/youtube-strategy)).
5. **Thumbnail breakdown (11:55) and the thumbnail trend he started.** He claims a "completely new format" that "lots of creators stole" and offered to "break it down exactly how we built" it. [X profile](https://x.com/jacobrbryant1). The visual spec was not captured anywhere.
6. **Film background and storytelling.** Ties to 9+ years of filming/editing and an IMDb short-film record (identity not confirmed).
7. **Ideation process (14:19).** Unknown in detail; the host frame is outlier-driven ("study over performing videos"). [1of10 TikTok](https://www.tiktok.com/@1of10media/video/7463482203373079841)
8. **First upload: 500 to 100k views.** The claimed case behind the video's title. Mechanism not captured; the description frames it as a packaging outcome.
9. **Clean thumbnails (23:39, video cut only).** Whether keeping thumbnails clean is a common strategy across all his channels. Answer not captured.

Confidence in this spine: **low-to-medium**. The ordering and topic list are sourced; every mechanism and every number's attribution is not.

---

## 3. Jake Bryant

### 3.1 Bio and identity (sourced)

- X: "Jake Bryant - YouTube Strategist" (@JacobRBryant1); "a YT Strategist with over 2.5 billion long-form views, 40+ channels, and 2,000 uploads"; based in Austin, Texas; joined X July 2018. An earlier bio version read "over 1.5 billion long-form views, 35+ channels, and 1,500 uploads". [X profile](https://x.com/jacobrbryant1), [twitter.com/JacobRBryant1](https://twitter.com/JacobRBryant1)
- Instagram @jacob_r_bryant_: "Husband, father, yt strategist, and avid reader"; ~1,050 followers (a small personal account, not a content channel). [Instagram](https://www.instagram.com/jacob_r_bryant_/)
- YT Jobs profile (talent/profile/5451): "a total of 177.52M views and 2.83M likes summarizes Jake Bryant's creativity on YouTube so far"; a timeline page exists at /talent/timeline/5451. [YT Jobs](https://ytjobs.co/talent/profile/5451)
- On Aug 5, 2026 he posted: "I'm now in the top 5 YouTube Strategists on @yt_jobs Crazy! Feel free to ask me anything." [X post 2084959034445066316](https://x.com/JacobRBryant1/status/2084959034445066316). An AMA question he received (his reply not captured): "What's your take on the next 5 years for strategists with AI advancing faster than ever? Do you consider cases where AI completely takes over the role someday?" [same post](https://x.com/JacobRBryant1/status/2084959034445066316)
- He has recruited on X: "Looking to hire a podcast assembly editor. Commit your best work!" — indicating he runs podcast production work. [X post 2040062072730300453](https://x.com/JacobRBryant1/status/2040062072730300453)
- TubeLab profile: "has helped generate over a billion long-form views for creators and brands and has worked with 25+ top tier creators ... His approach emphasizes increasing loyal viewers who return to watch every upload through strategies like thumbnail optimization and targeted content planning." [TubeLab](https://tubelab.net/youtube-strategy)
- Whether he appears in Humble&Brag's "13 Best YouTube Strategists in the World in 2026" (which names Mario Joos and Tim Schmoyer) or Vidpros' list could not be confirmed. [Humble&Brag](https://humbleandbrag.com/blog/best-youtube-strageists)

### 3.2 Career background (sourced; identity linkage partly circumstantial)

- **Hi5 Studios (LA).** A LinkedIn profile: "Jake Bryant is a Video Editor at Hi5 Studios and is located in the Los Angeles Metropolitan Area"; a Hi5 employee directory lists Jacob "Jake" Bryant as Editor. Hi5 Studios is Matthias's LA network (Dope or Nope, Battle Universe, Get Good Gaming, Team Edge, REKT) — consistent with the "biggest creators he's worked with in LA" chapter. The same snippet says "He started working at Hi5 Studios full-time in May 2025, according to his social media" (conflicts with the caption below; treat the date as unreliable). [LinkedIn jake-bryant-961704190](https://www.linkedin.com/in/jake-bryant-961704190/)
- **Get Good Gaming editor; left after ~3 years.** "Get Good Gaming's editor Jake Bryant posted publicly on his Instagram about no longer working with Hi5. The picture was of the Hi5 sign in Blue Base and the caption read: 'Feels just like yesterday I was brought on to work full time. The past 3 years have been great, but I just walked out of my last day at hi5.'" [Spellbound Wiki](https://spellbound.fandom.com/wiki/Get_Good_Gaming)
- **Hudson Matter Channel / MarkManson.net.** A second LinkedIn profile, headlined "Jake Bryant - MarkManson.net" and listing "Creative Director - Hudson Matter Channel": "He has filmed and edited videos for over 9 years and is a creative director based in the Los Angeles Metropolitan Area. Working with 25+ channels, Jake has provided strategic analysis for viewer retention, crafted engaging hooks, and offered data-driven feedback, with expertise in content, storytelling and analytics. His services include thumbnail optimization to targeted content planning." Hudson is described there as "a YouTube specialist with 2-million + subscribers and over 250-million views". Identity match with @JacobRBryant1 is strongly implied (LA, YouTube, escalating channel counts 25+ / 35+ / 40+, thumbnail optimization) but not explicitly confirmed. [LinkedIn jake-bryant-ba889b15a](https://www.linkedin.com/in/jake-bryant-ba889b15a/)
- **Hudson Matter context.** "Hudson is a YouTube specialist with 2-million + subscribers and over 250-million views who has worked with some of the biggest creators on the platform ... He runs a consulting company, NextWave Media". [VidSummit](https://www.vidsummit.com/speakers-2025/hudson-matter). Channel stats: "over 2 million subscribers and more than 215 million total views ... lifestyle and entertainment content ... with an average of 23 minutes per video". [thoughtleaders.io](https://app.thoughtleaders.io/youtube/hudson-matter). No Hudson Matter video with 23M views was found; his best-known video, "Brother vs Sister Strength Challenge" with his sister Salish, "has received more than 7 million views" — so the 23M-view case may be a different channel. [celebicity](https://www.celebicity.com/hudson-matter/)
- **Mark Manson context.** "Mark Manson's entrepreneur-first approach has enabled him to speed-run his YouTube success, gaining 2,600,000 subscribers in just two years." [Creator Science](https://podcast.creatorscience.com/mark-manson/). "Mark Manson's team has worked on translating his writing to video content, with ongoing discussions between Mark and the team ... and editors helping determine what b-roll and visual elements would work best" — consistent with a creative-director role. [The Publish Press](https://news.thepublishpress.com/p/mark-manson-evolution-author-youtube-creator)
- **Film background.** An IMDb entry: "Jake Bryant (nm8022607) is an editor known for Note to Self (2016), Them or Us (2016) and Prologue (2014) ... works as an editor, director, and writer". Plausible match for the "film background" chapter; identity not confirmed. [IMDb](https://www.imdb.com/name/nm8022607/)
- **Mike Shake.** No public source ties Jake to Mike Shake outside the chapter title: "I did not find specific information about 'Mike Shake' in connection with Jake Bryant or Trech". [X profile](https://x.com/jacobrbryant1). Context on Mike Shake: "currently has 4,930,556 YouTube subscribers ... focused on making thumbnails and has engaged in hiring thumbnail designers ... emphasizing not reinventing the wheel and starting with good ideas, noting that great packaging can amplify good ideas" [Mike Shake on X / HypeAuditor](https://x.com/MikeshakeYT?lang=en); "had an engineering job prior to making the decision to do YouTube full time. His most popular video 'I learned to throw a toothpick' has been viewed more than 27 million times" [Famous Birthdays](https://www.famousbirthdays.com/people/mike-shake.html); an older post (at 2.2M subscribers) advises "Create your own identity and leverage it. Don't try to be someone else or do stuff you don't like just because it's working." [Mike Shake on X](https://x.com/MikeshakeYT?lang=en)

### 3.3 Trech Media (sourced)

- "Trech is a YouTube growth consultancy led by Jake Bryant, our founder and lead strategist, built for creators and entrepreneurs that want more than just views. With over a decade of experience and more than a billion long-form views across the channels they've helped grow, they specialize in transforming YouTube into a high-leverage engine for visibility, authority, and conversions." [Trech Media](https://www.trechmedia.com/)
- Method: "They help creators by improving titles, thumbnails, storytelling and content positioning, rather than simply increasing upload frequency. ... Many clients see higher performance with fewer, better-optimized uploads. Their approach emphasizes that growth on YouTube isn't about posting more, it's about uploading smarter, optimized content." [Trech Media](https://www.trechmedia.com/)
- Results promise: "Most clients start seeing measurable improvements in views, engagement, and conversions in less than 3 months. Every channel is different, but their process is built to deliver early wins while setting up sustainable, long-term growth." [Trech Media](https://www.trechmedia.com/)
- Audience: "Whether you're a seasoned creator, a business owner entering YouTube for the first time, or somewhere in between — they tailor their strategy to fit your goals. ... With their proven methods, they cut the learning curve in half, not just for channel growth, but sustainability." [Trech Media](https://www.trechmedia.com/)
- Entry offer: "a free 30-minute discovery call to provide actionable insights tailored to your channel or business goals." No public pricing tiers were found. [Trech Media](https://www.trechmedia.com/)
- Booking: Calendly, reported as `calendly.com/trechconsultat` in one parse and `calendly.com/trechconsultation` in another (see section 9). [X profile](https://x.com/jacobrbryant1)
- Testimonial (attribution inferred, likely trechmedia.com): "Jake Bryant is the best of the best with his unique results driven strategy, tailored to your own goals." [Trech Media](https://www.trechmedia.com/)
- A Trech Media YouTube channel exists (UCavRTMYoA62Lr6NDKNj7bjA) but no indexed video content was found. [Trech YouTube channel](https://www.youtube.com/channel/UCavRTMYoA62Lr6NDKNj7bjA)
- Industry pricing context (not Jake-specific): CNBC reports "Top advisors charge $15,000+ monthly, using data to refine titles, thumbnails, and retention. Creators like Jesser grew from 3M to 41M subscribers with this help." [CNBC](https://www.cnbc.com/2026/05/10/youtube-advisors-mrbeast-top-creators-platform-viewership.html)

### 3.4 The thumbnail format (sourced)

- "Lots of creators stole my thumbnail format...and I love it! If creators copy it and it works its because we did something right!" He indicated he would "break it down exactly how we built a completely new format." [X profile](https://x.com/jacobrbryant1), [X profile (lang=en)](https://x.com/JacobRBryant1?lang=en)
- The episode explicitly includes "how he started a thumbnail trend" and a "Thumbnail breakdown" chapter (11:55). [Apple Podcasts](https://podcasts.apple.com/in/podcast/1of10-podcast/id1870599992)
- What the format looks like was NOT captured: "the specific technical details about the exact dimensions or specifications of his thumbnail format are not detailed in these search results." [X profile](https://x.com/jacobrbryant1)
- The date of the "stole my thumbnail format" post is unclear (one parse claimed "July 29, 2018", likely a misparse) and the post URL was not surfaced.

**[unverified]** Hypothesis only: the format he originated may be the clean, large-text style associated with Mark Manson's YouTube channel (where LinkedIn lists him as creative director). No source confirms this.

### 3.5 Content-vs-packaging thesis (sourced framing; content unverified)

- Sourced framing: chapter "Content vs Packaging" at 00:29; description opener "What if the reason your videos get no views has nothing to do with how good they are?"; Trech's "uploading smarter" over "posting more". [Apple Podcasts](https://podcasts.apple.com/in/podcast/1of10-podcast/id1870599992), [YouTube](https://www.youtube.com/watch?v=tuv_XPF6cH8), [Trech Media](https://www.trechmedia.com/)
- **[unverified]** His argument likely mirrors the industry hierarchy Idea > Packaging > Content and the YouTube Analytics funnel (impressions -> CTR -> views -> AVD -> watch time) in which packaging is the first gate.

### 3.6 The biggest mistake (chapter sourced; content unverified)

- Sourced: chapter "The biggest mistake YouTubers make" (01:55); RSS topic "Common mistakes YouTubers make". [Apple Podcasts](https://podcasts.apple.com/in/podcast/1of10-podcast/id1870599992)
- Host's published doctrine (sourced, not Jake's words): "3. Ignoring packaging. Titles and thumbnails are arguably more important than your video ... Spend as much time planning these as you do your video. 4. Bad ideas. Coming up with an 'original idea' off the top of your head is a waste of time unless you're an expert at YouTube. Instead study over performing videos to get a real idea of what people are watching." [1of10 TikTok](https://www.tiktok.com/@1of10media/video/7463482203373079841)
- **[unverified]** Jake's stated biggest mistake is probably content-first production (making the video, then packaging it) or over-investing in production quality relative to packaging.

### 3.7 Ideation process (chapter sourced; content unverified)

- Sourced: chapter "Revealing my exact ideation process" (14:19). [Apple Podcasts](https://podcasts.apple.com/in/podcast/1of10-podcast/id1870599992)
- **[unverified]** Given the host's tool and doctrine, the process likely involves outlier research (videos that beat their channel's median several times over) and packaging-first idea selection. His actual rubric and thresholds are unknown.

### 3.8 First-upload / cold-start strategy (chapter sourced; mechanism unverified)

- Sourced: chapter "How to go from 500 views to 100k views on the first video"; the Sept 9 title "Anyone Can Crack The Algorithm With Your First Upload". [Apple Podcasts](https://podcasts.apple.com/in/podcast/1of10-podcast/id1870599992), [YouTube](https://www.youtube.com/watch?v=tuv_XPF6cH8)
- **[unverified]** Likely playbook: choose a topic with demonstrated demand (an outlier format on small channels), copy the proven structure with one twist, package to the highest standard (custom thumbnail photo, tested title), open cold with the payoff or stakes, skip "welcome to my channel" intros. Common first-upload mistakes: no custom thumbnail, generic title, a 30-second intro, no proven demand, judging by subscribers instead of CTR/AVD. Which channel produced the 500 -> 100k jump and its CTR/AVD numbers are unknown.

### 3.9 Storytelling and film background (chapter sourced; content unverified)

- Sourced: RSS topic "How his film background helped him tell better stories on YouTube"; LinkedIn "filmed and edited videos for over 9 years ... expertise in content, storytelling and analytics"; Trech lists "storytelling" as a lever; IMDb short-film credits (identity unconfirmed). [Anchor RSS](https://anchor.fm/s/110bc6964/podcast/rss), [LinkedIn](https://www.linkedin.com/in/jake-bryant-ba889b15a/), [Trech Media](https://www.trechmedia.com/), [IMDb](https://www.imdb.com/name/nm8022607/)
- **[unverified]** Content of the storytelling advice was not captured.

### 3.10 Clean thumbnails (chapter sourced; answer unverified)

- Sourced: chapter "Is keeping thumbnails clean a common strategy across all the channels he work with?" at 23:39. [Anchor RSS](https://anchor.fm/s/110bc6964/podcast/rss)
- **[unverified]** His answer was not captured. Industry context on the clean/minimal trend is in section 6 (unverified).

### 3.11 100M monthly views logic (topic sourced; logic unverified)

- Sourced: RSS topic "The secret to 100M monthly views". [Anchor RSS](https://anchor.fm/s/110bc6964/podcast/rss). Which channel this refers to is unknown; candidates from his background (Hi5 network, Hudson Matter, Mark Manson) are unconfirmed.
- **[unverified]** The "secret" was not captured.

### 3.12 Numbers attributed to Jake (sourced; see section 8 for the full table)

2.5B+ long-form views / 40+ channels / 2,000 uploads (X bio, current); 1.5B / 35+ / 1,500 (earlier X bio); 1B+ views / 10+ years (Trech); 1B+ views / 25+ top-tier creators (TubeLab); 25+ channels / 9+ years (LinkedIn); 177.52M views / 2.83M likes (YT Jobs portfolio); top 5 strategist on YT Jobs (Aug 5, 2026); 0 to 400,000 subscribers in 2 years (episode); 23M views on an entertainment channel (episode); 100M monthly views (episode); 500 to 100k views on a first video (episode); clients see improvement in under 3 months (Trech).

---

## 4. 1of10's method

### 4.1 Sourced facts about 1of10

- Founder/host Richard (@Richard_YTS); tool "used by more than 10,000 channels". [VidSummit](https://www.vidsummit.com/speakers-2025/richard-the-youtube-strategist)
- Richard "worked as a content strategist for MrBeast and ran an agency serving 100+ YouTubers (still operating today as 1of10's strategy division)"; co-founded 2023 with Riad, ex-Microsoft AI engineer. [1of10.com/richardyts](https://1of10.com/richardyts)
- Published doctrine (TikTok "Avoid these mistakes at all costs"): "3. Ignoring packaging. Titles and thumbnails are arguably more important than your video because if no one clicks it doesn't matter how good your video is. Spend as much time planning these as you do your video. 4. Bad ideas. Coming up with an 'original idea' off the top of your head is a waste of time unless you're an expert at YouTube. Instead study over performing videos to get a real idea of what people are watching." [1of10 TikTok](https://www.tiktok.com/@1of10media/video/7463482203373079841)
- The podcast offers a $1 trial (1of10.com/affiliate/podcast/), a newsletter (1of10.com/newsletter) and strategy calls (1of10.com/strategy). [Anchor RSS](https://anchor.fm/s/110bc6964/podcast/rss)
- The host company "sells an outlier/packaging research tool — context for why the episode leans on packaging and ideation". [Anchor RSS](https://anchor.fm/s/110bc6964/podcast/rss)
- 1of10's Head of Strategy Ollie "helped grow Kallaway from 0 to 300,000 subscribers in just over a year and has worked with top creators like Will Tennyson". [1of10 blog](https://1of10.com/blog/how-to-get-millions-of-views-in-any-niche-from-an-expert/)

### 4.2 Outlier definition — [unverified]

- **[unverified]** 1of10.com is a YouTube research SaaS built around "outliers": videos that earned many times more views than their channel normally gets; its core search takes a keyword/topic and returns videos ranked by an outlier multiplier rather than raw views.
- **[unverified]** The outlier score is a multiplier: a video's views divided by the channel's typical (median) views across recent long-form uploads (e.g. "8.3x"); median rather than mean so past hits do not inflate the baseline.
- **[unverified]** Working thresholds: ~2x noticeably above normal; 5x strong outlier; 10x+ true breakout; 3-5x "worth watching"; sub-2x noise. The UI allows a minimum-multiplier filter (3x, 5x, 10x, 20x+).
- **[unverified]** Name origin: roughly one upload in ten breaks out; the implied ideation ratio is ~10 candidate ideas per published video.
- **[unverified]** Baseline caveats: channels with few uploads, mostly-Shorts channels, or a near-zero median produce inflated multipliers; add a minimum-views floor (10k-50k) and exclude Shorts.
- **[unverified]** Exact formula details (median vs mean, baseline window of last 10/20/50 videos, Shorts exclusion, capping) are unknown.

### 4.3 Idea generation — [unverified]

- **[unverified]** Step-by-step: (1) search your topic plus adjacent topics; (2) filter to 5x+ outliers from the last 6-12 months; (3) look for the same idea/format succeeding on several unrelated channels ("proof of demand"); (4) adapt the format's click mechanic to your subject; (5) build title + thumbnail first, then script.
- **[unverified]** Small-channel outliers are the strongest signal: a few-thousand-subscriber channel at 20x its median means the idea and packaging carried the video, not the audience — the evidentiary basis for "anyone can crack the algorithm" on a first upload.
- **[unverified]** Cross-niche transplanting: take a format that is an outlier in one niche ("I tried X for 30 days", "Ranking every X", "$1 vs $10,000 X", "Why X is dying") and be first to apply it in yours.
- **[unverified]** Remix, don't copy: keep the click mechanic (stakes, curiosity gap, contrast, transformation) but change subject, twist or scale; a straight copy competes with the original in Suggested and loses.
- **[unverified]** Validation checklist: hit on 3+ channels? hit on a channel smaller than yours? still un-done in your niche? can you add a twist? expressible in one image and ~six words?
- **[unverified]** Recency: trend-sensitive niches (tech, gaming, news, AI) use 3-6 months; evergreen niches (fitness, finance, education) tolerate 1-2 years.
- **[unverified]** Niche research: count channels under ~50k subscribers with 10x outliers in the last year; many hits means open demand and low loyalty barriers for a newcomer.
- **[unverified]** Own-channel audit: compute your median, list videos at 1.5-2x+, double down on those topics/formats before hunting externally; benchmark competitors by median views and outlier frequency (how many of the last 10-20 uploads exceeded 2x), not subscriber count.
- **[unverified]** Weekly workflow: 30-60 minutes scanning outliers in your niche plus two adjacent niches; save 10-20 ideas to a board; write 5-10 titles per surviving idea; sketch a thumbnail for the top 3; pick the idea with the strongest packaging; only then outline and script.
- **[unverified]** Format library: settle on 3-5 repeatable formats and rotate subjects through them.

### 4.4 Tooling — [unverified]

- **[unverified]** Filters: minimum multiplier, published-within window, subscriber range, view range, duration / exclude Shorts, language/region; sort by outlier score, views or views-per-hour (VPH). VPH sorting is the "what is working right now" view.
- **[unverified]** Channel analysis (paste a channel URL, see every video ranked against that channel's median); AI title/idea generator that pattern-matches an outlier's title structure onto your subject; thumbnail search/library with boards (swipe file); thumbnail feed-preview mockup next to real competing videos; Chrome extension overlaying the multiplier on YouTube's home, search and channel pages; shareable boards for editor/designer/strategist.
- **[unverified]** Pricing: paid subscription with a free trial or limited free searches; tiers in the tens of dollars per month; higher tiers unlock more searches, the extension, team boards and AI generation. Exact prices unknown. (Sourced: a $1 trial exists via the podcast affiliate link. [Anchor RSS](https://anchor.fm/s/110bc6964/podcast/rss))
- **[unverified]** Competitors: ViewStats (MrBeast-backed; outlier score, thumbnail history, VPH), vidIQ Outliers, TubeBuddy, Spotter Studio (Sept 2024, ~$49/month at launch). 1of10 differentiates on keyword-level outlier search across all of YouTube plus thumbnail search, feed preview and boards.
- **[unverified]** 1of10 runs a newsletter and X account publishing "outlier of the week" breakdowns.

### 4.5 Doctrine — [unverified]

- **[unverified]** Hierarchy of leverage: idea > packaging (title + thumbnail) > content. Packaging determines CTR, content determines watch time; a great video with weak packaging never gets enough impressions to be judged on content.
- **[unverified]** Packaging-first: lock title and thumbnail before scripting or filming; if you cannot produce a compelling thumbnail, do not make the video.
- **[unverified]** "The title and thumbnail are the idea": an idea not expressible in ~six words plus one image is not yet a YouTube idea; ideation produces title+thumbnail pairs, not topics.
- **[unverified]** Corollary: an outlier multiplier is the algorithm's already-rendered verdict; outlier hunting reverse-engineers what YouTube has validated.
- **[unverified]** Traffic pattern: 10x+ outliers are overwhelmingly Browse and Suggested, not Search; optimize for feed click-worthiness rather than keywords.
- **[unverified]** Retention frame: pay off the title's promise in the first 30 seconds (restate the promise, show visible progress, no channel intro) or the impression test fails on AVD.

### 4.6 Lessons from other guests — [unverified]

- **[unverified]** Recurring cross-guest lessons: (a) the idea is chosen from evidence, not taste; (b) packaging is decided before filming; (c) small-channel outliers prove ideas; (d) fewer, better-packaged videos beat more uploads; (e) study thumbnails in feed context, not isolation.
- **[unverified]** Guests Jake Trinder and Sam Gaudet (strategists) are believed to have appeared; specific lessons, dates and titles not verified.
- **[unverified]** Episode titles follow templates such as "This YouTube Genius ..." and "[N] Minutes Inside The Mind of ...".

---

## 5. 2026 algorithm and cold-start facts

### 5.1 Sourced

- The only sourced items on this topic are episode-derived: the chapter "How to go from 500 views to 100k views on the first video" and the title "Anyone Can Crack The Algorithm With Your First Upload". [Apple Podcasts](https://podcasts.apple.com/in/podcast/1of10-podcast/id1870599992), [YouTube](https://www.youtube.com/watch?v=tuv_XPF6cH8)
- Host doctrine: "if no one clicks it doesn't matter how good your video is." [1of10 TikTok](https://www.tiktok.com/@1of10media/video/7463482203373079841)

### 5.2 Unverified (model knowledge; verification checklist for a fresh session)

**Per-video judgment and cold start**
- **[unverified]** YouTube's official framing (Todd Beaupre, director of growth & discovery; Creator Liaison Rene Ritchie; Creator Insider, 2023-25): recommendations evaluate each video on its own viewer-response signals rather than judging the channel; "the audience is the algorithm"; "the algorithm pulls videos for viewers, it does not push videos to viewers".
- **[unverified]** YouTube has repeatedly denied a "new channel sandbox" or channel-level penalty: a new channel's first upload is shown to a small pool of viewers whose watch history matches the topic/metadata; distribution widens only if early CTR, watch time and satisfaction are strong. Subscriber count is not a direct ranking input.
- **[unverified]** Distribution comes "in waves": tested on an initial audience, re-tested later; under-performing uploads can be resurfaced months later ("no video is ever dead").
- **[unverified]** Google's 2016 paper "Deep Neural Networks for YouTube Recommendations" (Covington, Adams, Sargin) describes the two-stage candidate-generation/ranking architecture, an "example age" feature favoring fresh uploads, and content/metadata features for cold-start items.
- **[unverified]** A new channel has no subscriber feed, so nearly all early impressions come from Browse and Suggested; packaging must be legible to cold viewers and use the visual language of the niche's proven outliers.
- **[unverified]** Custom thumbnails require unlocked intermediate features (phone verification / channel standing); a brand-new channel must verify before its first upload can carry one.

**Ranking inputs**
- **[unverified]** YouTube's 2021 blog "On YouTube's recommendation system" (Cristos Goodrow) lists clicks, watchtime, survey responses, sharing, likes and dislikes, and introduces "valued watchtime" measured by satisfaction surveys.
- **[unverified]** YouTube surveys a sample of viewers ("How would you rate this video?" 1-5 stars) and uses predicted satisfaction as a ranking factor alongside click and watch-time predictions.
- **[unverified]** High CTR with low AVD is treated as a clickbait signal: initial impressions from clicks, then loss of Browse distribution when watch time and satisfaction fail to confirm.
- **[unverified]** Upload frequency, video length and posting time are not direct ranking factors; consistency matters for audience expectation, not as a system reward.
- **[unverified]** Shorts and long-form are recommended by separate systems; posting Shorts does not hurt long-form; Studio Analytics separates the audiences.

**Traffic sources**
- **[unverified]** Browse (Home) and Suggested are the dominant sources for long-form entertainment; Home is driven by viewer history plus CTR and satisfaction, Suggested by co-watch relationships; Search matters mainly for evergreen/how-to.
- **[unverified]** Diagnosis: Browse-heavy = packaging is winning homepage tests; Suggested-heavy = pairs well with other videos (good for sequels); Search-heavy = evergreen.

**Benchmarks**
- **[unverified]** YouTube Help: half of all channels and videos have an impressions CTR between 2% and 10%; compare against your own history and by traffic source, not a universal target.
- **[unverified]** An impression counts only when a thumbnail is shown >1 second with >=50% visible on a YouTube surface; embeds, end screens and notifications do not count.
- **[unverified]** Studio's "Intro" key moment measures the share still watching after 30 seconds; analysts treat 70%+ as strong.
- **[unverified]** Analyst rule of thumb for long-form average percentage viewed: 40-50% good, 60%+ excellent on 8-15 minute videos; YouTube publishes no official AVD target.
- **[unverified]** The Analytics funnel is impressions -> CTR -> views -> AVD -> watch time.

**Testing and 2024-26 platform changes**
- **[unverified]** Test & Compare (native thumbnail A/B, all channels in 2024): up to 3 thumbnails; winner decided on watch-time share, not raw CTR; outcomes "Winner", "Preferred", "None"; tests run days to ~2 weeks. Help-page URL candidates differ across angles (answer/14038473, /14712063, /14549565, /14380726) — verify.
- **[unverified]** Title testing inside Test & Compare (title + thumbnail combinations) was announced in 2025 (Made on YouTube, Sept 2025) with rollout continuing into 2026; GA status by Sept 2026 should be checked.
- **[unverified]** Effective March 31, 2025, a Shorts view counts as soon as it starts playing or replays; "engaged views" remain the monetization metric.
- **[unverified]** "Hype" (piloted 2024, expanded 2025) lets viewers hype videos from channels under 500K subscribers onto a leaderboard and into recommendations.
- **[unverified]** July 15, 2025 YPP update clarified "inauthentic content" (mass-produced/repetitive) is not monetizable.
- **[unverified]** Shorts may run up to 3 minutes since Oct 2024.
- **[unverified]** Monthly 2026 "algorithm changes" roundups exist from air.io, OutlierKit, Senswit and MediaCube; their Jan-Sept 2026 entries were not retrieved.
- **[unverified]** Changing a title or thumbnail after publishing does not reset a video's history; YouTube re-evaluates on new impressions.

---

## 6. Thumbnail factory rules (numbered, actionable)

Sourced inputs are limited to: Jake's "completely new format" claim and its copy-as-validation framing [X profile](https://x.com/jacobrbryant1); the "clean thumbnails" chapter [Anchor RSS](https://anchor.fm/s/110bc6964/podcast/rss); Mike Shake's practice of hiring thumbnail designers and "great packaging can amplify good ideas" [Mike Shake on X](https://x.com/MikeshakeYT?lang=en); and 1of10's "Spend as much time planning [titles and thumbnails] as you do your video" [1of10 TikTok](https://www.tiktok.com/@1of10media/video/7463482203373079841). **Every numbered rule below is [unverified]** (model knowledge; primary sources named in `findings.json`: YouTube Help, Creator Insider, MrBeast interviews and leaked production doc, Paddy Galloway, Film Booth, Jay Alto, YT Jobs).

**Spec and policy**
1. [unverified] Deliver 1280x720 px, 16:9, minimum width 640 px, JPG/GIF/PNG, under 2 MB, sRGB; each Test & Compare variant must meet the same spec.
2. [unverified] The scene in the thumbnail must exist in the video and appear early — required for policy (misleading thumbnails can be removed or strike the channel) and for retention.
3. [unverified] No sexual, violent or shocking imagery; no third-party logos or faces without rights.

**Composition**
4. [unverified] One focal point; at most three distinct elements (e.g. face + object + short text); the viewer must understand it in under one second at feed size.
5. [unverified] Text: 0-4 words (2 ideal), heavy all-caps sans-serif (Bebas Neue, Anton, Impact, Montserrat ExtraBold) with stroke or shadow; never more than two lines; never over the face; never repeating title words — text adds a second layer (a number, a contradiction, a question).
6. [unverified] Faces: large (a quarter to a third of frame height), eyes lit and visible, one clear expression matching the promised emotion, eye-line toward the object of interest; the generic shocked face is now a fatigue signal in many niches.
7. [unverified] Separate subject from background (rim light, outline, drop shadow, blur); one dominant color plus one complementary accent; 2-3 colors total; avoid mostly-white or mostly-black thumbnails (they blend into YouTube's light/dark UI); avoid red text (fights YouTube's red UI).
8. [unverified] Safe zones: keep the bottom-right (~20% x 15%, duration badge), the bottom edge (progress bar) and the top-right on desktop hover (Watch Later / queue icons) free of critical elements.
9. [unverified] Title and thumbnail must not say the same thing: thumbnail = the "what"/the promise; title = the context, stakes, "how much/how long". Together they raise exactly one question the video answers.
10. [unverified] Stage the thumbnail shot as its own setup on shoot day (never a frame grab); for loud-style, exaggerate scale and prefer physical props.

**Clean/minimal style (the trend the episode asks about)**
11. [unverified] Clean style = single subject, negative space, natural or cinematic light, muted/dark background, little or no text (thin/regular type if any), no arrows/circles/red outlines; it works by contrast against saturated feeds and signals premium/documentary quality. MrBeast's 2024-25 simplification is often cited as its mainstream start.
12. [unverified] Clean is genre-dependent: wins in education, documentary, business, tech, lifestyle; kids, gaming and mass entertainment still favor saturation and bigger faces. Test a clean and a loud variant rather than assuming.
13. [unverified] Text-free thumbnails travel across languages and pair with multi-language audio / auto-dubbing; default to no text or a single number for international channels.

**Production system**
14. [unverified] Photoshoot protocol: a 15-30 minute session on shoot day (or a monthly batch shoot) capturing 30-100 expressions and poses in 2-3 outfits, key + rim light, shot RAW, catalogued into an expression library.
15. [unverified] Brief template fields: working title(s); one-sentence concept and core promise; target emotion; the single most important element; 2-3 outlier references and 1-2 "not like this" references; text (max 4 words); palette/fonts; asset links; deadline; deliverables (e.g. 3 variants + source); what the winner will be tested against.
16. [unverified] Variant strategy: sketch 5-10 concepts in 30-second doodles; produce 3 in a safe / bold / wild pattern; refine into 3 conceptually different finals; submit to Test & Compare. Large channels produce 5-20 versions per video; MrBeast has reported up to ~$10,000 on a single thumbnail and keeps backups ready to swap in the first hours.
17. [unverified] Turnaround: first draft 24-72h, rush 12-24h at a premium, two revision rounds, finals 24h before publish; retainers batch a week at a time.
18. [unverified] Team: strategist (concept + brief), designer (execution + variants), editor (frame/photo pulls), creator/lead (approval), coordinated in Notion/Frame.io/Slack with a weekly blind-vote packaging review.
19. [unverified] Tool stack: Photoshop (Select Subject, Remove Background, Generative Fill, Camera Raw), Figma for templates and comment rounds, Canva for solo creators; AI: Midjourney/Flux (backgrounds, props), Ideogram (legible text), GPT-image (concept mockups), Nano Banana / Gemini 2.5 Flash Image (consistent-identity face edits), Topaz/Magnific upscaling; real photos of the creator's face still preferred.
20. [unverified] Pricing (2025-26): $10-50 entry; $75-250 competent freelance; $300-1,000+ top designers; agency retainers ~$1,500-10,000/month for 4-16 thumbnails with variants; "packaging packs" (3 titles + 3 thumbnails) and performance-linked bonuses are increasingly common.

**QA and testing**
21. [unverified] Technical QA: spec check; no compression artifacts; subject not clipped by badge or progress bar; checked at 10% zoom (squint test), in grayscale (gray test), in light and dark mode, in a mobile feed mockup and desktop sidebar mockup (Suggested sidebar ~168 px wide, mobile search ~150 px).
22. [unverified] Content QA: scene exists in video and appears early; no title duplication; max 3 elements; single focal point; emotion matches promise; rights-clean; policy-safe; visually distinct from the channel's last 3-5 thumbnails; brand-consistent; versioned filename and archived source.
23. [unverified] Feed-context test: never judge in isolation; drop the candidate into a mock Home/Suggested feed beside the niche's top 5-10 competitor thumbnails (Thumbnail Preview, TubeBuddy/vidIQ preview, 1of10 boards, or a Figma feed template).
24. [unverified] Test & Compare: test genuinely different concepts, not color tweaks; do not edit title/description/thumbnail mid-test; ~10k impressions per variant as a directional threshold; run only on videos expected to get reach; re-test the winner against a fresh challenger; log every result.
25. [unverified] Swap protocol: check Reach after 24-72h; if CTR is below the channel median and impressions are decaying, swap to the next-best variant or start a test; do not swap while Suggested impressions are still rising; let stats stabilize 48h after a swap.
26. [unverified] Read CTR by traffic source: thumbnail changes mostly move Browse and Suggested CTR; Search CTR is title/keyword driven; compare against the channel's own per-source median.
27. [unverified] Retention linkage: pay off the thumbnail's promise within 30-60 seconds; lock the script only after the thumbnail is approved; give editors the thumbnail as the north star for the cold open; sign off the final thumbnail alongside the final cut.
28. [unverified] Consistency vs novelty: keep a recognizable brand system but vary layout across consecutive uploads to avoid feed fatigue.
29. [unverified] Repackaging: prioritize library videos with high AVD but below-median CTR; refresh evergreen back-catalog packaging monthly, especially videos still receiving Suggested traffic.
30. [unverified] Device context: design for mobile legibility first; verify nothing looks cheap at TV scale (TV is the largest single device by US watch time).
31. [unverified] Failure modes to screen: text too small on mobile; centered subject with no directional tension; more than one story in the frame; background competing with the face; duplicated title text; same layout as last upload; choosing by the creator's taste instead of a feed mockup or test.

---

## 7. Ideation, packaging, retention and operating-system rules from top creators (numbered, actionable)

Sourced inputs: Trech's "improving titles, thumbnails, storytelling and content positioning, rather than simply increasing upload frequency" and "fewer, better-optimized uploads" [Trech Media](https://www.trechmedia.com/); TubeLab's "increasing loyal viewers who return to watch every upload" [TubeLab](https://tubelab.net/youtube-strategy); 1of10's "study over performing videos" and "Spend as much time planning [packaging] as you do your video" [1of10 TikTok](https://www.tiktok.com/@1of10media/video/7463482203373079841); Mike Shake's "not reinventing the wheel and starting with good ideas ... great packaging can amplify good ideas" and "Create your own identity and leverage it" [Mike Shake on X](https://x.com/MikeshakeYT?lang=en); CNBC's "$15,000+ monthly" advisor rate and Jesser's 3M -> 41M growth [CNBC](https://www.cnbc.com/2026/05/10/youtube-advisors-mrbeast-top-creators-platform-viewership.html). **Every numbered rule below is [unverified]** (model knowledge; named primary sources: MrBeast leaked onboarding doc, Paddy Galloway, Jon Youshaei, Colin & Samir, Nate Black, Hayden Hillier-Smith, Jenny Hoyos, Ryan Trahan, YouTube Help, YT Jobs, vidIQ, Spotter Studio, ViewStats).

**Ideation**
1. [unverified] Hierarchy: Idea > Packaging > Execution (Paddy Galloway; Colin & Samir's idea / packaging / story). Spend most strategist hours on idea selection and title/thumbnail, not production.
2. [unverified] Outlier research rules: judge channel-relative multiplier, not raw views; weight small-channel outliers more (100k on a 5k-sub channel beats 1M on a 10M channel); look outside your niche; filter to the last 6-12 months.
3. [unverified] Demand check before committing: search interest via Studio Research tab, plus at least 2-3 videos in the last 12 months that beat their channel median by 3x+.
4. [unverified] Idea bank: 50-100+ ideas in Notion/Airtable/Sheets, each with a draft title, a one-sentence thumbnail description and the outlier link; weekly review; a "top 10 ready" shortlist; never start production without an approved title + thumbnail.
5. [unverified] Scoring rubric (1-5 each): proven demand, audience fit, packaging clarity (sayable in under 8 words, showable in one image), ceiling, feasibility/cost, "would I click?"; only ideas above a threshold (e.g. 20/30) proceed.
6. [unverified] Kill criteria: cut any idea that has no title under ~60 characters and no single-image thumbnail; if it "only works once you watch it", it goes back to the bank.
7. [unverified] The "tell a friend" test: if the idea needs explanation to be told in one sentence, it will not work in a feed. MrBeast's version: understandable from the thumbnail alone with little or no text, and clickable over the ~20 other homepage videos.
8. [unverified] Ideation levers on proven formats: escalation, contrast ($1 vs $1,000,000), constraint (24 hours, $0), extremity (world's largest), completionism (every X), subject swap (same format, new niche), sequel/series.
9. [unverified] Titles as ideas: store ideas only as titles; store the thumbnail as one descriptive sentence.
10. [unverified] Write 10 (often 20-30) alternative titles per concept; the winning title frequently reshapes the idea (Jon Youshaei: title first, then thumbnail, then script; "the title is the idea").
11. [unverified] Sequel / ride-the-wave rule: when a video does 2-3x+ the channel median, publish a same-format follow-up within 1-2 weeks and consider a series.
12. [unverified] Formats: build the calendar around 2-5 repeatable show formats rather than fresh concepts weekly; split slots roughly 70% proven / 20% adjacent / 10% experiments.

**Packaging**
13. [unverified] Packaging-first: lock title, thumbnail and the "thumbnail scene" to capture before scripting or shooting; if no compelling thumbnail can be made, do not make the video.
14. [unverified] Titles: under ~50-60 characters (5-9 words), hook in the first 3-4 words, specific numbers, curiosity gap, Title Case with at most one ALL-CAPS word, "I" framing for personal stakes, no promise the video cannot pay off, avoid dates/numbers that age unless it is a series.
15. [unverified] Recurring outlier title formulas: "I [did extreme thing] for [time]"; "$1 vs $1,000,000 [X]"; "I Tried Every / Ranking Every [X]"; "Why [surprising claim]"; "The [X] That [unexpected outcome]"; "[X] vs [Y]"; "24 Hours / 7 Days in [place]"; "World's [largest/most expensive] [X]"; "The truth about X"; "How X actually works"; "N mistakes ...".
16. [unverified] Thumbnail-title split: thumbnail = the "what"; title = the "how much / how long". Never duplicate words.
17. [unverified] Pre-production validation: show 2-3 title/thumbnail pairs to a private Discord, community poll or 10-30 target viewers ("which would you click?", "what do you expect the video to be?") and fix any expectation gap before shooting.
18. [unverified] Frame 1 should visually confirm the thumbnail so the clicker knows they are in the right place; the thumbnail moment must actually occur in the video.

**Retention**
19. [unverified] The three judged metrics (MrBeast doc): CTR, AVD, AVP; the first minute's only job is to earn the second; check retention at ~minute 1, 3 and 6.
20. [unverified] Hook (first 15-30 seconds), scripted word for word: restate/confirm the title promise, establish stakes or the central question, preview why it matters; no logos, intros, channel branding, montage intros or "in this video I'm going to".
21. [unverified] Benchmarks: 70%+ still watching at 30 seconds is strong; 50%+ average percentage viewed on a 10-15 minute video is good; a sharp early cliff means packaging over-promised or the intro was slow.
22. [unverified] Beat sheet: 0:00-0:15 hook; 0:15-1:00 setup; 1:00-3:00 first payoff; a new question/escalation every 1-3 minutes; mid-video low point; climax at 80-90% of runtime; end within 10-20 seconds of the payoff; tease the next video instead of "thanks for watching"; hard-cut to end screen.
23. [unverified] Editing for retention (Hayden Hillier-Smith): every cut must earn its place; change something visual or audible every few seconds; sound design carries emotion; do a dedicated retention pass marking every moment a viewer could leave.
24. [unverified] Scripting (Nate Black): list every viewer question in the order they would ask, answer in sequence, let each answer open the next question ("question chaining").
25. [unverified] Visible progress markers (day counters, money counters, map progress) as rehooks; restate title stakes on screen (Ryan Trahan).
26. [unverified] Quality bar (MrBeast doc): every video must leave the viewer thinking "that was crazy" or "that was fun"; cut anything that does neither; no minute exists to fill runtime.
27. [unverified] Shorts (Jenny Hoyos): hook in the first second (mid-action or bold claim), a "but" turn, child-simple language, ~30-45 seconds, end on a loop; targets 70%+ viewed-vs-swiped and 100%+ average percentage viewed.
28. [unverified] Retention curve reading: steep drop in first 30s = hook/mismatch; steady gentle slope = healthy; sudden mid dip = a segment to cut; spike = a moment to build a Short or the next thumbnail around.

**Analytics loop**
29. [unverified] Post-publish (24-48h): compare CTR and AVD to the last 10 videos; impressions rising but CTR below median -> swap packaging; CTR high but AVD low -> packaging over-promised; wait 48-72h before judging Browse pickup; evaluate CTR alongside impression growth, never alone (impressions widen to colder audiences, which lowers CTR).
30. [unverified] Studio's "compare to typical performance" rank (e.g. 2 of 10) is the built-in own-channel outlier check; a 1-3 of 10 ranking in the first hours triggers promotion and sequel planning; first-day VPH above the usual range is the velocity signal.
31. [unverified] Post-mortem template: packaging hypothesis; CTR vs median; AVD/APV vs median; traffic-source mix; top 3 retention dips with timestamps and cause; 1-3 action items for the next video.
32. [unverified] Per-video dashboard: impressions, CTR, AVD, APV, views-vs-median multiplier, returning vs new viewers, end-screen click rate; weekly review adds traffic-source views and subscriber conversion per video.
33. [unverified] Back-catalog: repackaging old titles/thumbnails is a standing monthly task, prioritizing videos still receiving Suggested traffic.

**Operating system**
34. [unverified] Pipeline stages: Idea -> Scored/Approved -> Title+Thumbnail locked -> Script/Outline -> Shoot -> Edit v1/v2 -> Thumbnail final -> QC -> Scheduled -> Published -> 48h review -> Post-mortem.
35. [unverified] Weekly ideation meeting: each member brings 3-5 ideas already packaged as title + thumbnail sketch; group votes; strategist logs winners with a scoring note; unpackaged ideas are not discussed.
36. [unverified] Edit review: v1 against beat sheet and hook script; v2 retention pass; v3 sound design; thumbnail signed off with the final cut.
37. [unverified] Cadence: one well-packaged long-form per week beats daily weak uploads; daily only inside time-boxed series (Ryan Trahan's Penny series 2022, 50 States in 50 Days 2025) because series create binge chains; plan 4-8 weeks ahead with a title and thumbnail sketch per slot; batch 2-4 videos per shoot day and hold a 2-3 video buffer.
38. [unverified] Roles on a 1M+ channel: strategist/channel manager, writer, 1-3 editors, thumbnail designer, producer/PM, sometimes a researcher; a 3-5 person team often costs $10-30k/month. Rates: thumbnails $50-500 (elite $500-1,000+); editors $500-3,000 per video or $25-100/h; strategists $2-10k/month or revenue share.
39. [unverified] Strategist deliverables (Trech-style agencies): channel audit, scored idea bank, per-video packaging, retention notes on cuts, monthly analytics review.
40. [unverified] AI automation: prompt an LLM with the idea plus 5 formulas for 20 titles under 55 characters and 10 one-line thumbnail concepts; generate comps with Midjourney/Ideogram/Nano Banana; turn a script into a timestamped beat sheet; Descript/Opus Clip for clipping; YouTube Studio's Inspiration tab, Research tab ("content gaps"), Audience tab and "Ask Studio" (Gemini) as first-pass diagnosis.
41. [unverified] Monetization framing: mid-rolls require 8+ minutes; target 8-15 minutes; RPM varies by niche (entertainment ~$2-5, finance/tech ~$10-20+).

---

## 8. Numbers and benchmarks table

| Metric | Value | Source | Status |
|---|---|---|---|
| Target video upload | ~Sept 9, 2026 ("5 days ago" as of Sept 14) | [YouTube](https://www.youtube.com/watch?v=tuv_XPF6cH8) | sourced |
| Audio episode date | Wed July 29, 2026 (Apple/Spotify); X shout-out July 28 | [Apple](https://podcasts.apple.com/in/podcast/1of10-podcast/id1870599992), [X](https://x.com/JacobRBryant1/status/2082174136319668553) | sourced |
| Audio episode length | 17 min (Apple); title says "19 Minutes" | [Apple](https://podcasts.apple.com/in/podcast/1of10-podcast/id1870599992) | sourced |
| Last chapter timestamp (RSS) | 23:39 | [Anchor RSS](https://anchor.fm/s/110bc6964/podcast/rss) | sourced |
| Jake: long-form views | 2.5B+ (current X bio); 1.5B (earlier bio); 1B+ (Trech, TubeLab) | [X](https://x.com/jacobrbryant1), [Trech](https://www.trechmedia.com/), [TubeLab](https://tubelab.net/youtube-strategy) | sourced |
| Jake: channels | 40+ (current); 35+ (earlier); 25+ (LinkedIn, TubeLab) | [X](https://x.com/jacobrbryant1), [LinkedIn](https://www.linkedin.com/in/jake-bryant-ba889b15a/) | sourced |
| Jake: uploads | 2,000 (current); 1,500 (earlier) | [X](https://x.com/jacobrbryant1) | sourced |
| Jake: experience | 10+ years (Trech); 9+ years filming/editing (LinkedIn) | [Trech](https://www.trechmedia.com/), [LinkedIn](https://www.linkedin.com/in/jake-bryant-ba889b15a/) | sourced |
| Jake: YT Jobs portfolio | 177.52M views, 2.83M likes; top-5 strategist (Aug 5, 2026) | [YT Jobs](https://ytjobs.co/talent/profile/5451), [X](https://x.com/JacobRBryant1/status/2084959034445066316) | sourced |
| Jake: Instagram followers | ~1,050 | [Instagram](https://www.instagram.com/jacob_r_bryant_/) | sourced |
| Jake: Hi5 tenure | ~3 years full-time (Instagram caption); "May 2025" start (LinkedIn snippet, unreliable) | [Spellbound](https://spellbound.fandom.com/wiki/Get_Good_Gaming), [LinkedIn](https://www.linkedin.com/in/jake-bryant-961704190/) | sourced (conflicting) |
| Episode case: subscribers | 0 to 400,000 in 2 years | [Apple](https://podcasts.apple.com/in/podcast/1of10-podcast/id1870599992) | sourced (channel unnamed) |
| Episode case: entertainment channel | 23M views from packaging | [Apple](https://podcasts.apple.com/in/podcast/1of10-podcast/id1870599992), [RSS](https://anchor.fm/s/110bc6964/podcast/rss) | sourced (channel unnamed) |
| Episode case: monthly views | 100M | [RSS](https://anchor.fm/s/110bc6964/podcast/rss) | sourced (channel unnamed) |
| Episode case: first video | 500 -> 100k views | [Apple](https://podcasts.apple.com/in/podcast/1of10-podcast/id1870599992) | sourced (channel unnamed) |
| Trech: time to results | < 3 months | [Trech](https://www.trechmedia.com/) | sourced |
| Trech: entry offer | Free 30-minute discovery call | [Trech](https://www.trechmedia.com/) | sourced |
| Top-advisor pricing | $15,000+/month; Jesser 3M -> 41M subs | [CNBC](https://www.cnbc.com/2026/05/10/youtube-advisors-mrbeast-top-creators-platform-viewership.html) | sourced |
| 1of10 users | 10,000+ channels | [VidSummit](https://www.vidsummit.com/speakers-2025/richard-the-youtube-strategist) | sourced |
| 1of10 founding | 2023 (Richard + Riad) | [1of10](https://1of10.com/richardyts) | sourced |
| Richard's prior agency | 100+ YouTubers | [1of10](https://1of10.com/richardyts) | sourced |
| 1of10 trial | $1 via podcast affiliate link | [RSS](https://anchor.fm/s/110bc6964/podcast/rss) | sourced |
| Podcast episode count | 93 (Podstatus) vs 83 (Rephonic, "launched 4 months ago") | [Podstatus](https://podstatus.com/podcasts/1of10-podcast-1252892), [Rephonic](https://rephonic.com/podcasts/1of10-podcast) | sourced (conflicting) |
| Mike Shake subscribers | 4,930,556 (HypeAuditor); 2.2M (older X post) | [X/HypeAuditor](https://x.com/MikeshakeYT?lang=en) | sourced (different dates) |
| Mike Shake top video | "I learned to throw a toothpick", 27M+ views | [Famous Birthdays](https://www.famousbirthdays.com/people/mike-shake.html) | sourced |
| Hudson Matter | 2M+ subs; 250M+ views (VidSummit) / 215M+ views (thoughtleaders); ~23 min avg video; top video 7M+ | [VidSummit](https://www.vidsummit.com/speakers-2025/hudson-matter), [thoughtleaders](https://app.thoughtleaders.io/youtube/hudson-matter), [celebicity](https://www.celebicity.com/hudson-matter/) | sourced |
| Mark Manson | 2.6M subscribers in 2 years | [Creator Science](https://podcast.creatorscience.com/mark-manson/) | sourced |
| Ollie (1of10): Kallaway | 0 -> 300,000 subs in just over a year | [1of10 blog](https://1of10.com/blog/how-to-get-millions-of-views-in-any-niche-from-an-expert/) | sourced |
| Impressions CTR, half of channels | 2%-10% | YouTube Help (not fetched) | unverified |
| Impression definition | >1 s shown, >=50% visible | YouTube Help (not fetched) | unverified |
| 30-second retention "strong" | 70%+ | analyst rule of thumb | unverified |
| Long-form APV | 40-50% good, 60%+ excellent (8-15 min) | analyst rule of thumb | unverified |
| Test & Compare | up to 3 variants; watch-time share; days to ~2 weeks; ~10k impressions/variant | YouTube Help (not fetched) | unverified |
| Outlier thresholds | 2x notable; 3-5x worth watching; 5x strong; 10x+ breakout | 1of10 (not fetched) | unverified |
| Outlier recency window | 3-6 months (trend niches); 6-12 months default; 1-2 years (evergreen) | 1of10 (not fetched) | unverified |
| Title length | under ~50-60 characters; hook in first 3-4 words | YouTube Help / strategists | unverified |
| Thumbnail text | 0-4 words, 2 ideal; max 3 elements | Film Booth / Jay Alto | unverified |
| Thumbnail spec | 1280x720, 16:9, min 640 px wide, <2 MB | YouTube Help (not fetched) | unverified |
| Thumbnail variants | 5-20 per video (large channels); 3 + Test & Compare (small); MrBeast ~$10k max per thumbnail | MrBeast interviews | unverified |
| Thumbnail pricing | $10-50 / $75-250 / $300-1,000+; retainers $1,500-10,000/mo | YT Jobs market | unverified |
| Team cost, 1M+ channel | $10-30k/month for 3-5 people | YT Jobs / Colin & Samir | unverified |
| Shorts | 3-minute max since Oct 2024; view counted on play since Mar 31, 2025 | YouTube (not fetched) | unverified |
| Hype eligibility | channels under 500K subscribers | YouTube (not fetched) | unverified |
| Mid-roll minimum | 8+ minutes | YouTube Help (not fetched) | unverified |
| RPM by niche | entertainment ~$2-5; finance/tech ~$10-20+ | strategist rule of thumb | unverified |
| Spotter Studio / vidIQ pricing | ~$49/month (launch / Boost tier) | vendor sites (not fetched) | unverified |

---

## 9. Contradictions between sources and how to resolve them

1. **Chapter timestamps (Apple).** One parse gives Content vs Packaging 00:29 / biggest mistake 01:55 / 0-400k 04:09 / Mike Shake 05:19 / 2026 06:59 / thumbnail breakdown 11:55 / ideation 14:19; another gives Content vs Packaging 01:55 / biggest mistake 04:09 / 0-400k 05:19 / 2026 06:59. [Apple Podcasts](https://podcasts.apple.com/in/podcast/1of10-podcast/id1870599992). *Resolution:* the second set is the same list shifted by one slot (each chapter takes the next chapter's time), which is a snippet-parsing artifact; the first, complete, eight-entry list with 00:00 as the first marker is the correct one for the audio cut. Confirm by opening the Apple chapter list.
2. **Two description variants and the 23:39 chapter.** The Apple list ends at 14:19 in a 17-minute episode; the RSS variant has a 23:39 chapter. [Anchor RSS](https://anchor.fm/s/110bc6964/podcast/rss). *Resolution:* treat them as two cuts — the audio (17 min) and the video (at least ~24 min). The Sept 9 YouTube upload is the best candidate for the longer cut, but this is unverified; confirm by reading the YouTube description's chapter list.
3. **Episode date July 28 vs July 29.** The X shout-out is dated July 28; Apple and Spotify say July 29. [X](https://x.com/JacobRBryant1/status/2082174136319668553), [Apple](https://podcasts.apple.com/in/podcast/1of10-podcast/id1870599992). *Resolution:* platforms may show the feed's publish date in a different timezone, or the guest posted on early access; use July 29 as the platform publication date and July 28 as the guest's announcement.
4. **"17 minutes" vs "19 Minutes".** Apple lists 17 min; the title promises 19. *Resolution:* the title is marketing copy; Apple's duration is the file length. Not material.
5. **Who wished the episode were longer.** One parse says a commenter; another says Jake. [X](https://x.com/JacobRBryant1/status/2082174136319668553). *Resolution:* attribute to a commenter unless the thread is read directly; the substantive point (audience wanted more titles-and-thumbnails content) holds either way.
6. **Calendly URL.** `calendly.com/trechconsultat` vs `calendly.com/trechconsultation`. [X](https://x.com/jacobrbryant1). *Resolution:* the shorter form looks truncated; use the full form and verify by visiting.
7. **Hi5 tenure.** "The past 3 years have been great" (Instagram caption, via wiki) vs "started working at Hi5 Studios full-time in May 2025" (LinkedIn snippet). [Spellbound](https://spellbound.fandom.com/wiki/Get_Good_Gaming), [LinkedIn](https://www.linkedin.com/in/jake-bryant-961704190/). *Resolution:* a May 2025 start cannot precede a 3-year tenure that ended before he became an Austin-based strategist with 40+ channels; the "May 2025" is almost certainly a misparse (possibly May 2015 or an unrelated date). Treat the 3-year figure as more credible; verify on LinkedIn.
8. **View-count claims (1B+ / 1.5B / 2.5B / 177.52M).** *Resolution:* these measure different things at different times: Trech and TubeLab copy (1B+) is older marketing text; the X bio has been updated from 1.5B to 2.5B; YT Jobs' 177.52M is only the portfolio videos attached to his profile. Report each with its scope; do not sum or average.
9. **Channel counts (25+ / 35+ / 40+).** Same as above: escalating over time; the LinkedIn/TubeLab "25+" is the oldest.
10. **Hudson Matter total views (250M+ vs 215M+).** [VidSummit](https://www.vidsummit.com/speakers-2025/hudson-matter), [thoughtleaders](https://app.thoughtleaders.io/youtube/hudson-matter). *Resolution:* different snapshot dates; both are "2M+ subs, 200M+ views". Not material.
11. **Mike Shake subscribers (4.93M vs 2.2M).** *Resolution:* the 2.2M figure is from an older post; 4.93M is the current HypeAuditor count.
12. **Podcast episode count (93 vs 83) and "launched 4 months ago" with 83 episodes.** *Resolution:* Rephonic's data is stale or its launch date is wrong (83 episodes in 4 months is implausible for a weekly show); prefer Podstatus's 93. The Jake episode's number in the catalog is unknown either way.
13. **Which channel is which case.** The "0 to 400,000 in 2 years", "100M monthly views" and "23M views on an entertainment channel" cases are unnamed. Candidates from his background — Hudson Matter (2M subs; no 23M-view video found; top video 7M+) and Mark Manson (2.6M subs in two years, not 400k) — do not cleanly fit any case. *Resolution:* do not assign; watch the video.
14. **Identity linkage.** Hi5 editor (LinkedIn 961704190), Hudson Matter / MarkManson.net creative director (LinkedIn ba889b15a) and IMDb nm8022607 are linked to @JacobRBryant1 only circumstantially. *Resolution:* treat as probable but unconfirmed; the dossier keeps them in a separate "career background" block for that reason.
15. **Sourced vs unverified overlap.** Several unverified findings restate sourced episode facts as "prior" (e.g. chapter titles, the 2.5B bio). *Resolution:* the sourced version always governs; the unverified restatements add nothing and are not counted as corroboration.
16. **Test & Compare Help URLs.** Four different `support.google.com/youtube/answer/...` IDs appear across the unverified angles. *Resolution:* all are unverified; look up the current Help article rather than trusting any of them.

---

## 10. Design implications for the Channel Booster supersystem (ranked)

Each item names the finding it rests on and whether that finding is sourced or unverified.

1. **Packaging is the first gate; the system must produce title + thumbnail before anything else and treat "no clickable packaging" as a kill signal.** Sourced: the episode opener ("the reason your videos get no views has nothing to do with how good they are") [YouTube](https://www.youtube.com/watch?v=tuv_XPF6cH8); "Content vs Packaging" at 00:29 [Apple](https://podcasts.apple.com/in/podcast/1of10-podcast/id1870599992); 1of10's "if no one clicks it doesn't matter how good your video is ... Spend as much time planning these as you do your video" [1of10 TikTok](https://www.tiktok.com/@1of10media/video/7463482203373079841). Unverified: the packaging-first workflow and kill criteria (sections 4.5, 7.13, 7.6).
2. **Ideas must be evidence-selected from over-performing videos, not invented; build an outlier-research step with channel-relative scoring.** Sourced: 1of10's "Coming up with an 'original idea' off the top of your head is a waste of time ... study over performing videos" [1of10 TikTok](https://www.tiktok.com/@1of10media/video/7463482203373079841); Mike Shake's "not reinventing the wheel and starting with good ideas" [X](https://x.com/MikeshakeYT?lang=en). Unverified: the multiplier definition, thresholds (2x/5x/10x), recency windows and small-channel weighting (section 4.2-4.3).
3. **Design for the cold start explicitly: a "first upload" mode that assumes zero subscribers and optimizes for Browse/Suggested impression tests.** Sourced: the chapter "How to go from 500 views to 100k views on the first video" and the video's title [Apple](https://podcasts.apple.com/in/podcast/1of10-podcast/id1870599992), [YouTube](https://www.youtube.com/watch?v=tuv_XPF6cH8). Unverified: no new-channel sandbox, per-video judgment, waves of distribution, custom-thumbnail verification requirement (section 5.2).
4. **Fewer, better-packaged uploads over volume; the system should optimize per-upload quality, not cadence.** Sourced: Trech's "fewer, better-optimized uploads ... it's about uploading smarter" [Trech](https://www.trechmedia.com/). Unverified: upload frequency is not a ranking factor; one strong long-form per week (sections 5.2, 7.37).
5. **A thumbnail factory with a reusable "format", variants, feed-context preview and native A/B testing.** Sourced: Jake built "a completely new format" that others copied and that he treats as validated by copying [X](https://x.com/jacobrbryant1); the "Thumbnail breakdown" chapter [Apple](https://podcasts.apple.com/in/podcast/1of10-podcast/id1870599992); Mike Shake hires thumbnail designers [X](https://x.com/MikeshakeYT?lang=en). Unverified: the 31 factory rules in section 6, including Test & Compare mechanics.
6. **Support both clean and loud thumbnail styles and test rather than assume.** Sourced: the chapter asks whether "keeping thumbnails clean [is] a common strategy across all the channels" [Anchor RSS](https://anchor.fm/s/110bc6964/podcast/rss) — the question itself implies the answer is channel-dependent. Unverified: clean style is genre-dependent (section 6.11-6.12).
7. **Track returning-viewer loyalty as a first-class metric, not just views.** Sourced: TubeLab's description of his approach — "increasing loyal viewers who return to watch every upload" [TubeLab](https://tubelab.net/youtube-strategy). Unverified: returning-vs-new in the per-video dashboard (section 7.32).
8. **Story/retention must pay off the packaging; couple the thumbnail promise to the cold open and the beat sheet.** Sourced: Trech lists "storytelling" alongside titles and thumbnails [Trech](https://www.trechmedia.com/); the episode's film-background/storytelling chapter [Anchor RSS](https://anchor.fm/s/110bc6964/podcast/rss). Unverified: hook structure, 30-second/70% benchmark, clickbait penalty (sections 5.2, 7.19-7.28).
9. **Closed-loop analytics: 24-72h review with CTR-vs-median and AVD-vs-median, swap/repackage rules, and a post-mortem that feeds the next idea.** Sourced: nothing directly; Trech's "measurable improvements ... in less than 3 months" implies a measured loop [Trech](https://www.trechmedia.com/). Unverified: the entire loop (section 7.29-7.33).
10. **Model the strategist role the way the market prices it, and expose the "strategist" as a product persona.** Sourced: top advisors charge $15,000+/month; Jake is a top-5 YT Jobs strategist; Trech sells a free discovery call then bespoke work [CNBC](https://www.cnbc.com/2026/05/10/youtube-advisors-mrbeast-top-creators-platform-viewership.html), [X](https://x.com/JacobRBryant1/status/2084959034445066316), [Trech](https://www.trechmedia.com/). Unverified: rate ranges and team compositions (section 7.38).
11. **Build for creators and business owners alike, with goal-tailored strategy (views vs authority vs conversions).** Sourced: Trech's audience and "visibility, authority, and conversions" framing [Trech](https://www.trechmedia.com/).
12. **Respect creator identity when transplanting formats (remix, don't clone).** Sourced: Mike Shake's "Create your own identity and leverage it. Don't try to be someone else" [X](https://x.com/MikeshakeYT?lang=en). Unverified: "remix, don't copy" rule (section 4.3).
13. **Integrate with, or replicate, an outlier tool and a $1-trial funnel.** Sourced: 1of10 is "used by more than 10,000 channels" and offers a $1 trial [VidSummit](https://www.vidsummit.com/speakers-2025/richard-the-youtube-strategist), [Anchor RSS](https://anchor.fm/s/110bc6964/podcast/rss). Unverified: the feature list to match (section 4.4).
14. **Keep an evidence ledger in the product itself.** Justification: this dossier's own experience — three-quarters of what a system "knows" about YouTube strategy is unverified folklore; the supersystem should tag every rule with a source and a confidence so rules can be re-tested against the channel's actual data.

---

## 11. Open questions to confirm with the user or by watching the video

**Only answerable by watching tuv_XPF6cH8**
1. Video duration, full description, complete chapter list with timestamps, view count and comments (none were indexed).
2. Is the Sept 9 video the full-length edit of the July 29 audio, or a second recording? Does it contain the "thumbnail breakdown", "exact ideation process" and 23:39 "clean thumbnails" segments?
3. What does the thumbnail format he originated look like (composition, text, face/no-face, color), on which channel did it appear, and what before/after CTR does he cite?
4. Which channel went 0 -> 400,000 subscribers in 2 years; which channel does 100M monthly views; which entertainment channel got 23M views from packaging and what packaging change drove it?
5. Which channel and which packaging change produced the 500 -> 100k first-video jump, and what were its CTR/AVD numbers?
6. His "biggest mistake YouTubers make" in his own words, and whether he quantifies the packaging-vs-content effort split.
7. His exact ideation process: rubric, thresholds, whether he uses 1of10 outlier multipliers and at what cutoff.
8. What "working with Mike Shake" involved (timeframe, role, outcomes).
9. Who the "biggest creators he's worked with in LA" are (Hi5/Matthias network? Hudson Matter? Mark Manson?).
10. The storytelling lessons from his film background, and whether IMDb nm8022607 is him.
11. His answer on whether clean thumbnails are common across his channels.
12. Whether Richard personally conducted the interview.
13. Whether the video adds frameworks beyond the audio (title formula list, retention checkpoints, team SOP).

**Answerable by the user or by a fresh session with search budget**
14. Confirm the identity linkage between @JacobRBryant1, LinkedIn 961704190 (Hi5), LinkedIn ba889b15a (Hudson Matter / MarkManson.net) and IMDb nm8022607.
15. Locate the 1of10 blog transcript article for the episode (may exist under a title without his name).
16. Find the "Lots of creators stole my thumbnail format" post URL and date, and his AMA replies (including the AI-and-strategists question).
17. Trech Media's pricing/retainer model and which tools it uses (1of10, ViewStats, Spotter Studio, vidIQ, LLMs).
18. Where the "best of the best" testimonial actually lives.
19. Episode number in the catalog and the correct total episode count (93 vs 83).
20. Whether Jake appears in the Humble&Brag or Vidpros 2026 strategist lists.
21. Confirm every unverified platform fact in section 5: no-sandbox statements from YouTube in 2026; Test & Compare title-test GA status and current Help URLs; 2%-10% CTR guidance still current; Hype eligibility; Shorts 3-minute limit date; satisfaction-survey terminology; the Jan-Sept 2026 entries of the air.io / OutlierKit / Senswit / MediaCube trackers.
22. Confirm 1of10's exact outlier formula (median vs mean, baseline window, Shorts exclusion, capping), current pricing tiers, extension capabilities, and whether it publishes a named framework with numeric rules.
23. Confirm episode titles, dates and takeaways for guests Sam Gaudet and Jake Trinder, and the identity of the "YouTube genius who helped creators make 100M" guest.
24. Attribute the "3-element rule" and "safe/bold/wild" framing to a specific strategist; verify Spotter Studio launch/pricing and vidIQ tiers as of 2026; verify whether YouTube Studio offers native AI thumbnail generation and any AI-disclosure requirement.

**Product decisions for the user**
25. Should the Channel Booster supersystem treat the unverified rulebook (sections 4-7) as provisional defaults to be validated against channel data, or exclude anything unsourced until confirmed?
26. Is the target user a first-upload creator (the video's framing), an established channel, or a business owner (Trech's framing)? The cold-start module's priority depends on this.
