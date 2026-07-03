import { expect, type Page, type Response, test } from '@playwright/test';

const ADMIN = { email: 'admin@example.com', password: 'admin12345' };

const isLoginPost = (r: Response): boolean =>
  r.url().endsWith('/auth/login') && r.request().method() === 'POST';

async function fillCredentials(page: Page, email: string, password: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Email' }).fill(email);
  await page.getByRole('textbox', { name: 'Password' }).fill(password);
}

test.describe('authentication', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
  });

  test('logs in with the seeded admin and reaches the dashboard', async ({ page }) => {
    await fillCredentials(page, ADMIN.email, ADMIN.password);

    // Regression guard for the api-client fetch-binding bug: the login POST must
    // actually reach the backend. The bug threw "Illegal invocation" before any
    // request was sent, so waitForResponse would time out here.
    const [loginResponse] = await Promise.all([
      page.waitForResponse(isLoginPost),
      page.getByRole('button', { name: 'Sign in' }).click(),
    ]);
    expect(loginResponse.status()).toBe(201);

    await expect(page).toHaveURL('/');
    await expect(page.getByText('Dashboard', { exact: true })).toBeVisible();
    await expect(page.getByText(ADMIN.email)).toBeVisible();
    await expect(page.getByText('ADMIN', { exact: true })).toBeVisible();
  });

  test('shows an error for invalid credentials and stays on the login page', async ({ page }) => {
    await fillCredentials(page, ADMIN.email, 'wrong-password');

    const [loginResponse] = await Promise.all([
      page.waitForResponse(isLoginPost),
      page.getByRole('button', { name: 'Sign in' }).click(),
    ]);
    expect(loginResponse.status()).toBe(401);

    await expect(page.getByText('Invalid credentials')).toBeVisible();
    await expect(page).toHaveURL('/login');
  });

  test('redirects an unauthenticated visitor from the dashboard to login', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL('/login');
  });

  test('logs out and protects the dashboard again', async ({ page }) => {
    await fillCredentials(page, ADMIN.email, ADMIN.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL('/');

    await page.getByRole('button', { name: 'Log out' }).click();
    await expect(page).toHaveURL('/login');

    // The dashboard route is guarded once the session is cleared.
    await page.goto('/');
    await expect(page).toHaveURL('/login');
  });
});
