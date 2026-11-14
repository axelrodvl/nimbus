import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { DevUi } from './dev-ui';

describe('галерея /dev/ui', () => {
  it('показывает все примитивы форм', () => {
    renderWithProviders(<DevUi />);
    expect(screen.getByTestId('ui-gallery')).toBeInTheDocument();
    for (const role of ['switch', 'combobox', 'radiogroup', 'slider', 'progressbar', 'tablist', 'checkbox']) {
      expect(screen.getAllByRole(role).length).toBeGreaterThan(0);
    }
  });
});
