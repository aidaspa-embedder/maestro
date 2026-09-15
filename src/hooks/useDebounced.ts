import { useEffect, useState } from "react";

/**
 * Trailing-edge debounce. Linear's search endpoint is capped at 30 req/min, so
 * every keystroke must not become a request.
 */
export function useDebounced<T>(value: T, delayMs = 250): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    if (value === debounced) return;
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);

  return debounced;
}
