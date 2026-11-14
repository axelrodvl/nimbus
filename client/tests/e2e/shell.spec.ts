import { expect, test } from '@playwright/test';
import { dropWs, mockLog, mutate, resetMock } from './mock';

const syncRequests = (log: string[], kind: 'snapshot' | 'changes') =>
  log.filter(l => l.startsWith('GET') && l.endsWith(`/api/sync/${kind}`)).length;

test.describe('вход', () => {
  test.beforeEach(async ({ request }) => resetMock(request, { authRequired: true }));

  test('неверный токен → ошибка; верный → оболочка; перезагрузка не требует входа; выход → /login', async ({
    page,
  }) => {
    await page.goto('/library');
    await expect(page).toHaveURL(/\/login\?next=%2Flibrary$/);

    await page.getByLabel('Токен доступа').fill('wrong');
    await page.getByRole('button', { name: 'Войти' }).click();
    await expect(page.getByRole('alert')).toHaveText('Неверный токен');
    await expect(page).toHaveURL(/\/login/);

    await page.getByLabel('Токен доступа').fill('secret');
    await page.getByRole('button', { name: 'Войти' }).click();
    // Маршрута /library пока нет — страница «не найдено» внутри оболочки.
    await expect(page).toHaveURL(/\/library$/);
    await expect(page.getByRole('heading', { name: 'Страница не найдена' })).toBeVisible();
    await expect(page.getByTestId('sidebar')).toBeVisible();

    await page.reload();
    await expect(page.getByTestId('sidebar')).toBeVisible();
    await expect(page).toHaveURL(/\/library$/);

    await page.getByRole('button', { name: 'Выйти' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByLabel('Токен доступа')).toBeVisible();

    // После выхода кэш сессии не пускает обратно.
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
  });
});

test('авторизация выключена → сразу оболочка, /login ведёт в приложение', async ({ page, request }) => {
  await resetMock(request, { authRequired: false });
  await page.goto('/login');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('sidebar')).toBeVisible();
});

test.describe('синхронизация', () => {
  test('первый вход: виден прогресс, затем «синхронизировано»; после перезагрузки снимок не повторяется', async ({
    page,
    request,
  }) => {
    await resetMock(request, { snapshotDelayMs: 800 });
    await page.goto('/');
    await expect(page.getByTestId('library-loading')).toContainText('Загружаем библиотеку');
    await expect(page.getByTestId('sync-status')).toContainText('Библиотека синхронизирована');
    await expect(page.getByTestId('library-loading')).toHaveCount(0);

    expect(syncRequests(await mockLog(request), 'snapshot')).toBe(1);
    await page.reload();
    await expect(page.getByTestId('sync-status')).toContainText('Библиотека синхронизирована');
    await expect.poll(async () => syncRequests(await mockLog(request), 'changes')).toBeGreaterThan(0);
    expect(syncRequests(await mockLog(request), 'snapshot')).toBe(1);
  });

  test('обрыв WebSocket → «нет связи» → восстановление → дельта', async ({ page, request }) => {
    await resetMock(request);
    await page.goto('/');
    const connection = page.getByRole('status', { name: 'Соединение с бэкендом установлено' });
    await expect(connection).toBeVisible();
    await expect(page.getByText('Онлайн')).toBeVisible();

    await dropWs(request, true);
    await expect(page.getByRole('status', { name: 'Нет соединения с бэкендом' })).toBeVisible();
    await expect(page.getByText('Офлайн')).toBeVisible();
    await expect(page.getByText('Нет сети — переподключаемся…')).toBeVisible();

    const changesBefore = syncRequests(await mockLog(request), 'changes');
    await dropWs(request, false);
    await expect(connection).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Нет сети — переподключаемся…')).toHaveCount(0);
    // При открытии сокета выполняется дельта.
    await expect.poll(async () => syncRequests(await mockLog(request), 'changes')).toBeGreaterThan(changesBefore);
  });

  test('изменение на сервере приходит клиенту через sync.poke → дельту', async ({ page, request }) => {
    await resetMock(request);
    await page.goto('/');
    await expect(page.getByRole('status', { name: 'Соединение с бэкендом установлено' })).toBeVisible();
    const before = syncRequests(await mockLog(request), 'changes');
    await mutate(request, {
      entity: 'playlist',
      row: { created_at: '2026-01-01T00:00:00Z', id: 3, last_used_at: '2026-01-01T00:00:00Z', name: 'Новый' },
    });
    await expect.poll(async () => syncRequests(await mockLog(request), 'changes')).toBeGreaterThan(before);
  });
});

test.describe('раскладка', () => {
  test.beforeEach(async ({ request }) => resetMock(request));

  test('мобильный размер: нижняя панель видна, боковая скрыта', async ({ page }) => {
    await page.setViewportSize({ height: 844, width: 390 });
    await page.goto('/');
    await expect(page.getByTestId('mobile-tab-bar')).toBeVisible();
    await expect(page.getByTestId('sidebar')).toBeHidden();
    await expect(page.getByTestId('mobile-tab-bar').getByRole('link', { name: 'Главная' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('настольный размер: боковая панель видна, нижняя скрыта', async ({ page }) => {
    await page.setViewportSize({ height: 800, width: 1280 });
    await page.goto('/');
    await expect(page.getByTestId('sidebar')).toBeVisible();
    await expect(page.getByTestId('mobile-tab-bar')).toBeHidden();
  });
});
