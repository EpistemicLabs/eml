import { MessageSquare } from 'lucide-react';

import { spaceTone } from '@/lib/space-color';
import { paneSpaceKey } from '@/stores/useSpaceStore';
import { agentLabel } from '../../allSessions';
import type { SidebarController } from '../../useSidebarController';
import { SidebarGroupHeader, SidebarStateBlock } from './SidebarParts';
import { SidebarSessionRow } from './SidebarSessionRow';

export function SidebarConversations({ controller }: { controller: SidebarController }) {
  const { conversationGroups, sessionRename } = controller;

  if (conversationGroups.length === 0) {
    return <SidebarStateBlock icon={MessageSquare} text="No sessions yet" />;
  }

  return (
    <div className="space-y-3">
      {conversationGroups.map((group) => (
        <div key={group.label} className="space-y-0.5">
          <SidebarGroupHeader>{group.label}</SidebarGroupHeader>
          {group.entries.map(({ project, session }) => {
            // Under All spaces a row says whose it is, and opening it opens its space.
            const space = controller.allView ? controller.spaceOf(project) : null;
            return (
            <div key={`${project.projectId}:${session.id}`} className="px-px">
              <SidebarSessionRow
                session={session}
                projectId={project.projectId}
                isSelected={session.id === controller.selectedSessionId}
                now={controller.now}
                renameDraft={sessionRename?.id === session.id ? sessionRename.draft : null}
                onRenameDraftChange={controller.setSessionRenameDraft}
                onStartRename={controller.startSessionRename}
                onSaveRename={() => void controller.saveSessionRename()}
                onCancelRename={controller.cancelSessionRename}
                onSelect={(picked, projectId) =>
                  controller.selectSession(space ? { ...picked, __spaceKey: paneSpaceKey(space) } : picked, projectId)}
                agent={space ? { name: agentLabel(space), tone: spaceTone(space) } : undefined}
                onRequestDelete={controller.requestSessionDelete}
                pin={{
                  isPinned: controller.isSessionPinned(session),
                  onToggle: (target) => void controller.toggleSessionPin(target),
                }}
              />
            </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
