import { createBrowserRouter } from 'react-router';
import { Home } from '@/screens/home';

export const routes = [{ element: <Home />, path: '/' }];

export const router = createBrowserRouter(routes);
