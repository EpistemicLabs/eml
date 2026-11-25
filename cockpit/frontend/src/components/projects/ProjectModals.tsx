import { EyeOff, Trash2 } from 'lucide-react';

import ProjectCreationWizard from '@/components/project-creation-wizard';
import ProjectFolderDialog from '@/components/project-creation-wizard/ProjectFolderDialog';
import { Button, Dialog, DialogContent, DialogTitle } from '@/shared/view/ui';

import LinkProjectDialog from './LinkProjectDialog';
import type { ProjectActions } from './useProjectActions';

/** The project dialogs Plan opens: add a project, link a folder, link to a brain project, and the remove confirm. */
export function ProjectModals({ actions }: { actions: ProjectActions }) {
  const removing = actions.removing;
  const sessions = removing?.sessions?.length ?? 0;
  return (
    <>
      {actions.adding && <ProjectCreationWizard onClose={actions.endAdd} onProjectCreated={() => { actions.endAdd(); actions.refresh(); }} />}
      {actions.linking && <ProjectFolderDialog project={actions.linking} onClose={actions.endLink} onSaved={() => actions.refresh()} />}
      {actions.joining && <LinkProjectDialog project={actions.joining} onClose={actions.endJoin} onLinked={() => actions.refresh()} />}
      {removing && (
        // Escape or a click beside it cancels, never removes.
        <Dialog open onOpenChange={(open) => { if (!open) actions.cancelRemove(); }}>
          <DialogContent role="alertdialog" aria-labelledby="remove-project-title" className="overflow-hidden">
            <div className="flex flex-col gap-3 p-6">
              <DialogTitle id="remove-project-title" className="not-sr-only text-title font-semibold text-foreground">Remove folder from cockpit</DialogTitle>
              <p className="text-body text-muted-foreground">
                Are you sure you want to remove <span className="font-medium text-foreground">{removing.displayName || removing.projectId}</span> from the cockpit?
              </p>
              <p className="text-body text-muted-foreground">
                The folder on disk is never touched.
                {sessions > 0 && ` ${sessions} ${sessions === 1 ? 'session' : 'sessions'} will be stopped and forgotten.`}
              </p>
            </div>
            <div className="flex flex-col gap-2 border-t border-border p-4">
              <Button variant="outline" className="w-full justify-start" onClick={() => void actions.confirmRemove(false)}>
                <EyeOff />
                Remove from the cockpit (keep transcripts)
              </Button>
              <Button variant="destructive" className="w-full justify-start" onClick={() => void actions.confirmRemove(true)}>
                <Trash2 />
                Remove and delete its session transcripts
              </Button>
              <Button variant="ghost" className="w-full" onClick={actions.cancelRemove}>Cancel</Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
