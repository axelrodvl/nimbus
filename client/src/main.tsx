import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { setUnauthorizedHandler } from '@/lib/app-data';
import { session } from '@/lib/auth';
import { startPwa } from '@/lib/pwa';
import { initI18n } from '@/lib/i18n/store';
import { applyTheme, readTheme } from '@/lib/theme/theme';
import { App } from './app';
import './styles/index.css';

applyTheme(readTheme());
// До загрузки словаря показывается en; язык переключится сам.
const i18nReady = initI18n();

// 401 в любом запросе и в движке синхронизации → выход на экран входа.
setUnauthorizedHandler(() => void session.onUnauthorized());
// Сессия: кэш → сверка с сервером → при входе данные и сокет стартуют сами.
void session.start();

// Service worker, обновления, установка.
startPwa(i18nReady);

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
