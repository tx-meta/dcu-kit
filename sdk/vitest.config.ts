import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    reporters: "verbose",
    include: ["./test/**/*.test.ts"],
    testTimeout: 300000,
    alias: {
      // Redirect libsodium-wrappers to the CJS sumo build — the ESM
      // distribution in libsodium-wrappers-sumo@0.7.16 references
      // libsodium-sumo.mjs which does not exist in that version.
      "libsodium-wrappers": "libsodium-wrappers-sumo/dist/modules-sumo/libsodium-wrappers.js",
    },
    fileParallelism: false, // Critical: Prevent wallet UTxO contention on live network
    server: {
      deps: {
        // Bundle libsodium-wrappers-sumo through Vite's CJS transform instead
        // of letting Node's ESM loader resolve it — bypasses the missing .mjs file.
        inline: ["libsodium-wrappers-sumo"],
      },
    },
  },
});
