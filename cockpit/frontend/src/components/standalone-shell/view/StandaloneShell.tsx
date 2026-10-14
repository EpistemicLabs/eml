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
      />
    </div>
  );
}
