/**
 * Browser bundle entry: the same deterministic engines the CLI uses,
 * exposed as a global so the single-file dashboard can call them.
 * Only modules free of node:* imports belong here.
 */
export { readVideoRows, parseCsv, parseCount, parseNumber, parseDuration, readStudioRows, ledgerReadFromRow, bucketFor } from '../src/csv.js'
export { computeOutliers, formatLift, median, detectFormats } from '../src/outliers.js'
export { topicKey, topicDemand, diffScans, saturation } from '../src/topics.js'
export { scoreIdea, parseIdeaScore, suggestDemand, resolveDemand, DEMAND_AUTO, IDEA_WEIGHTS, IDEA_AXIS_QUESTIONS } from '../src/ideas.js'
export { generateTitles, scoreTitle, titleThumbnailOverlap, tokens, TITLE_FORMULAS } from '../src/titles.js'
export { qaThumbnail, buildThumbnailBrief, renderImagePrompts, THUMBNAIL_RULES, THUMBNAIL_QA_CHECKLIST, THUMBNAIL_TEST_PLAN } from '../src/thumbnails.js'
export { checkSignature, describeSignature } from '../src/signature.js'
export { renderProofSheet } from '../src/proofsheet.js'
export { readImageMeta, checkThumbnailFile } from '../src/imagemeta.js'
export { checkPromise } from '../src/promise.js'
export { scoreHook, renderHookReport, parseScript, formatSec } from '../src/hook.js'
export { diagnose } from '../src/postmortem.js'
export { decide, describeDecision } from '../src/decide.js'
export { prepareRepackage, describeRepackage } from '../src/repackage.js'
export { assemblePublish, checkPublish, renderPublishMarkdown, renderPublishCheck } from '../src/publish.js'
export { judgeTest, renderJudgement, winnerLetter } from '../src/experiments.js'
export { generateWorkflow, renderWorkflowMarkdown, weeklyCadence, buildCalendar, governCalendar, WORKFLOW_FORMATS } from '../src/workflow.js'
export { baselineFrom, leverTally, ownOutliers, dueReads, mad, tierFor, renderLedgerMarkdown } from '../src/ledger-core.js'
export { thresholds, tagged, DEFAULT_THRESHOLDS } from '../src/thresholds.js'
export { BUCKET_HOURS, BUCKETS } from '../src/buckets.js'
