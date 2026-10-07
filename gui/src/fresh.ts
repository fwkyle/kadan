import { useEffect } from "react";

// 화면 모션(2026-10-07 [kyle]): 바뀐 줄만 한 번 깜빡인다. 줄마다 data-fresh="<정체>:<상태>"를 달면, 같은 화면에서
// 직전에 없던 값이 나타날 때(새 줄·상태가 바뀐 줄) 그 줄에 is-fresh를 붙인다. 화면마다 비교 코드를 따로 두지 않으려고
// 한 곳에서 본다. 화면을 처음 열 때와 필터를 바꿔 한꺼번에 많이 바뀔 때(MAX 초과)는 깜빡이지 않는다.
const MAX = 6;
export function useFreshMarks(view: string, rootId = "main-content") {
  useEffect(() => {
    const root = document.getElementById(rootId);
    if (!root) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let seen: Set<string> | null = null, frame = 0;
    const scan = () => {
      frame = 0;
      const els = [...root.querySelectorAll<HTMLElement>("[data-fresh]")];
      if (!els.length) return;
      if (seen && !reduced.matches) {
        const before = seen, fresh = els.filter((el) => !before.has(el.dataset.fresh!));
        if (fresh.length <= MAX) for (const el of fresh) {
          el.classList.remove("is-fresh");
          void el.offsetWidth; // 같은 줄이 다시 바뀌어도 처음부터 다시 깜빡이게
          el.classList.add("is-fresh");
          el.addEventListener("animationend", () => el.classList.remove("is-fresh"), { once: true });
        }
      }
      seen = new Set([...(seen ?? []), ...els.map((el) => el.dataset.fresh!)]);
    };
    const observer = new MutationObserver(() => { if (!frame) frame = requestAnimationFrame(scan); });
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-fresh"] });
    scan();
    return () => { observer.disconnect(); if (frame) cancelAnimationFrame(frame); };
  }, [view, rootId]);
}
