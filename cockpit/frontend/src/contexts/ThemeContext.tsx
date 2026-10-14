// Appearance preference (System / Light / Dark): stored under `themeMode`,
// resolved against the OS colour scheme, and applied as the `dark` class on
// <html>. index.html's pre-paint script resolves the same way, so the first
// render matches what is already on screen.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type ThemeMode = 'system' | 'light' | 'dark';

interface ThemeContextValue {
  isDarkMode: boolean;
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
  toggleDarkMode: () => void;
}

const STORAGE_KEY = 'themeMode';
const DARK_QUERY = '(prefers-color-scheme: dark)';

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStoredMode(): ThemeMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'system' || stored === 'light' || stored === 'dark') return stored;
  } catch {
    // Storage unavailable: fall through to the default.
  }
  return 'system';
}

function readSystemDark(): boolean {
  if (typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(DARK_QUERY).matches;
}

const resolveDark = (mode: ThemeMode, systemDark: boolean): boolean =>
  mode === 'system' ? systemDark : mode === 'dark';

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [themeMode, setThemeModeState] = useState<ThemeMode>(readStoredMode);
  const [systemDark, setSystemDark] = useState<boolean>(readSystemDark);

  const isDarkMode = resolveDark(themeMode, systemDark);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(DARK_QUERY);
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, themeMode);
    } catch {
      // Not persisted; the in-memory preference still applies.
    }
  }, [themeMode]);

  // Layout effect: children's effects (terminal recolouring) read the class
  // and CSS variables and must already see the new palette.
  useLayoutEffect(() => {
    document.documentElement.classList.toggle('dark', isDarkMode);
  }, [isDarkMode]);

  const setThemeMode = useCallback((mode: ThemeMode) => {
    setThemeModeState(mode);
  }, []);

  const toggleDarkMode = useCallback(() => {
    setThemeModeState((current) => (resolveDark(current, systemDark) ? 'light' : 'dark'));
  }, [systemDark]);

  const value = useMemo<ThemeContextValue>(
    () => ({ isDarkMode, themeMode, setThemeMode, toggleDarkMode }),
    [isDarkMode, themeMode, setThemeMode, toggleDarkMode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}
