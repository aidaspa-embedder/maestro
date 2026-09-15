import { useCallback } from "react";
import { useRenderer } from "@opentui/react";

/**
 * Tears the renderer down before exiting. Calling process.exit() directly would
 * leave the terminal in the alternate screen with mouse tracking still on.
 */
export function useQuit(): () => void {
  const renderer = useRenderer();
  return useCallback(() => {
    try {
      renderer.destroy();
    } finally {
      process.exit(0);
    }
  }, [renderer]);
}
