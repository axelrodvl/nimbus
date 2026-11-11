import { logout } from '@/app/actions/auth';
import { Button } from '@/components/ui/button';

export function LogoutButton() {
  return (
    <form action={logout} className="mt-8">
      <Button type="submit" variant="secondary">
        Выйти
      </Button>
    </form>
  );
}
