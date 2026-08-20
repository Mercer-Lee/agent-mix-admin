import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.spec.ts"],
    exclude: ["src/**/*.integration.spec.ts", "src/**/*.e2e-spec.ts"],
    coverage: { reporter: ["text", "html"] },
  },
});
