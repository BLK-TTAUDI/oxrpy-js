import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text-summary", "text"],
      // Raise these as coverage goes up; `npm run coverage` (and CI) fails below them.
      thresholds: { statements: 85, branches: 78, functions: 74, lines: 87 },
    },
  },
});
