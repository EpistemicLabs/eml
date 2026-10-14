import { useShellRuntime } from '../hooks/useShellRuntime';
import ShellOverlay from './subcomponents/ShellOverlay';
import TerminalSearchBar from './subcomponents/TerminalSearchBar';

interface TerminalPaneProps {
  paneId: string | null;
  projectId: string | null;
  sessionId: string | null;
  sessionTitle: string | null;
  initialCommand: string | null;
  isActive: boolean;
  autoConnect: boolean;
}

export default function TerminalPane({ sessionTitle, ...runtimeOptions }: TerminalPaneProps) {
  const { containerRef, overlay, connect, search } = useShellRuntime(runtimeOptions);

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="relative min-h-0 flex-1 overflow-hidden p-2">
        <div ref={containerRef} className="h-full w-full outline-none focus:outline-none" />
        {search.open && !overlay && <TerminalSearchBar search={search} />}
        {overlay && <ShellOverlay state={overlay} sessionTitle={sessionTitle} onConnect={() => void connect()} />}
      </div>
    </div>
  );
}
