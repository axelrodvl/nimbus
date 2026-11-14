import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initI18n } from '@/lib/i18n/store';
import { applyTheme, readTheme } from '@/lib/theme/theme';
import { App } from './app';
import './styles/index.css';

applyTheme(readTheme());
// До загрузки словаря показывается en; язык переключится сам.
void initI18n();

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
