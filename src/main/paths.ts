import os from 'node:os'
import path from 'node:path'

// Deliberately imports nothing from ./main: both store.ts and log.ts need the
// data root, and log.ts must stay below store.ts in the module graph.

/** The data root every workspace, task, and log lives under. `GURT_ROOT`
 *  overrides the default `~/.gurt`. */
export const gurtRoot = process.env['GURT_ROOT'] || path.join(os.homedir(), '.gurt')
