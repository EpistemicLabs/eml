// Error boundary for a content pane: swaps the pane for a compact retry card
// when a descendant throws during render. Hand-rolled class boundary so the
// non-error path renders children with no extra DOM.
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { CircleX } from 'lucide-react';

import { Button } from '@/shared/view/ui';

type ErrorBoundaryProps = {
  children: ReactNode;
  /** Include an expandable "Error Details" disclosure in the fallback. */
  showDetails?: boolean;
  /** Called whenever the boundary resets (retry button or reset-key change). */
  onRetry?: () => void;
  /** Changing these (element-wise) while in the error state resets the boundary. */
  resetKeys?: unknown[];
};

type ErrorBoundaryState = {
  error: unknown;
  hasError: boolean;
  componentStack: string | null;
};

const LOG_PREFIX = '[ErrorBoundary] caught a render error:';

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  try {
    return String(error);
  } catch {
    return 'Unknown error';
  }
}

function sameKeys(a: unknown[] | undefined, b: unknown[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((value, index) => Object.is(value, b[index]));
}

export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, hasError: false, componentStack: null };

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return { error, hasError: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(LOG_PREFIX, error, info);
    this.setState({ componentStack: info.componentStack ?? null });
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    if (this.state.hasError && !sameKeys(prevProps.resetKeys, this.props.resetKeys)) {
      this.reset();
    }
  }

  reset = (): void => {
    this.setState({ error: null, hasError: false, componentStack: null });
    this.props.onRetry?.();
  };

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;

    const { showDetails = false } = this.props;
    const { error, componentStack } = this.state;

    return (
      <div data-ui="v2" className="flex h-full w-full flex-1 items-center justify-center p-8 text-center">
        <div className="w-full max-w-md rounded-xl border border-border bg-muted p-6">
          <div className="flex items-center justify-center gap-2">
            <CircleX className="size-4 shrink-0 text-foreground" aria-hidden="true" />
            <h2 className="text-heading font-semibold text-foreground">Something went wrong</h2>
          </div>

          <p className="mt-2 text-body text-foreground">An error occurred while rendering this pane.</p>

          {showDetails && (
            <details className="mt-3 text-left">
              <summary className="cursor-pointer text-ui text-foreground">Error Details</summary>
              <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-background p-2 font-code text-caption whitespace-pre-wrap text-foreground">
                {describeError(error)}
                {componentStack ?? ''}
              </pre>
            </details>
          )}

          <Button onClick={this.reset} className="mt-4">
            Try Again
          </Button>
        </div>
      </div>
    );
  }
}
