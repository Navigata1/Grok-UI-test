/**
 * Optional data adapter (architecture 2.19): the shape of a YouTube Analytics
 * API reader for the creator's OWN channel. Interface only; no implementation
 * ships in this repo.
 *
 * Why credentials must stay out of the repo: the Analytics API only serves a
 * channel's private numbers (impressions, CTR, retention, traffic sources)
 * to an OAuth 2.0 token granted by that channel's owner. That token, and the
 * client secret used to obtain it, are as sensitive as the Studio login:
 * anyone holding them can read every private metric of the channel, and a
 * refresh token does not expire on its own. The repo is shared with agents,
 * reviewers and CI, so a committed secret is a leaked secret. The sanctioned
 * path is: an implementation of `AnalyticsReader` lives outside this module
 * (or reads tokens from the environment or the OS keychain at run time),
 * the CLI receives it by injection, and the default is
 * `NotConfiguredAnalyticsReader`, which fails with instructions instead of
 * quietly returning nothing. Until then the primary path stays a Studio
 * export dropped in `inbox/` plus the four numbers typed in the Desk.
 *
 * The public-data adapter (`youtube-data.ts`) needs only an API key and is
 * a separate concern: an API key reads public counts, an OAuth token reads
 * the owner's private funnel.
 */
import type { VideoMetrics } from '../types.js'

/** The date window a metrics read covers. ISO dates ("2026-09-01") or timestamps; inclusive of both ends. */
export interface MetricsWindow {
  since: string
  until: string
}

/** One read of a video's private metrics over a window. */
export interface VideoMetricsRead {
  videoId: string
  window: MetricsWindow
  /** Whatever the API returned; absent fields were not requested or not available. */
  metrics: VideoMetrics
  /** Retention at 30 s as a percentage of viewers still watching, when the API serves it. */
  retention30sPct?: number
  /** Share of views from returning viewers, when the API serves it. */
  returningPct?: number
  /** Share of impressions from Browse plus Suggested, when the API serves it. */
  browseSuggestedPct?: number
  /** When the read was taken (ISO-8601), so the caller can bucket it with `bucketFor()` in src/csv.ts. */
  fetchedAt: string
}

/**
 * A reader of the creator's own channel metrics behind OAuth. Implementations
 * are injected; the repo ships only `NotConfiguredAnalyticsReader`.
 */
export interface AnalyticsReader {
  /** Fetch a video's metrics over `window`. Rejects with a helpful error when the reader has no credentials. */
  fetchVideoMetrics(videoId: string, window: MetricsWindow): Promise<VideoMetricsRead>
}

/** Thrown by `NotConfiguredAnalyticsReader`: the Analytics adapter has no OAuth credentials. */
export class AnalyticsNotConfiguredError extends Error {
  constructor(videoId: string) {
    super(
      `Analytics reader is not configured, so metrics for video "${videoId}" cannot be fetched. ` +
        'The YouTube Analytics API needs an OAuth 2.0 grant from the channel owner (scope yt-analytics.readonly), ' +
        'which this repo must never hold. Either inject an AnalyticsReader that reads its token from the environment ' +
        'or OS keychain at run time, or use the primary path: export from YouTube Studio into inbox/ and type the ' +
        '48 h and 7 d numbers into the Desk.',
    )
    this.name = 'AnalyticsNotConfiguredError'
  }
}

/**
 * The default reader: every call rejects with `AnalyticsNotConfiguredError`
 * explaining the OAuth requirement and the Studio-export alternative. The CLI
 * uses it so "not configured" is a loud, explained failure rather than a
 * silent empty read.
 */
export class NotConfiguredAnalyticsReader implements AnalyticsReader {
  /** Always rejects; see the class comment. */
  fetchVideoMetrics(videoId: string, _window: MetricsWindow): Promise<VideoMetricsRead> {
    return Promise.reject(new AnalyticsNotConfiguredError(videoId))
  }
}
