import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { dropLegacyAlbumStore } from '@/lib/acquisition/cache';
import { setUnauthorizedHandler } from '@/lib/app-data';
import { session } from '@/lib/auth';
import { primeShownFromCache } from '@/lib/library/cover';
import { noteNavigation, startWarming } from '@/lib/library/warm-runtime';
import { startAppLifecycle } from '@/lib/platform/app-lifecycle';
import { startPwa } from '@/lib/pwa';
import { initI18n } from '@/lib/i18n/store';
import { applyTheme, readTheme } from '@/lib/theme/theme';
import { App } from './app';
import { router } from './router';
import './styles/index.css';

applyTheme(readTheme());
dropLegacyAlbumStore();
// До загрузки словаря показывается en; язык переключится сам.
const i18nReady = initI18n();

// 401 в любом запросе и в движке синхронизации → выход на экран входа.
setUnauthorizedHandler(() => void session.onUnauthorized());
// Сессия: кэш → сверка с сервером → при входе данные и сокет стартуют сами.
void session.start();

// Service worker, обновления, установка.
startPwa(i18nReady);
startAppLifecycle();

// Картинки из кэша service worker рисуются в первом кадре и после перезапуска; миниатюры библиотеки прогреваются
// в фоне (пауза при навигации и воспроизведении со стрима, стоп при экономии трафика).
const idle = (fn: () => void) =>
  'requestIdleCallback' in window ? window.requestIdleCallback(fn) : setTimeout(fn, 200);
idle(() => void primeShownFromCache());
router.subscribe(noteNavigation);
startWarming();

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
