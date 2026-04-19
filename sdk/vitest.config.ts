import { defineConfig } from "vitest/config";
import { config } from "dotenv";

config({ path: ".env" });

export default defineConfig({
  test: {
    reporters: "verbose",
    // Explicit lifecycle order: account → group → treasury.
    // Do NOT use glob here — filesystem discovery order is non-deterministic on Linux.
    include: [
      "./test/account.test.ts",
      "./test/group.test.ts",
      "./test/treasury.test.ts",
    ],
    testTimeout: 600000,
    fileParallelism: false, // Prevent wallet UTxO contention on live network
    bail: 1,              // Stop entire run on first failure — lifecycle is strictly ordered
    sequence: {
      shuffle: false,     // Never randomise file or test order
    },
  },
});
