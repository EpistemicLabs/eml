import type { StoredEngram } from '../types'
import type { TrackTaskInput } from '../engrams'
import { CommandError, assertBaseRev, checkBaseRev, inputObject, requireText, type CommandModule } from './types'

/** task.track — the /task/:id/track body plus the task's id; base_rev is an optional precondition (cockpit, sync; not MCP). */
export type TaskTrackInput = TrackTaskInput & { id: string, base_rev?: number }

/** task.track — everything that happens to an existing task. Was EngramStore.trackTask. */
export const taskTrack: CommandModule<TaskTrackInput, StoredEngram> = {
  name: 'task.track',
  validate(input) {
    const o = inputObject('task.track', input)
    requireText(o, 'id', 'Invalid engram: id is required (the task).')
    checkBaseRev(o)
    return o as unknown as TaskTrackInput
  },
  apply(ctx, input, stamp) {
    const { id, base_rev, ...track } = input
    assertBaseRev(ctx, id, base_rev)
    const r = ctx.engrams.trackTask(id, track, stamp)
    if (!r) throw new CommandError('NOT_FOUND', 'task not found')
    return r
  },
}
