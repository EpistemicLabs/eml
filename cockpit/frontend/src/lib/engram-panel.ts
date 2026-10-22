import { createContext, useCallback, useContext } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";

// The engram detail lives in a right-side drawer driven by a `?engram=<id>` query
// param. Ported from packages/web/lib/engram-panel.ts, rewritten on react-router
// (was next/navigation) — the single router seam. All views consume useEngramPanel.
const PARAM = "engram";

export interface PanelSourceValue {
  source: string[] | null;
  setSource: (ids: string[] | null) => void;
}

export const PanelSourceContext = createContext<PanelSourceValue>({
  source: null,
  setSource: () => {},
});

function withEngram(pathname: string, params: URLSearchParams, id: string): string {
  const next = new URLSearchParams(params.toString());
  next.set(PARAM, id);
  const qs = next.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

function withoutEngram(pathname: string, params: URLSearchParams): string {
  const next = new URLSearchParams(params.toString());
  next.delete(PARAM);
  const qs = next.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

export function useEngramPanel() {
  const { pathname } = useLocation();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { source, setSource } = useContext(PanelSourceContext);

  const openedId = searchParams.get(PARAM);

  const hrefFor = useCallback(
    (id: string) => withEngram(pathname, searchParams, id),
    [pathname, searchParams],
  );

  const go = useCallback(
    (id: string) => navigate(withEngram(pathname, searchParams, id)),
    [pathname, searchParams, navigate],
  );

  const open = useCallback(
    (id: string, siblings: string[] | null = null) => {
      setSource(siblings);
      navigate(withEngram(pathname, searchParams, id));
    },
    [pathname, searchParams, navigate, setSource],
  );

  const close = useCallback(
    () => navigate(withoutEngram(pathname, searchParams)),
    [pathname, searchParams, navigate],
  );

  const back = useCallback(() => navigate(-1), [navigate]);

  return { openedId, hrefFor, go, open, close, back, source, setSource };
}
