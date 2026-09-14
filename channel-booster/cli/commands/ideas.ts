/** Commands: idea. */
import { IDEA_AXIS_QUESTIONS, parseIdeaScore, scoreIdea } from '../../src/ideas.js'
import { out, str, type CommandModule } from '../shared.js'

export const ideasModule: CommandModule = {
  verbs: ['idea'],
  help: [
    'idea questions                                                     the six scorecard questions',
    'idea score "<idea>" --score "demand=4,packaging=3,fit=..."         verdict + fixes',
  ],
  async run(_cmd, sub, rest, flags) {
    if (sub === 'questions') {
      out(IDEA_AXIS_QUESTIONS, flags, () => Object.entries(IDEA_AXIS_QUESTIONS).map(([k, v]) => `${k.padEnd(12)} ${v}`).join('\n'))
      return 0
    }
    if (sub === 'score') {
      const idea = rest[0] ?? '(untitled idea)'
      const scoreText = str(flags, 'score')
      if (!scoreText) throw new Error('usage: booster idea score "<idea>" --score "demand=4,packaging=3,fit=4,angle=3,payoff=4,feasibility=5"')
      const verdict = scoreIdea(parseIdeaScore(scoreText))
      out({ idea, ...verdict }, flags, () => [
        `Idea: ${idea}`,
        `Total ${verdict.total}/100 · verdict ${verdict.verdict.toUpperCase()}`,
        ...Object.entries(verdict.score).map(([k, v]) => `  ${k.padEnd(12)} ${'█'.repeat(v)}${'·'.repeat(5 - v)} ${v}/5`),
        ...(verdict.fixes.length ? ['', 'Fix first:', ...verdict.fixes.map((f) => `  - ${f}`)] : ['', 'No axis below 3. Move it to the packaging sprint.']),
      ].join('\n'))
      return 0
    }
    throw new Error('usage: booster idea questions | booster idea score "<idea>" --score ...')
  },
}
