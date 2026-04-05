import { defineConfig } from "vitest/config";
import wasm from "vite-plugin-wasm";

export default defineConfig({
  plugins: [wasm()],
  test: {
    reporters: "verbose",
    include: ["./test/**/*.test.ts"],
    testTimeout: 300000,
    pool: "forks", // Each file gets a fresh process — prevents UTxO contention and clean WASM module resolution
  },
});
