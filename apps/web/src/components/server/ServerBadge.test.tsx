import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Server } from '@tracearr/shared';
import { ServerBadge } from './ServerBadge';

const server: Server = {
  id: 'srv-a',
  name: 'Connors Plex',
  type: 'plex',
  url: '',
  color: '#E5A00D',
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('ServerBadge', () => {
  it('renders the server name in the default variant', () => {
    render(<ServerBadge server={server} />);
    expect(screen.getByText('Connors Plex')).toBeInTheDocument();
  });

  it('renders only a color dot in compact variant (no visible name)', () => {
    render(<ServerBadge server={server} variant="compact" />);
    expect(screen.queryByText('Connors Plex')).not.toBeInTheDocument();
    const dot = screen.getByLabelText('Connors Plex');
    expect(dot).toHaveStyle({ backgroundColor: '#E5A00D' });
  });

  it('uses outlined styling in the outlined variant', () => {
    const { container } = render(<ServerBadge server={server} variant="outlined" />);
    const root = container.firstChild as HTMLElement;
    expect(root.className).toMatch(/border/);
    expect(root.className).toMatch(/text-muted-foreground/);
  });

  it('falls back gracefully when color is null (compact variant)', () => {
    const colorless: Server = { ...server, color: null };
    render(<ServerBadge server={colorless} variant="compact" />);
    const dot = screen.getByLabelText('Connors Plex');
    expect(dot.getAttribute('style') ?? '').not.toMatch(/background-color/);
  });

  it('marks the decorative dot in default/outlined variants as aria-hidden so the name is not double-announced', () => {
    const { container } = render(<ServerBadge server={server} />);
    const dot = container.querySelector('span[aria-hidden="true"]');
    expect(dot).not.toBeNull();
  });
});
