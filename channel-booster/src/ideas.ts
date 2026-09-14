import type { IdeaScore, IdeaVerdict } from './types.js'

/**
 * Axis weights. Demand and packaging carry half the score on purpose:
 * a video nobody is looking for, or one you cannot package, is not an idea yet.
 */
export const IDEA_WEIGHTS: Record<keyof IdeaScore, number> = {
  demand: 0.25,
  packaging: 0.25,
  fit: 0.15,
  angle: 0.15,
  payoff: 0.1,
  feasibility: 0.1,
}

const AXIS_FIX: Record<keyof IdeaScore, string> = {
  demand: 'Demand is unproven. Find 3 outliers (>=5x channel median) on this topic in adjacent channels, or 3 audience comments asking for it, before spending a day on it.',
  packaging: 'You cannot see the thumbnail yet. Write 10 titles and sketch 3 thumbnail concepts now; if none makes you want to click, change the angle, not the topic.',
  fit: 'Wrong viewer. Ask who watched your last 5 videos and whether this is the next thing they would click; if not, reframe it for them or park it for a second channel.',
  angle: 'It is a clone. Add a twist the outlier did not have: a constraint, a stake, a contrast, a first-person test, or a contrarian claim.',
  payoff: 'The promise is bigger than the delivery. Decide what the viewer gets in the first 60 seconds and what they only get at the end, then check the title still tells the truth.',
  feasibility: 'Too expensive for the expected return. Cut scope to the version you can ship in the normal cycle, or bank it as a tentpole with its own timeline.',
}

function clamp05(value: number): number {
  if (Number.isNaN(value)) return 0
  return Math.max(0, Math.min(5, value))
}

/** Score an idea on the six axes and return a verdict with concrete fixes. */
export function scoreIdea(score: IdeaScore): IdeaVerdict {
  const clean: IdeaScore = {
    demand: clamp05(score.demand),
    packaging: clamp05(score.packaging),
    fit: clamp05(score.fit),
    angle: clamp05(score.angle),
    payoff: clamp05(score.payoff),
    feasibility: clamp05(score.feasibility),
  }
  const axes = Object.keys(IDEA_WEIGHTS) as Array<keyof IdeaScore>
  const total = Math.round(axes.reduce((sum, axis) => sum + (clean[axis] / 5) * IDEA_WEIGHTS[axis], 0) * 100)

  let verdict: IdeaVerdict['verdict'] = total >= 75 ? 'green' : total >= 55 ? 'yellow' : 'red'
  // Hard gates: no amount of feasibility rescues an idea with no demand or no packaging.
  if (clean.demand <= 1 || clean.packaging <= 1) verdict = 'red'
  else if (axes.some((axis) => clean[axis] <= 1) && verdict === 'green') verdict = 'yellow'

  const fixes = axes
    .filter((axis) => clean[axis] <= 2)
    .sort((a, b) => clean[a] - clean[b] || IDEA_WEIGHTS[b] - IDEA_WEIGHTS[a])
    .map((axis) => AXIS_FIX[axis])

  return { score: clean, total, verdict, fixes }
}

/** Parse "demand=4,packaging=3,..." or "4,3,5,2,4,3" into an IdeaScore. */
export function parseIdeaScore(input: string): IdeaScore {
  const axes = Object.keys(IDEA_WEIGHTS) as Array<keyof IdeaScore>
  const score: IdeaScore = { demand: 0, packaging: 0, fit: 0, angle: 0, payoff: 0, feasibility: 0 }
  const parts = input.split(/[,\s]+/).filter(Boolean)
  const named = parts.every((p) => p.includes('='))
  if (named) {
    for (const part of parts) {
      const [key, value] = part.split('=')
      const axis = axes.find((a) => a === key.trim().toLowerCase())
      if (!axis) throw new Error(`Unknown axis "${key}". Use: ${axes.join(', ')}`)
      score[axis] = Number.parseFloat(value)
    }
    return score
  }
  if (parts.length !== axes.length) {
    throw new Error(`Give ${axes.length} numbers in order (${axes.join(', ')}) or name them like demand=4`)
  }
  axes.forEach((axis, i) => {
    score[axis] = Number.parseFloat(parts[i])
  })
  return score
}

/** The questions a strategist answers to fill each axis. Used by the CLI and the skills. */
export const IDEA_AXIS_QUESTIONS: Record<keyof IdeaScore, string> = {
  demand: 'How many outliers, search results, or explicit audience requests prove people already want this? (0 none, 5 multiple 10x outliers in the last 90 days)',
  packaging: 'Can you already see a thumbnail and title that a stranger would click? (0 no image, 5 the thumbnail is obvious and the title writes itself)',
  fit: 'Would the exact viewer of your last three videos click this next? (0 different audience, 5 same viewer, same need)',
  angle: 'What does your version have that the winning videos do not? (0 straight copy, 5 a twist that makes the original look incomplete)',
  payoff: 'Can the video deliver the promise early and keep paying it off? (0 promise bigger than delivery, 5 payoff in 60s and escalating)',
  feasibility: 'Can you ship it at the quality bar inside a normal production cycle? (0 needs a crew and a month, 5 ship this week)',
}
