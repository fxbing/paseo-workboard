import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: {
    alias: {
      "react-native": fileURLToPath(
        new URL("./tests/react-native.ts", import.meta.url),
      ),
    },
  },
  test: { include: ["tests/*.test.ts"] },
});
