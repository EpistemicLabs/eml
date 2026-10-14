// A plain mark per agent CLI — the asterisk for Claude
// Code, a hexagon for Codex.
import type { LLMProvider } from '@/types/app';

type SessionProviderLogoProps = {
  provider?: LLMProvider;
  className?: string;
};

export default function SessionProviderLogo({ provider = 'claude', className = 'h-3 w-3' }: SessionProviderLogoProps) {
  if (provider === 'codex') {
    return (
      <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round" aria-hidden>
        <title>Codex</title>
        <path d="M12 2.8l8 4.6v9.2l-8 4.6-8-4.6V7.4z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M12 2.5l1.6 6.1 5.4-3.3-3.3 5.4 6.1 1.6-6.1 1.6 3.3 5.4-5.4-3.3L12 21.5l-1.6-6.1-5.4 3.3 3.3-5.4-6.1-1.6 6.1-1.6-3.3-5.4 5.4 3.3z" />
    </svg>
  );
}
