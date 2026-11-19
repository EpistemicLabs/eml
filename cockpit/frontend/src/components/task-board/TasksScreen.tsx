// The Tasks top view: the task board, with the older views (Cycles, My tasks, Agents, Projects) one
// click away while the board proves itself in the live week.
import { useState } from 'react';

import TasksView from '@/components/tasks/TasksView';
import type { Project } from '@/types/app';

import { TaskBoard } from './TaskBoard';

export function TasksScreen({ projects }: { projects?: Project[] }) {
  const [classic, setClassic] = useState(false);
  if (!classic) return <TaskBoard onClassic={() => setClassic(true)} />;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <button type="button" onClick={() => setClassic(false)} className="self-start px-4 py-2 text-ui text-muted-foreground underline underline-offset-2 hover:text-foreground">
        ← Back to the task board
      </button>
      <TasksView projects={projects} />
    </div>
  );
}
