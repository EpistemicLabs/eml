import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router";
import "@xterm/xterm/css/xterm.css";
import "./index.css";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { PanelSourceContext } from "@/lib/engram-panel";
import { App } from "@/App";
import { FirstRunGate } from "@/components/first-run/FirstRun";
import { SingleWindowGate } from "@/components/app/SingleWindowGate";
import { installSpaceHeader } from "@/lib/space-fetch";

// Every host request names the active brain space (lib/space-fetch.ts).
installSpaceHeader();

const queryClient = new QueryClient({
  defaultOptions: {
    // Same defaults as packages/web's Providers — the brain views were
    // written against them (30s freshness, no refetch storms on focus).
    queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 },
  },
});

function Root() {
  const [source, setSource] = useState<string[] | null>(null);
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <PanelSourceContext.Provider value={{ source, setSource }}>
            <FirstRunGate>
              <SingleWindowGate>
                <App />
              </SingleWindowGate>
            </FirstRunGate>
          </PanelSourceContext.Provider>
        </BrowserRouter>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
