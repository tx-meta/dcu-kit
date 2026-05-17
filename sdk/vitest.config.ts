import { defineConfig } from "vitest/config";
import { config } from "dotenv";

config({ path: ".env" });

export default defineConfig({
  test: {
    reporters: "verbose",
    include: ["./test/**/*.test.ts"],
    testTimeout: 600000,
    fileParallelism: false,
    bail: 3,
    sequence: {
      shuffle: false,
    },
  },
});
