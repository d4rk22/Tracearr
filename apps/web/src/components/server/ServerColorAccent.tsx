import type { CSSProperties, HTMLAttributes } from 'react';
import { useServer } from '@/hooks/useServer';
import { useServerColorMap } from '@/hooks/useServerColorMap';

interface ServerColorAccentProps extends HTMLAttributes<HTMLDivElement> {
  serverId: string;
}

export function ServerColorAccent({ serverId, children, style, ...rest }: ServerColorAccentProps) {
  const { isMultiServer } = useServer();
  const colorMap = useServerColorMap();
  const color = colorMap.get(serverId) ?? null;

  const accentStyle: CSSProperties | undefined =
    isMultiServer && color ? { ...style, boxShadow: `inset 3px 0 0 0 ${color}` } : style;

  return (
    <div style={accentStyle} {...rest}>
      {children}
    </div>
  );
}
