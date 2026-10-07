// 테마: 자동·어둡게·밝게, 그리고 우주(2026-10-07 [kyle]). 우주는 어둡게 색 위에 별 배경·관제 패널을 얹는 표시(data-skin)다.
export type Theme = "auto" | "dark" | "light" | "space";
export const THEME_ORDER: Theme[] = ["auto", "dark", "light", "space"];
export const THEME_LABEL: Record<Theme, string> = { auto: "자동", dark: "어둡게", light: "밝게", space: "우주" };
export function readTheme(): Theme {
  try {
    const value = localStorage.getItem("kadan-theme");
    if (value === "dark" || value === "light" || value === "space") return value;
  } catch {}
  return "auto";
}
export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "auto") delete root.dataset.theme;
  else root.dataset.theme = theme === "space" ? "dark" : theme;
  if (theme === "space") root.dataset.skin = "space";
  else delete root.dataset.skin;
}
export function saveTheme(theme: Theme) {
  applyTheme(theme);
  try {
    if (theme === "auto") localStorage.removeItem("kadan-theme");
    else localStorage.setItem("kadan-theme", theme);
  } catch {}
}
