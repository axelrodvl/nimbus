import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/errors';
import * as api from '@/lib/api/settings';
import * as crash from '@/components/crash-screen';
import { session } from '@/lib/auth';
import type { MessageKey } from '@/lib/i18n/messages';
import ru from '@/lib/i18n/messages/ru';
import type { ServerSettings } from '@/lib/settings/types';
import { renderRoutes } from '@/test/render';
import { SettingsScreen } from './settings-screen';

vi.mock('@/lib/api/settings', () => ({
  fetchServerVersion: vi.fn(async () => '9.9.9'),
  fetchSettings: vi.fn(),
  fetchStorage: vi.fn(),
  loadPrefetchEnabled: async () => true,
  putSettings: vi.fn(),
  reimportArtists: vi.fn(),
  retryMissing: vi.fn(),
  testProvider: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));

const L = (key: MessageKey) => ru[key] as string;
const m = vi.mocked(api);

const baseSettings = (): ServerSettings => ({
  matching: { accept: 0.8, confirm: 0.65 },
  musicbrainz: { base_url: 'https://musicbrainz.org/ws/2/', burst: 3, max_concurrent: 2, rate_per_sec: 1 },
  performance: {
    discover_workers: 8,
    download_concurrency: 4,
    import_workers: 2,
    metadata_concurrency: 16,
    metadata_timeout_secs: 30,
    verify_workers: 16,
  },
  playback: { prefetch_next: true, transcode_alac: false, transcode_lossy_codec: 'opus' },
  providers: { rutracker: null, tpb_enabled: true, torznab: null },
  search: {
    auto_retry: true,
    format_prefs: ['flac', 'alac', 'mp3_320'],
    max_candidates: 8,
    skip_secondary_types: ['EP', 'Live'],
  },
  storage: { auto_download: 'off', cache_limit_gb: 50, seed_ratio: 1, seeding: true },
});

const GB = 1024 ** 3;
const storage = (over = {}) => ({
  files: 10,
  limit_bytes: 50 * GB,
  over_limit: false,
  pinned_bytes: 2 * GB,
  pinned_files: 3,
  torrents_active: 0,
  used_bytes: 12 * GB,
  ...over,
});

function setup(route = '/settings/sources', settings: ServerSettings | Error = baseSettings()) {
  if (settings instanceof Error) m.fetchSettings.mockRejectedValue(settings);
  else m.fetchSettings.mockResolvedValue(settings);
  m.putSettings.mockImplementation(async patch => ({ ...baseSettings(), ...(patch as ServerSettings) }));
  m.fetchStorage.mockResolvedValue(storage());
  return renderRoutes([{ element: <SettingsScreen />, path: '/settings/:section?' }], route);
}

const lastPatch = () => m.putSettings.mock.calls.at(-1)?.[0];
const setOnline = (online: boolean) =>
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: online });

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of [m.fetchSettings, m.putSettings, m.fetchStorage, m.testProvider, m.reimportArtists, m.retryMissing])
    fn.mockReset();
  m.fetchServerVersion.mockReset().mockResolvedValue('9.9.9');
});
afterEach(() => {
  setOnline(true);
  vi.useRealTimers();
});

describe('макет и маршруты', () => {
  it('/settings/:section показывает раздел, навигация содержит все разделы; пункт 404 для неизвестного', async () => {
    setup('/settings/about');
    expect(await screen.findByTestId('settings-about')).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: L('settings.nav') });
    expect(within(nav).getAllByRole('link')).toHaveLength(9);
    // «Загрузки и поиск» — ссылка на другой экран, а не раздел настроек.
    expect(within(nav).getByRole('link', { name: L('settings.downloadsLink') })).toHaveAttribute('href', '/downloads');
    expect(within(nav).getByRole('link', { name: L('settings.about') })).toHaveAttribute('aria-current', 'page');
  });

  it('/settings без раздела: по умолчанию «Источники», на мобильных виден список (без aria-current)', async () => {
    setup('/settings');
    expect(await screen.findByTestId('settings-sources')).toBeInTheDocument();
    expect(screen.getByTestId('settings-nav')).toHaveClass('block');
    expect(screen.getByTestId('settings-back')).toHaveAttribute('href', '/settings');
    expect(within(screen.getByTestId('settings-nav')).getByTestId('settings-link-sources')).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('неизвестный раздел — страница 404', () => {
    setup('/settings/zzz');
    expect(screen.getByRole('heading', { name: L('notFound.title') })).toBeInTheDocument();
  });

  it('переход по пункту навигации открывает раздел', async () => {
    const { router } = setup('/settings');
    await userEvent.click(await screen.findByTestId('settings-link-playback'));
    expect(router.state.location.pathname).toBe('/settings/playback');
    expect(await screen.findByTestId('settings-playback')).toBeInTheDocument();
  });
});

describe('состояния экрана', () => {
  it('загрузка — skeleton; ошибка — ErrorState с повтором, который перезапрашивает настройки', async () => {
    setup('/settings/search', new ApiError(500, 'internal', 'x'));
    expect(screen.getByTestId('settings-skeleton')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent(L('common.loadFailed'));
    m.fetchSettings.mockResolvedValue(baseSettings());
    await userEvent.click(screen.getByRole('button', { name: L('common.retry') }));
    expect(await screen.findByTestId('settings-search')).toBeInTheDocument();
  });

  it('разделы без серверных данных (внешний вид, о приложении) не ждут настроек', () => {
    setup('/settings/appearance', new ApiError(500, 'internal', 'x'));
    expect(screen.getByTestId('settings-appearance')).toBeInTheDocument();
    expect(screen.queryByTestId('settings-skeleton')).not.toBeInTheDocument();
  });

  it('офлайн: серверные поля только для чтения с пояснением; внешний вид работает', async () => {
    setOnline(false);
    setup('/settings/search');
    expect(await screen.findByTestId('settings-search')).toBeInTheDocument();
    expect(screen.getByTestId('offline-notice')).toHaveTextContent(L('settings.offlineNote'));
    expect(screen.getByRole('switch', { name: L('settings.autoRetry') })).toBeDisabled();
    expect(screen.getByRole('spinbutton', { name: L('settings.maxCandidates') })).toBeDisabled();
    expect(screen.getByRole('button', { name: L('form.moveDown').replace('{name}', 'FLAC') })).toBeDisabled();
  });

  it('офлайн без загруженных настроек: объяснение вместо полей', async () => {
    setOnline(false);
    setup('/settings/search', new ApiError(0, 'network', 'offline'));
    expect(await screen.findByRole('alert')).toHaveTextContent(L('settings.offlineNoData'));
  });

  it('поле, которого нет в ответе сервера, не отображается', async () => {
    const s = baseSettings();
    delete s.search?.auto_retry;
    delete s.matching;
    setup('/settings/search', s);
    await screen.findByTestId('settings-search');
    expect(screen.queryByRole('switch', { name: L('settings.autoRetry') })).not.toBeInTheDocument();
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: L('settings.maxCandidates') })).toBeInTheDocument();
  });
});

describe('автосохранение', () => {
  it('переключатель — один PUT с патчем только этого поля, индикатор «Сохранено»', async () => {
    setup('/settings/search');
    await userEvent.click(await screen.findByRole('switch', { name: L('settings.autoRetry') }));
    await waitFor(() => expect(screen.getByTestId('save-status')).toHaveTextContent(L('settings.status.saved')));
    expect(m.putSettings).toHaveBeenCalledTimes(1);
    expect(lastPatch()).toEqual({ search: { auto_retry: false } });
  });

  it('индикатор показывает «Сохраняется…» пока идёт запрос', async () => {
    setup('/settings/search');
    let resolve: (v: ServerSettings) => void = () => undefined;
    m.putSettings.mockImplementation(() => new Promise(r => (resolve = r)));
    await userEvent.click(await screen.findByRole('switch', { name: L('settings.autoRetry') }));
    expect(screen.getByTestId('save-status')).toHaveTextContent(L('settings.status.saving'));
    await act(async () => resolve(baseSettings()));
    expect(screen.getByTestId('save-status')).toHaveTextContent(L('settings.status.saved'));
  });

  it('число сохраняется по blur с границами; неизменённое не отправляется', async () => {
    setup('/settings/search');
    const input = await screen.findByRole('spinbutton', { name: L('settings.maxCandidates') });
    await userEvent.clear(input);
    await userEvent.type(input, '99');
    await userEvent.tab();
    await waitFor(() => expect(m.putSettings).toHaveBeenCalledTimes(1));
    expect(lastPatch()).toEqual({ search: { max_candidates: 30 } });
  });

  it('RuTracker: User-Agent и дополнительные заголовки сохраняются, пустые уходят как null', async () => {
    setup('/settings/sources', {
      ...baseSettings(),
      providers: {
        ...baseSettings().providers,
        rutracker: { cookie: null, headers: null, password: null, proxy: null, user_agent: null, username: null },
      },
    });
    // Ответ сервера содержит весь раздел: сливаем патч в текущее состояние RuTracker.
    const rt: Record<string, unknown> = {
      cookie: null,
      headers: null,
      password: null,
      proxy: null,
      user_agent: null,
      username: null,
    };
    m.putSettings.mockImplementation(async patch => {
      Object.assign(rt, (patch as ServerSettings).providers?.rutracker);
      return { ...baseSettings(), providers: { ...baseSettings().providers, rutracker: { ...rt } } };
    });
    const ua = await screen.findByRole('textbox', { name: L('settings.userAgent') });
    await userEvent.type(ua, 'Mozilla/5.0 Test{Enter}');
    await waitFor(() => expect(lastPatch()).toEqual({ providers: { rutracker: { user_agent: 'Mozilla/5.0 Test' } } }));
    const headers = screen.getByRole('textbox', { name: L('settings.extraHeaders') });
    await userEvent.type(headers, 'Accept-Language: ru{Enter}sec-ch-ua-platform: "Linux"');
    await userEvent.tab();
    await waitFor(() =>
      expect(lastPatch()).toEqual({
        providers: { rutracker: { headers: 'Accept-Language: ru\nsec-ch-ua-platform: "Linux"' } },
      }),
    );
    await userEvent.clear(headers);
    await userEvent.tab();
    await waitFor(() => expect(lastPatch()).toEqual({ providers: { rutracker: { headers: null } } }));
  });

  it('текст сохраняется по blur и Enter; пустое значение уходит как null', async () => {
    setup('/settings/sources', {
      ...baseSettings(),
      providers: { ...baseSettings().providers, rutracker: { password: null, proxy: null, username: 'old' } },
    });
    const user = await screen.findByRole('textbox', { name: L('settings.login') });
    await userEvent.clear(user);
    await userEvent.type(user, 'new{Enter}');
    await waitFor(() => expect(lastPatch()).toEqual({ providers: { rutracker: { username: 'new' } } }));
    await userEvent.clear(user);
    await userEvent.tab();
    await waitFor(() => expect(lastPatch()).toEqual({ providers: { rutracker: { username: null } } }));
    const calls = m.putSettings.mock.calls.length;
    user.focus();
    await userEvent.tab();
    expect(m.putSettings).toHaveBeenCalledTimes(calls);
  });

  it('слайдер: серия движений — один запрос после паузы 600 мс', async () => {
    setup('/settings/search');
    const slider = await screen.findByRole('slider', { name: L('settings.accept') });
    vi.useFakeTimers();
    fireEvent.change(slider, { target: { value: '0.9' } });
    act(() => vi.advanceTimersByTime(300));
    fireEvent.change(slider, { target: { value: '0.95' } });
    act(() => vi.advanceTimersByTime(300));
    expect(m.putSettings).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(300));
    expect(m.putSettings).toHaveBeenCalledTimes(1);
    expect(lastPatch()).toEqual({ matching: { accept: 0.95 } });
  });

  it('оптимистичное обновление: значение меняется сразу, при 500 откатывается с toast и индикатором «Ошибка»', async () => {
    setup('/settings/search');
    const sw = await screen.findByRole('switch', { name: L('settings.autoRetry') });
    let reject: (e: unknown) => void = () => undefined;
    m.putSettings.mockImplementation(() => new Promise((_, r) => (reject = r)));
    await userEvent.click(sw);
    expect(sw).toHaveAttribute('aria-checked', 'false');
    await act(async () => reject(new ApiError(500, 'internal', 'boom')));
    expect(screen.getByRole('switch', { name: L('settings.autoRetry') })).toHaveAttribute('aria-checked', 'true');
    expect(toast.error).toHaveBeenCalledWith('boom');
    expect(screen.getByTestId('save-status')).toHaveTextContent(L('settings.status.error'));
  });

  it('ошибка 400 показана у нужного поля; общая — в верхней части раздела', async () => {
    setup('/settings/musicbrainz');
    m.putSettings.mockRejectedValueOnce(
      new ApiError(400, 'invalid_settings', 'musicbrainz.burst must be between 1 and 20', 'musicbrainz.burst'),
    );
    const burst = await screen.findByRole('spinbutton', { name: L('settings.mb.burst') });
    await userEvent.clear(burst);
    await userEvent.type(burst, '5{Enter}');
    const error = await screen.findByText('musicbrainz.burst must be between 1 and 20');
    expect(burst).toHaveAttribute('aria-invalid', 'true');
    expect(burst.getAttribute('aria-describedby')).toContain(error.id);
    // Следующее сохранение этого поля снимает ошибку.
    await userEvent.clear(burst);
    await userEvent.type(burst, '4{Enter}');
    await waitFor(() =>
      expect(screen.queryByText('musicbrainz.burst must be between 1 and 20')).not.toBeInTheDocument(),
    );

    m.putSettings.mockRejectedValueOnce(new ApiError(400, 'invalid_settings', 'something is off'));
    await userEvent.clear(burst);
    await userEvent.type(burst, '6{Enter}');
    // Одно поле в патче — ошибка без пути привязывается к нему.
    expect(await screen.findByText('something is off')).toBeInTheDocument();
  });

  it('ошибка 400 без поля при патче из нескольких полей — общее сообщение раздела', async () => {
    const s = baseSettings();
    s.musicbrainz = { base_url: 'http://mirror.local/ws/2/', burst: 10, max_concurrent: 8, rate_per_sec: 0 };
    setup('/settings/musicbrainz', s);
    m.putSettings.mockRejectedValueOnce(new ApiError(400, 'invalid_settings', 'bad combo'));
    await userEvent.click(await screen.findByRole('button', { name: L('settings.mb.resetAction') }));
    expect(await screen.findByRole('alert')).toHaveTextContent('bad combo');
  });

  it('устаревший ответ не затирает более новое значение (мутации идут по очереди)', async () => {
    setup('/settings/search');
    const resolvers: ((v: ServerSettings) => void)[] = [];
    m.putSettings.mockImplementation(() => new Promise(r => resolvers.push(r)));
    await userEvent.click(await screen.findByRole('switch', { name: L('settings.autoRetry') }));
    const input = screen.getByRole('spinbutton', { name: L('settings.maxCandidates') });
    await userEvent.clear(input);
    await userEvent.type(input, '12{Enter}');
    // Ответ на первый запрос ещё не знает про второй.
    const stale = baseSettings();
    stale.search = { ...stale.search, auto_retry: false };
    await act(async () => resolvers[0]?.(stale));
    expect(screen.getByRole('spinbutton', { name: L('settings.maxCandidates') })).toHaveValue(12);
    expect(screen.getByRole('switch', { name: L('settings.autoRetry') })).toHaveAttribute('aria-checked', 'false');
    const fresh = baseSettings();
    fresh.search = { ...fresh.search, auto_retry: false, max_candidates: 12 };
    await act(async () => resolvers[1]?.(fresh));
    expect(screen.getByRole('spinbutton', { name: L('settings.maxCandidates') })).toHaveValue(12);
  });

  it('suggest_retry_missing: toast с действием «Повторить поиск ненайденного»', async () => {
    setup('/settings/sources');
    m.putSettings.mockResolvedValue({ ...baseSettings(), suggest_retry_missing: true });
    m.retryMissing.mockResolvedValue(5);
    await userEvent.click(await screen.findByRole('switch', { name: L('settings.enabled') }));
    await waitFor(() => expect(toast.info).toHaveBeenCalled());
    const options = vi.mocked(toast.info).mock.calls[0]?.[1] as { action: { label: string; onClick: () => void } };
    expect(options.action.label).toBe(L('settings.retryMissing.action'));
    options.action.onClick();
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(L('settings.retryMissing.started')?.replace('{count}', '5')),
    );
    expect(m.retryMissing).toHaveBeenCalledTimes(1);
    m.retryMissing.mockRejectedValueOnce(new ApiError(500, 'internal', 'nope'));
    options.action.onClick();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('nope'));
  });
});

describe('секреты', () => {
  const withTorznab = (): ServerSettings => ({
    ...baseSettings(),
    providers: { rutracker: null, tpb_enabled: true, torznab: { api_key: '••••', url: 'http://tz' } },
  });

  it('заданный секрет показан маской-плейсхолдером; пустое поле ничего не отправляет, маска не уходит', async () => {
    setup('/settings/sources', withTorznab());
    const key = await screen.findByLabelText(L('settings.apiKey'));
    expect(key).toHaveValue('');
    expect(key).toHaveAttribute('placeholder', '••••');
    const saveButtons = screen.getAllByRole('button', { name: L('settings.save') });
    saveButtons.forEach(b => expect(b).toBeDisabled());
    await userEvent.type(key, '{Enter}');
    expect(m.putSettings).not.toHaveBeenCalled();
  });

  it('новое значение уходит только по кнопке «Сохранить» (и Enter), затем поле очищается', async () => {
    setup('/settings/sources', withTorznab());
    const key = await screen.findByLabelText(L('settings.apiKey'));
    await userEvent.type(key, 'k123');
    await userEvent.tab();
    expect(m.putSettings).not.toHaveBeenCalled();
    await userEvent.click(screen.getAllByRole('button', { name: L('settings.save') })[0] as HTMLElement);
    await waitFor(() => expect(m.putSettings).toHaveBeenCalledTimes(1));
    expect(lastPatch()).toEqual({ providers: { torznab: { api_key: 'k123' } } });
    await waitFor(() => expect(key).toHaveValue(''));
    await userEvent.type(key, 'second{Enter}');
    await waitFor(() => expect(lastPatch()).toEqual({ providers: { torznab: { api_key: 'second' } } }));
  });

  it('ошибка сохранения секрета оставляет введённое значение', async () => {
    setup('/settings/sources', withTorznab());
    m.putSettings.mockRejectedValueOnce(new ApiError(500, 'internal', 'boom'));
    const key = await screen.findByLabelText(L('settings.apiKey'));
    await userEvent.type(key, 'k123{Enter}');
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(key).toHaveValue('k123');
  });

  it('literal-маска в поле не отправляется', async () => {
    setup('/settings/sources', withTorznab());
    const key = await screen.findByLabelText(L('settings.apiKey'));
    await userEvent.type(key, '••••{Enter}');
    expect(m.putSettings).not.toHaveBeenCalled();
  });
});

describe('источники: проверка провайдера', () => {
  it('успех и ошибка показываются меткой в строке', async () => {
    setup('/settings/sources');
    m.testProvider.mockResolvedValueOnce({ message: 'OK: 12 results', ok: true, sample_count: 12 });
    await userEvent.click(
      await screen.findByRole('button', { name: L('settings.testLabel').replace('{name}', 'tpb') }),
    );
    expect(await screen.findByTestId('test-result-tpb')).toHaveTextContent('OK: 12 results');
    expect(m.testProvider).toHaveBeenCalledWith('tpb');

    m.testProvider.mockResolvedValueOnce({ message: 'Login rejected', ok: false, sample_count: 0 });
    await userEvent.click(screen.getByRole('button', { name: L('settings.testLabel').replace('{name}', 'tpb') }));
    await waitFor(() => expect(screen.getByTestId('test-result-tpb')).toHaveTextContent('Login rejected'));

    m.testProvider.mockRejectedValueOnce(new ApiError(400, 'not_configured', 'tpb is not configured'));
    await userEvent.click(screen.getByRole('button', { name: L('settings.testLabel').replace('{name}', 'tpb') }));
    await waitFor(() => expect(screen.getByTestId('test-result-tpb')).toHaveTextContent('tpb is not configured'));
  });

  it('ненастроенный провайдер не проверяется; поля RuTracker видны, пока объект не задан', async () => {
    setup('/settings/sources');
    expect(await screen.findByRole('textbox', { name: L('settings.login') })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: L('settings.testLabel').replace('{name}', 'rutracker') })).toBeDisabled();
    expect(screen.getByRole('button', { name: L('settings.testLabel').replace('{name}', 'torznab') })).toBeDisabled();
  });
});

describe('поиск и сопоставление', () => {
  it('порядок форматов: кнопки отправляют новый порядок', async () => {
    setup('/settings/search');
    await userEvent.click(await screen.findByRole('button', { name: L('form.moveDown').replace('{name}', 'FLAC') }));
    expect(lastPatch()).toEqual({ search: { format_prefs: ['alac', 'flac', 'mp3_320'] } });
  });

  it('выключение типа релиза сохраняется сразу, без диалога', async () => {
    setup('/settings/search');
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Remix' }));
    expect(lastPatch()).toEqual({ search: { skip_secondary_types: ['EP', 'Live', 'Remix'] } });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('включение ранее пропускавшегося типа спрашивает про переимпорт: «только новые»', async () => {
    setup('/settings/search');
    await userEvent.click(await screen.findByRole('checkbox', { name: 'EP' }));
    expect(m.putSettings).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog', { name: L('settings.reimport.title') });
    await userEvent.click(within(dialog).getByRole('button', { name: L('settings.reimport.newOnly') }));
    await waitFor(() => expect(lastPatch()).toEqual({ search: { skip_secondary_types: ['Live'] } }));
    expect(m.reimportArtists).not.toHaveBeenCalled();
  });

  it('«и для существующих» сохраняет и запускает переимпорт с toast', async () => {
    setup('/settings/search');
    m.reimportArtists.mockResolvedValue(7);
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Live' }));
    await userEvent.click(await screen.findByRole('button', { name: L('settings.reimport.all') }));
    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith(L('settings.reimport.started').replace('{count}', '7')),
    );
    expect(lastPatch()).toEqual({ search: { skip_secondary_types: ['EP'] } });
  });

  it('ошибка переимпорта — toast; отмена диалога ничего не сохраняет; ошибка сохранения не запускает переимпорт', async () => {
    setup('/settings/search');
    m.reimportArtists.mockRejectedValueOnce(new ApiError(500, 'internal', 'nope'));
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Live' }));
    await userEvent.click(await screen.findByRole('button', { name: L('settings.reimport.all') }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('nope'));

    vi.clearAllMocks();
    m.putSettings.mockResolvedValue(baseSettings());
    await userEvent.click(screen.getByRole('checkbox', { name: 'EP' }));
    await userEvent.click(await screen.findByRole('button', { name: L('common.cancel') }));
    expect(m.putSettings).not.toHaveBeenCalled();

    m.putSettings.mockRejectedValueOnce(new ApiError(500, 'internal', 'fail'));
    await userEvent.click(screen.getByRole('checkbox', { name: 'EP' }));
    await userEvent.click(await screen.findByRole('button', { name: L('settings.reimport.all') }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('fail'));
    expect(m.reimportArtists).not.toHaveBeenCalled();
  });
});

describe('MusicBrainz', () => {
  it('«Сбросить к публичному» отправляет публичный адрес и безопасные лимиты; на публичном адресе отключена', async () => {
    const s = baseSettings();
    s.musicbrainz = { base_url: 'http://mirror.local/ws/2/', burst: 10, max_concurrent: 8, rate_per_sec: 0 };
    setup('/settings/musicbrainz', s);
    await userEvent.click(await screen.findByRole('button', { name: L('settings.mb.resetAction') }));
    expect(lastPatch()).toEqual({
      musicbrainz: { base_url: 'https://musicbrainz.org/ws/2/', burst: 3, max_concurrent: 2, rate_per_sec: 1 },
    });
  });

  it('на публичном адресе кнопка сброса отключена', async () => {
    setup('/settings/musicbrainz');
    expect(await screen.findByRole('button', { name: L('settings.mb.resetAction') })).toBeDisabled();
  });
});

describe('обязательные текстовые поля', () => {
  it('очищенный адрес уходит пустой строкой, а не null', async () => {
    setup('/settings/musicbrainz');
    const url = await screen.findByRole('textbox', { name: L('settings.mb.baseUrl') });
    await userEvent.clear(url);
    await userEvent.tab();
    await waitFor(() => expect(lastPatch()).toEqual({ musicbrainz: { base_url: '' } }));
  });
});

describe('воспроизведение', () => {
  it('выбор кодека сохраняется сразу', async () => {
    setup('/settings/playback');
    await userEvent.click(await screen.findByRole('combobox', { name: L('settings.codec') }));
    await userEvent.click(await screen.findByRole('option', { name: 'MP3' }));
    expect(lastPatch()).toEqual({ playback: { transcode_lossy_codec: 'mp3' } });
  });
});

describe('хранилище', () => {
  it('показывает заполненность, закреплённое и сохраняет лимит кэша', async () => {
    setup('/settings/storage');
    const usage = await screen.findByTestId('storage-usage');
    expect(usage).toHaveTextContent('12 ГБ');
    expect(within(usage).getByRole('progressbar')).toHaveAttribute('aria-valuenow', String(12 * GB));
    const limit = screen.getByRole('spinbutton', { name: L('settings.cacheLimit') });
    await userEvent.clear(limit);
    await userEvent.type(limit, '80{Enter}');
    await waitFor(() => expect(lastPatch()).toEqual({ storage: { cache_limit_gb: 80 } }));
  });

  it('предупреждение, когда закреплённое не помещается; недоступность сведений', async () => {
    setup('/settings/storage');
    m.fetchStorage.mockResolvedValue(storage({ over_limit: true, used_bytes: 49 * GB }));
    expect(await screen.findByText(L('settings.overLimit'))).toBeInTheDocument();
  });

  it('ошибка загрузки сведений о хранилище не ломает раздел', async () => {
    setup('/settings/storage');
    m.fetchStorage.mockRejectedValue(new ApiError(500, 'internal', 'x'));
    expect(await screen.findByText(L('settings.storageUnavailable'))).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: L('settings.seeding') })).toBeInTheDocument();
  });
});

describe('производительность', () => {
  it('диапазон в описании; «По умолчанию» возвращает значение и скрывается на значении по умолчанию', async () => {
    const s = baseSettings();
    s.performance = { ...s.performance, discover_workers: 20 };
    setup('/settings/performance', s);
    const input = await screen.findByRole('spinbutton', { name: L('settings.perf.discover') });
    expect(input).toHaveValue(20);
    expect(screen.getAllByText(/1.*64/).length).toBeGreaterThan(0);
    const defaults = screen.getAllByRole('button', { name: L('settings.default') });
    expect(defaults).toHaveLength(1);
    await userEvent.click(defaults[0] as HTMLElement);
    expect(lastPatch()).toEqual({ performance: { discover_workers: 8 } });
  });

  it('restart_required показывает пояснение', async () => {
    setup('/settings/performance', { ...baseSettings(), restart_required: true });
    expect(await screen.findByTestId('restart-required')).toHaveTextContent(L('settings.restartRequired'));
  });
});

describe('внешний вид и о приложении', () => {
  it('тема переключается и сохраняется на устройстве', async () => {
    setup('/settings/appearance');
    await userEvent.click(screen.getByRole('radio', { name: L('settings.theme.light') }));
    expect(localStorage.getItem('nimbus:theme')).toBe('light');
    expect(document.documentElement).not.toHaveClass('dark');
    await userEvent.click(screen.getByRole('radio', { name: L('settings.theme.dark') }));
    expect(document.documentElement).toHaveClass('dark');
  });

  it('язык: список из 14 языков, выбор сохраняется', async () => {
    setup('/settings/appearance');
    await userEvent.click(screen.getByTestId('language-select'));
    expect(await screen.findAllByRole('option')).toHaveLength(14);
    await userEvent.click(screen.getByRole('option', { name: 'English' }));
    await waitFor(() => expect(localStorage.getItem('nimbus:locale')).toBe('en'));
  });

  it('о приложении: версии, сброс локальных данных с подтверждением и выход', async () => {
    setup('/settings/about');
    await waitFor(() => expect(screen.getByTestId('server-version')).toHaveTextContent('9.9.9'));
    expect(screen.getByTestId('client-version')).not.toBeEmptyDOMElement();
    const reset = vi.spyOn(crash, 'resetLocalData').mockResolvedValue(undefined);
    await userEvent.click(screen.getByRole('button', { name: L('settings.about.resetAction') }));
    const dialog = await screen.findByRole('dialog', { name: L('shell.resetData') });
    expect(reset).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: L('settings.about.resetAction') }));
    await waitFor(() => expect(reset).toHaveBeenCalledTimes(1));

    const logout = vi.spyOn(session, 'logout').mockResolvedValue(undefined as never);
    await userEvent.click(screen.getByRole('button', { name: L('login.logout') }));
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it('версия сервера недоступна — прочерк', async () => {
    m.fetchServerVersion.mockRejectedValueOnce(new ApiError(0, 'network', 'x'));
    setup('/settings/about');
    await waitFor(() => expect(screen.getByTestId('server-version')).toHaveTextContent('—'));
  });
});
