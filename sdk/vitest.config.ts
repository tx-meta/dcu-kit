import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    reporters: "verbose",
    include: ["./test/**/*.test.ts"],
    testTimeout: 300000,
    fileParallelism: false, // Critical: Prevent wallet UTxO contention on live network
  },
});
