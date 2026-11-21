import { Edit3, Eye, EyeOff, FolderPlus, Pin, Trash2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { Project } from '@/types/app';
import { SidebarIconAction } from './SidebarParts';

function folderTitle(project: Project): string {
  const hasPath = Boolean(project.fullPath);
  const userLinked = project.folderKind === 'user' || (project.folderKind === undefined && hasPath);
  if (userLinked) return 'Change folder';
  if (hasPath) return 'Runs in a cockpit folder — link your own folder…';
  return 'No folder linked yet — link a folder…';
}

export function SidebarProjectActions({
  project,
  onToggleStar,
  onStartRename,
  onSetFolder,
  onToggleHidden,
  onRequestRemove,
}: {
  project: Project;
  onToggleStar: (project: Project) => void;
  onStartRename: (project: Project) => void;
  onSetFolder: (project: Project) => void;
  onToggleHidden: (project: Project) => void;
  onRequestRemove: (project: Project) => void;
}) {
  const isBrain = project.kind === 'brain';
  const starred = Boolean(project.isStarred);

  return (
    <>
      <SidebarIconAction title={starred ? 'Unpin project' : 'Pin project'} onActivate={() => onToggleStar(project)}>
        <Pin
          className={cn(
            'size-3 text-muted-foreground',
            starred && 'fill-muted-foreground',
          )}
        />
      </SidebarIconAction>
      <SidebarIconAction title="Rename project" onActivate={() => onStartRename(project)}>
        <Edit3 className="size-3 text-muted-foreground" />
      </SidebarIconAction>
      {isBrain && (
        <SidebarIconAction title={folderTitle(project)} onActivate={() => onSetFolder(project)}>
          <FolderPlus className={cn('size-3', project.fullPath ? 'text-muted-foreground' : 'text-foreground')} />
        </SidebarIconAction>
      )}
      {isBrain ? (
        <SidebarIconAction
          title={project.hidden ? 'Show project' : 'Hide project'}
          onActivate={() => onToggleHidden(project)}
        >
          {project.hidden ? (
            <Eye className="size-3 text-muted-foreground" />
          ) : (
            <EyeOff className="size-3 text-muted-foreground" />
          )}
        </SidebarIconAction>
      ) : (
        <SidebarIconAction
          title="Remove folder from cockpit"
          onActivate={() => onRequestRemove(project)}
        >
          <Trash2 className="size-3 text-foreground" />
        </SidebarIconAction>
      )}
    </>
  );
}
