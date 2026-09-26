import { defineConfig } from "vite";
import { dashboardStyles } from "./styles.mjs";

export default defineConfig(({ command }) => ({
  base: command === "serve" ? "/" : "/dashboard-assets/",
  plugins: [{
    name: "kadan-dashboard-styles",
    enforce: "pre",
    transform(code, id) {
      if (id.split("?")[0].endsWith("/gui/src/style.css"))
        return { code: dashboardStyles(code), map: null };
    },
  }],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    proxy: Object.fromEntries(
      ["/api", "/cards", "/works", "/decisions", "/runners"].map((prefix) => [
        prefix,
        {
          target: "http://127.0.0.1:8790",
          changeOrigin: true,
          configure(proxy) {
            proxy.on("proxyReq", (request) =>
              request.setHeader("origin", "http://127.0.0.1:8790"),
            );
          },
        },
      ]),
    ),
  },
}));
