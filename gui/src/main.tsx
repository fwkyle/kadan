import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { autoReloadChunkError } from "./chunk-reload";
import { applyTheme, readTheme } from "./theme";
import "./style.css";
applyTheme(readTheme());
// Vite가 조각 미리 읽기 실패를 알리는 사건. 오류는 그대로 던져져 화면 오류 상자도 같은 판단을 거친다.
// 같은 상한을 함께 쓰므로 두 곳이 겹쳐도 새로 읽기는 한 번뿐이다.
window.addEventListener("vite:preloadError", (event) => {
  autoReloadChunkError((event as Event & { payload?: { message?: string } }).payload?.message);
});
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
