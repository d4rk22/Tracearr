import { useMemo } from 'react';
import { useServer } from './useServer';

export function useServerColorMap(): Map<string, string | null> {
  const { selectedServers } = useServer();
  return useMemo(
    () => new Map(selectedServers.map((s) => [s.id, s.color ?? null])),
    [selectedServers]
  );
}
