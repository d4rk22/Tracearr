import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useServerColorMap } from './useServerColorMap';

vi.mock('./useServer', () => ({
  useServer: vi.fn(),
}));

import { useServer } from './useServer';

const mockUseServer = vi.mocked(useServer);

function fakeServer(id: string, color: string | null = null) {
  return {
    id,
    name: `Server ${id}`,
    type: 'plex' as const,
    url: '',
    color,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('useServerColorMap', () => {
  it('returns a map keyed by serverId with each server color', () => {
    mockUseServer.mockReturnValue({
      selectedServers: [fakeServer('a', '#E5A00D'), fakeServer('b', '#AA5CC3')],
    } as ReturnType<typeof useServer>);

    const { result } = renderHook(() => useServerColorMap());
    expect(result.current.get('a')).toBe('#E5A00D');
    expect(result.current.get('b')).toBe('#AA5CC3');
  });

  it('preserves null color when a server has no color set', () => {
    mockUseServer.mockReturnValue({
      selectedServers: [fakeServer('a', null)],
    } as ReturnType<typeof useServer>);

    const { result } = renderHook(() => useServerColorMap());
    expect(result.current.get('a')).toBeNull();
  });

  it('returns the same Map reference when selectedServers is referentially stable', () => {
    const servers = [fakeServer('a', '#000')];
    mockUseServer.mockReturnValue({
      selectedServers: servers,
    } as ReturnType<typeof useServer>);

    const { result, rerender } = renderHook(() => useServerColorMap());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
