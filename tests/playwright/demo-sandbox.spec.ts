import { expect, test } from "@playwright/test";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

test("public demo can be cloned into a writable sandbox", async ({ page }) => {
  const email = requireEnv("PLAYWRIGHT_SMOKE_EMAIL");
  const password = requireEnv("PLAYWRIGHT_SMOKE_PASSWORD");
  const endpointNameBase = process.env.PLAYWRIGHT_SMOKE_ENDPOINT_NAME?.trim() || "Playwright Sandbox Smoke";
  const endpointUrl = process.env.PLAYWRIGHT_SMOKE_ENDPOINT_URL?.trim() || "https://example.com/playwright/health";
  const endpointName = `${endpointNameBase} ${Date.now()}`;

  await page.goto("/");

  await page.getByTestId("auth-email").fill(email);
  await page.getByTestId("auth-password").fill(password);
  await Promise.all([
    page.waitForURL(/\/org\/org_demo_public$/),
    page.getByTestId("auth-submit").click()
  ]);

  await expect(page.getByTestId("dashboard-shell")).toBeVisible();
  await expect(page.getByText(/Public demo is view-only\./)).toBeVisible();

  await Promise.all([
    page.waitForURL(/\/org\/org_[^/]+$/),
    page.getByTestId("create-writable-sandbox").click()
  ]);

  await expect(page).toHaveURL(/\/org\/org_[^/]+$/);
  await expect(page.getByText(/Public demo is view-only\./)).toHaveCount(0);
  await expect(page.getByTestId("add-endpoint")).toBeEnabled();

  await page.getByTestId("endpoint-name-input").fill(endpointName);
  await page.getByTestId("endpoint-url-input").fill(endpointUrl);
  await page.getByTestId("add-endpoint").click();

  const createdEndpointCard = page.locator("article.signal-card", { hasText: endpointName }).first();
  await expect(createdEndpointCard).toBeVisible();
});
