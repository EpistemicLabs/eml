import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, EyeOff, Trash2 } from 'lucide-react';

import ProjectCreationWizard from '@/components/project-creation-wizard';
import { Button } from '@/shared/view/ui';
import type { SidebarController } from '../../useSidebarController';

function ConfirmShell({ title, body, footer }: { title: string; body: ReactNode; footer: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
        <div className="p-6">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-muted dark:bg-foreground/10">
              <AlertTriangle className="h-6 w-6 text-foreground" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="mb-2 text-lg font-semibold text-foreground">{title}</h3>
              {body}
            </div>
          </div>
        </div>
        <div className="border-t border-border bg-muted/30 p-4">{footer}</div>
      </div>
    </div>
  );
}

function RemoveProjectConfirm({ controller }: { controller: SidebarController }) {
  const pending = controller.pendingProjectDelete;
  if (!pending) return null;
  const { project, sessionCount } = pending;
  return (
    <ConfirmShell
      title="Remove folder from cockpit"
      body={
        <>
          <p className="text-sm text-muted-foreground">
            Are you sure you want to remove{' '}
            <span className="font-medium text-foreground">{project.displayName || project.projectId}</span> from the
            cockpit?
          </p>
          <p className="mt-3 text-sm text-muted-foreground">
            The folder on disk is never touched.
            {sessionCount > 0 &&
              ` ${sessionCount} ${sessionCount === 1 ? 'session' : 'sessions'} will be stopped and forgotten.`}
          </p>
        </>
      }
      footer={
        <div className="flex flex-col gap-2">
          <Button variant="outline" className="w-full justify-start" onClick={() => void controller.confirmProjectDelete(false)}>
            <EyeOff />
            Remove from sidebar (keep transcripts)
          </Button>
          <Button
            variant="destructive"
            className="w-full justify-start"
            onClick={() => void controller.confirmProjectDelete(true)}
          >
            <Trash2 />
            Remove and delete its session transcripts
          </Button>
          <Button variant="ghost" className="w-full" onClick={controller.cancelProjectDelete}>
            Cancel
          </Button>
        </div>
      }
    />
  );
}

function DeleteSessionConfirm({ controller }: { controller: SidebarController }) {
  const pending = controller.pendingSessionDelete;
  if (!pending) return null;
  return (
    <ConfirmShell
      title="Delete session"
      body={
        <>
          <p className="text-sm text-muted-foreground">
            Are you sure you want to delete <span className="font-medium text-foreground">{pending.title}</span>?
          </p>
          <p className="mt-3 text-xs text-muted-foreground">
            This stops the session and deletes its transcript. It cannot be undone.
          </p>
        </>
      }
      footer={
        <div className="flex gap-3">
          <Button variant="outline" className="flex-1" onClick={controller.cancelSessionDelete}>
            Cancel
          </Button>
          <Button variant="destructive" className="flex-1" onClick={() => void controller.confirmSessionDelete()}>
            <Trash2 />
            Delete
          </Button>
        </div>
      }
    />
  );
}

export function SidebarModals({ controller }: { controller: SidebarController }) {
  if (typeof document === 'undefined') return null;
  return createPortal(
    <>
      {controller.wizardOpen && (
        <ProjectCreationWizard onClose={controller.closeWizard} onProjectCreated={controller.handleProjectCreated} />
      )}
      <RemoveProjectConfirm controller={controller} />
      <DeleteSessionConfirm controller={controller} />
    </>,
    document.body,
  );
}
