export type Theme = "auto" | "dark" | "light";
export function readTheme(): Theme {
  try {
    const value = localStorage.getItem("kadan-theme");
    if (value === "dark" || value === "light") return value;
  } catch {}
  return "auto";
}
export function applyTheme(theme: Theme) {
  if (theme === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}
export function saveTheme(theme: Theme) {
  applyTheme(theme);
  try {
    if (theme === "auto") localStorage.removeItem("kadan-theme");
    else localStorage.setItem("kadan-theme", theme);
  } catch {}
}
