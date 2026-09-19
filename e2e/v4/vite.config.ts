import { defineConfig, mergeConfig } from "../../web/node_modules/vite";
import path from "node:path";
import base from "../../web/vite.config";
import { ART, HERE, ROOT } from "./constants";

// Strictly scoped test aliases. No production JSON or key source is rewritten.
export default mergeConfig(base, defineConfig({
  root: path.join(ROOT, "web"),
  plugins: [{
    name: "v4-local-test-fixtures",
    enforce: "pre",
    resolveId(source: string, importer: string | undefined) {
      if (!importer?.includes(path.join(ROOT, "web", "src"))) return;
      if (source === "../deployment.json") return path.join(ART, "legacy-deployment.json");
      if (source === "./v4-deployments.json") return path.join(ART, "v4-deployments.json");
      if (source.endsWith("/emailkit/bridge")) return path.join(HERE, "emailkit-test-bridge.ts");
    },
  }],
  build: { outDir: path.join(ART, "site"), emptyOutDir: true },
  preview: { host: "127.0.0.1", port: 5199, strictPort: true },
}));
