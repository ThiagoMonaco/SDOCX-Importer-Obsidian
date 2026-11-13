import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
  resolve: {
    alias: {
      obsidian: fileURLToPath(
        new URL("./test/obsidian-stub.ts", import.meta.url),
      ),
    },
  },
});
