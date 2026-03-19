import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/coverage/**",
      "**/infra/cdk/cdk.out/**",
      "**/cdk.out/**"
    ]
  }
});
