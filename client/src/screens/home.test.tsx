import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { Home } from './home';

describe('Home', () => {
  it('показывает название и ставит заголовок вкладки', () => {
    renderWithProviders(<Home />, { path: '/' });
    expect(screen.getByRole('heading', { name: 'Nimbus' })).toBeInTheDocument();
    expect(document.title).toBe('Nimbus · Nimbus');
  });
});
