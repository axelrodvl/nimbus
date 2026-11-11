import { logout } from '@/app/actions/auth';
import { Button } from '@/components/ui/button';
import { getT } from '@/lib/i18n/server';

export async function LogoutButton() {
  const t = await getT();
  return (
    <form action={logout} className="mt-8">
      <Button type="submit" variant="secondary">
        {t('login.logout')}
      </Button>
    </form>
  );
}
