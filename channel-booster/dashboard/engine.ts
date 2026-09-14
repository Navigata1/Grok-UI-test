/**
 * Browser bundle entry: the same deterministic engines the CLI uses,
 * exposed as a global so the single-file dashboard can call them.
 */
export { readVideoRows, parseCsv } from '../src/csv.js'
export { computeOutliers, formatLift, median, detectFormats } from '../src/outliers.js'
export { scoreIdea, IDEA_WEIGHTS, IDEA_AXIS_QUESTIONS } from '../src/ideas.js'
export { generateTitles, scoreTitle, titleThumbnailOverlap, TITLE_FORMULAS } from '../src/titles.js'
export { qaThumbnail, buildThumbnailBrief, THUMBNAIL_RULES, THUMBNAIL_QA_CHECKLIST, THUMBNAIL_TEST_PLAN } from '../src/thumbnails.js'
export { diagnose } from '../src/postmortem.js'
export { generateWorkflow, renderWorkflowMarkdown, weeklyCadence, buildCalendar, WORKFLOW_FORMATS } from '../src/workflow.js'
