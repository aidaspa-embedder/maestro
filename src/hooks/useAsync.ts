import { useCallback, useEffect, useRef, useState } from "react";

export interface AsyncState<T> {
  data: T | undefined;
  loading: boolean;
  error: string | undefined;
}

/**
 * Runs an async task and tracks its state, discarding results from superseded
 * runs so a slow response can't overwrite a newer one.
 */
export function useAsync<T>(
  task: () => Promise<T>,
  deps: unknown[],
  opts: { enabled?: boolean; initial?: T } = {},
): AsyncState<T> & { reload: () => void } {
  const enabled = opts.enabled !== false;
  const [state, setState] = useState<AsyncState<T>>({
    data: opts.initial,
    loading: enabled,
    error: undefined,
  });

  const [nonce, setNonce] = useState(0);
  const runId = useRef(0);
  const taskRef = useRef(task);
  taskRef.current = task;

  useEffect(() => {
    if (!enabled) {
      ++runId.current;
      setState({ data: undefined, loading: false, error: undefined });
      return;
    }
    const id = ++runId.current;
    setState((s) => ({ ...s, loading: true, error: undefined }));

    taskRef.current().then(
      (data) => {
        if (id === runId.current) setState({ data, loading: false, error: undefined });
      },
      (err: unknown) => {
        if (id === runId.current) {
          setState({
            data: undefined,
            loading: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    );
    return () => { ++runId.current; };
    // Stale runs are ignored via runId rather than cancelled — fetch aborts
    // aren't worth the complexity for sub-second queries.
  }, [...deps, enabled, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, reload };
}
