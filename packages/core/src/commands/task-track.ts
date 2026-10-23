import type { StoredEngram } from '../types'
import type { TrackTaskInput } from '../engrams'
import { CommandError, inputObject, requireText, type CommandModule } from './types'

/** task.track — the /task/:id/track body plus the task's id. */
export type TaskTrackInput = TrackTaskInput & { id: string }

/** task.track — everything that happens to an existing task. Was EngramStore.trackTask. */
export const taskTrack: CommandModule<TaskTrackInput, StoredEngram> = {
  name: 'task.track',
  validate(input) {
    const o = inputObject('task.track', input)
    requireText(o, 'id', 'Invalid engram: id is required (the task).')
    return o as unknown as TaskTrackInput
  },
  apply(ctx, input, stamp) {
    const { id, ...track } = input
    const r = ctx.engrams.trackTask(id, track, stamp)
    if (!r) throw new CommandError('NOT_FOUND', 'task not found')
    return r
  },
}
