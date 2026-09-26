import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
  base: command === "serve" ? "/" : "/dashboard-assets/",
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
