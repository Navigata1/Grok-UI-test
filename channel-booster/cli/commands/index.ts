/** Every command module, in help order. Add a module here when its file lands. */
import type { CommandModule } from '../shared.js'
import { scanModule } from './scan.js'
import { ideasModule } from './ideas.js'
import { packageModule } from './package.js'
import { workflowModule } from './workflow.js'
import { reviewModule } from './review.js'
import { dataModule } from './data.js'
import { publishModule } from './publish.js'
import { aiModule } from './ai.js'
import { directionModule } from './direction.js'
import { learnModule } from './learn.js'

export const MODULES: CommandModule[] = [dataModule, scanModule, ideasModule, packageModule, workflowModule, directionModule, publishModule, reviewModule, learnModule, aiModule]
