import { expect, type Page, type Response, test } from '@playwright/test';
import { E2E_ADMIN as ADMIN } from './constants';

const isLoginPost = (r: Response): boolean =>
  r.url().endsWith('/auth/login') && r.request().method() === 'POST';

async function fillCredentials(page: Page, email: string, password: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Email' }).fill(email);
  await page.getByRole('textbox', { name: 'Password' }).fill(password);
}

test.describe('error & loading states', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
  });

  test('shows a network error when the login request cannot reach the server', async ({ page }) => {
    // Fail the request at the transport level -> fetch rejects (TypeError) -> ApiError(0).
    await page.route('**/auth/login', (route) => route.abort('failed'));

    await fillCredentials(page, ADMIN.email, ADMIN.password);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByRole('alert')).toContainText(/network/i);
    await expect(page).toHaveURL('/login');
    // The form recovers — inputs are usable again for a retry.
    await expect(page.getByRole('textbox', { name: 'Email' })).toBeEnabled();
  });

  test('disables the login form while the request is in flight', async ({ page }) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Hold the login request open so we can observe the in-flight (disabled) state.
    await page.route('**/auth/login', async (route) => {
      await gate;
      await route.continue();
    });

    await fillCredentials(page, ADMIN.email, ADMIN.password);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByRole('textbox', { name: 'Email' })).toBeDisabled();

    release();
    await expect(page).toHaveURL('/');
  });

  test('surfaces a dashboard load error and recovers on retry', async ({ page }) => {
    await fillCredentials(page, ADMIN.email, ADMIN.password);
    await Promise.all([
      page.waitForResponse(isLoginPost),
      page.getByRole('button', { name: 'Sign in' }).click(),
    ]);
    await expect(page).toHaveURL('/');
    // Wait for the on-mount profile bootstrap to settle before injecting a failure.
    await expect(page.getByRole('button', { name: 'Reload' })).toBeEnabled();

    // Force the profile fetch to fail, then trigger a reload.
    await page.route('**/auth/me', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'boom' }),
      }),
    );
    await page.getByRole('button', { name: 'Reload' }).click();
    await expect(page.getByTestId('dashboard-error')).toBeVisible();

    // Recover: stop intercepting and retry.
    await page.unroute('**/auth/me');
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(page.getByTestId('dashboard-error')).toBeHidden();
    await expect(page.getByText(ADMIN.email)).toBeVisible();
  });
});
