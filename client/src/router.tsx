import { createBrowserRouter, type RouteObject } from 'react-router';
import { appRoutes } from '@/app-routes';
import { RouteError } from '@/components/route-error';
import { LoginRoute, RequireSession } from '@/components/session-routes';
import { NotFound } from '@/screens/not-found';

export const routes: RouteObject[] = [
  { element: <LoginRoute />, errorElement: <RouteError />, path: '/login' },
  {
    children: [...appRoutes, { element: <NotFound />, path: '*' }],
    element: <RequireSession />,
    errorElement: <RouteError />,
  },
];

export const router = createBrowserRouter(routes);
