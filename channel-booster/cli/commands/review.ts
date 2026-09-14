/** Commands: postmortem. */
import { diagnose } from '../../src/postmortem.js'
import { num, out, type CommandModule } from '../shared.js'

export const reviewModule: CommandModule = {
  verbs: ['postmortem'],
  help: [
    'postmortem --ctr 4.2 [--impressions N] [--avp 38] [--avd-sec ..] [--duration-sec ..] [--retention30 ..] [--hours 48] [--baseline-ctr ..] [--baseline-avp ..] [--baseline-views ..]',
  ],
  async run(_cmd, _sub, _rest, flags) {
    const d = diagnose({
      impressions: num(flags, 'impressions'),
      ctr: num(flags, 'ctr'),
      views: num(flags, 'views'),
      avdSec: num(flags, 'avd-sec'),
      durationSec: num(flags, 'duration-sec'),
      avpPct: num(flags, 'avp'),
      retention30sPct: num(flags, 'retention30'),
      hoursSincePublish: num(flags, 'hours'),
      baseline: { ctr: num(flags, 'baseline-ctr'), avpPct: num(flags, 'baseline-avp'), views: num(flags, 'baseline-views') },
    })
    out(d, flags, () => [`Bottleneck: ${d.bottleneck.toUpperCase()}${d.repackage ? ' · REPACKAGE NOW' : ''}`, d.headline, '', ...d.evidence.map((e) => `  · ${e}`), '', 'Do this:', ...d.actions.map((a) => `  - ${a}`), ...(d.thresholdsUsed.length ? ['', `Thresholds: ${d.thresholdsUsed.join(' · ')}`] : [])].join('\n'))
    return 0
  },
}
