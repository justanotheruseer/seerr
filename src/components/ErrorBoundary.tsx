import React from 'react';

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error | null;
}

class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: Record<string, unknown>) {
    // Log to console for now — can be extended to POST to an endpoint
    // so server logs contain the client-side hydration error stack.
    // Keep this synchronous and minimal to avoid further failures.
    // eslint-disable-next-line no-console
    console.error('Client-side render error caught by ErrorBoundary', {
      error,
      info,
    });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-gray-900 text-white">
          <div className="max-w-lg p-6 text-center">
            <h2 className="mb-2 text-2xl font-bold">Something went wrong</h2>
            <p className="mb-4 text-sm">
              A client-side rendering error occurred. Check the browser console
              for details.
            </p>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
