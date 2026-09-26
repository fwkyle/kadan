import { useCallback } from "react";
import type { UIEvent } from "react";
const positions = new Map<string, { top: number; left: number }>();
// Preserve local pane positions when returning from another screen. No global scroll or focus changes.
export function usePaneScroll(key: string) {
  const ref = useCallback(
    (element: HTMLElement | null) => {
      if (!element) return;
      const saved = positions.get(key);
      element.scrollTop = saved?.top || 0;
      element.scrollLeft = saved?.left || 0;
    },
    [key],
  );
  const onScroll = useCallback(
    (event: UIEvent<HTMLElement>) => {
      positions.delete(key);
      positions.set(key, {
        top: event.currentTarget.scrollTop,
        left: event.currentTarget.scrollLeft,
      });
      while (positions.size > 64)
        positions.delete(positions.keys().next().value!);
    },
    [key],
  );
  return { ref, onScroll };
}
