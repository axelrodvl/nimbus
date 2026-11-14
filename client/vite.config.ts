import babel from '@rolldown/plugin-babel';
import tailwindcss from '@tailwindcss/vite';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// `/api` (включая WebSocket) уходит на бэкенд; тот же прокси — в `vite preview`.
const backend = process.env.VITE_BACKEND_URL ?? 'http://localhost:8080';
const proxy = { '/api': { changeOrigin: true, target: backend, ws: true } };

export default defineConfig({
  // React Compiler: код из web/ написан в расчёте на него.
  plugins: [react(), babel({ presets: [reactCompilerPreset()] }), tailwindcss()],
  preview: { port: 4173, proxy },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: { port: 5173, proxy },
});
