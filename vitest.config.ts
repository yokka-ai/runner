import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Every test starts clean: stubbed globals and env vars and spied-on functions are put back after it,
    // so a stub can't leak into the next test (or the next file in the same worker).
    unstubGlobals: true,
    unstubEnvs: true,
    restoreMocks: true,
    // Generous for coverage instrumentation and for the tests that start real processes (git, node); a test
    // that needs longer is waiting on something it shouldn't.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: "istanbul",
      include: ["src/**/*.ts"],
      reporter: ["text-summary", "json-summary", "html"],
      reportsDirectory: "coverage",
      // A failing test shouldn't hide the report that helps find what it missed.
      reportOnFailure: true,
      // Floors a little under what the suite reaches today, so coverage can only go up: `npm run
      // test:coverage` fails when either drops below.
      thresholds: { lines: 94, branches: 82 },
    },
  },
});
