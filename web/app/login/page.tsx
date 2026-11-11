import { LoginForm } from './login-form';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Вход',
};

export default function LoginPage() {
  return (
    <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 px-6">
      <h1 className="text-3xl font-bold">Nimbus</h1>
      <LoginForm />
    </main>
  );
}
