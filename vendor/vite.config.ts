import { defineConfig } from "vite-plus";
import { handleApi } from "./src/api.ts";

// Serves the vendor agent API (src/api.ts) alongside the storefront in
// dev and preview. For a deployed copy, put the same handler behind any
// Node server and serve the built storefront statically.
const vendorApi = {
  name: "vendor-api",
  configureServer(server: {
    middlewares: { use: (fn: (req: never, res: never, next: () => void) => void) => void };
  }) {
    server.middlewares.use(async (req: never, res: never, next: () => void) => {
      if (!(await handleApi(req, res))) next();
    });
  },
  configurePreviewServer(server: {
    middlewares: { use: (fn: (req: never, res: never, next: () => void) => void) => void };
  }) {
    server.middlewares.use(async (req: never, res: never, next: () => void) => {
      if (!(await handleApi(req, res))) next();
    });
  },
};

export default defineConfig({
  plugins: [vendorApi],
  fmt: {},
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
});
