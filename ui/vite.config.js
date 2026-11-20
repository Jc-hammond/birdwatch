import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [{
    name: "dashboard-theme",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "assets/theme.js",
        source: readFileSync(new URL("./assets/theme.js", import.meta.url)),
      });
    },
  }],
  build: { outDir: "../static", emptyOutDir: true },
});
