import { ThemeToggle } from '@/components/ui/theme-toggle';

// Заглушка: оболочку приложения (навигация, вход) делает шаг 38.
export function Home() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 p-6">
      <img src="/logo.svg" alt="" width={64} height={64} />
      <h1>Nimbus</h1>
      <ThemeToggle />
    </main>
  );
}
