import TerminalPane from '../../shell/view/TerminalPane';

interface StandaloneShellProps {
  paneId?: string | null;
  projectId?: string | null;
  sessionId?: string | null;
  sessionTitle?: string | null;
  /** First prompt for a freshly spawned session. */
  command?: string | null;
  isActive?: boolean;
  autoConnect?: boolean;
  /** Outside the desks (the review screen): the session's space. */
  spaceId?: string | null;
}

/** The terminal pane body: an agent CLI session running in a host PTY. */
export default function StandaloneShell({
  paneId = null,
  projectId = null,
  sessionId = null,
  sessionTitle = null,
  command = null,
  isActive = true,
  autoConnect = true,
  spaceId,
}: StandaloneShellProps) {
  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <TerminalPane
        paneId={paneId}
        projectId={projectId}
        sessionId={sessionId}
        sessionTitle={sessionTitle}
        initialCommand={command}
        isActive={isActive}
        autoConnect={autoConnect}
        spaceId={spaceId}
      />
    </div>
  );
}
