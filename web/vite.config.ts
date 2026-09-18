import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Hash-router app served from any static path (GitHub Pages), so base is relative.
// e2e-shim/ is intentionally OUTSIDE src/ and never imported by application code;
// it is consumed only by Playwright via page.addInitScript.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./",
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    target: "es2022",
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom"],
          ethereum: ["viem", "wagmi", "@rainbow-me/rainbowkit"],
        },
      },
    },
  },
});
