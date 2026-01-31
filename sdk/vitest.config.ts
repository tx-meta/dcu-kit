import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    reporters: "verbose",
    include: ["./test/**/*.test.ts"],
    testTimeout: 30000,
    alias: {
      "libsodium-wrappers": "libsodium-wrappers-sumo/dist/modules-sumo/libsodium-wrappers.js",
    },
  },
});
