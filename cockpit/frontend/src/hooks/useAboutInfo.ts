// Versions + the isolated config dir from the host (GET /api/about). Static
// for the host's lifetime, so one fetch is shared by every consumer
// (sidebar footer brand line, Settings › About).
import { useEffect, useState } from 'react';

import { api } from '@/utils/api';

export type AboutInfo = {
  version: string;
  runMode: 'dev' | 'prod';
  claudeVersion: string;
  configDir: string;
  node: string;
};

let cached: AboutInfo | null = null;
let inflight: Promise<AboutInfo> | null = null;

function loadAboutInfo(): Promise<AboutInfo> {
  if (cached) return Promise.resolve(cached);
  if (!inflight) {
    inflight = api.about()
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as AboutInfo;
      })
      .then((info) => { cached = info; return info; })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

export function useAboutInfo(): { info: AboutInfo | null; failed: boolean } {
  const [info, setInfo] = useState<AboutInfo | null>(cached);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (cached) return;
    let cancelled = false;
    loadAboutInfo()
      .then((data) => { if (!cancelled) setInfo(data); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, []);

  return { info, failed };
}
