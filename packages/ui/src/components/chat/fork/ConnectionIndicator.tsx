// FORK: keeps event-stream loss visible across the chat surface without
// treating a client-observed transport state as an OpenCode error.
import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useConfigStore } from '@/stores/useConfigStore';

export const CONNECTION_INDICATOR_SHOW_DELAY_MS = 1_500;
export const RECONNECTED_FLASH_MS = 2_000;
const ELAPSED_TICK_MS = 1_000;

type IndicatorState =
  | { phase: 'hidden' }
  | { phase: 'reconnecting'; disconnectedAt: number }
  | { phase: 'reconnected' };

export const ConnectionIndicator: React.FC = React.memo(() => {
  const { t } = useI18n();
  const connectionPhase = useConfigStore((state) => state.connectionPhase);
  const hasEverConnected = useConfigStore((state) => state.hasEverConnected);
  const [indicator, setIndicator] = React.useState<IndicatorState>({ phase: 'hidden' });
  const [now, setNow] = React.useState(() => Date.now());
  const disconnectedAtRef = React.useRef<number | null>(null);
  const wasVisibleRef = React.useRef(false);
  const reconnecting = hasEverConnected && connectionPhase === 'reconnecting';

  React.useEffect(() => {
    if (reconnecting) {
      if (disconnectedAtRef.current !== null) return undefined;
      const disconnectedAt = Date.now();
      disconnectedAtRef.current = disconnectedAt;
      wasVisibleRef.current = false;
      setIndicator({ phase: 'hidden' });
      const timer = window.setTimeout(() => {
        wasVisibleRef.current = true;
        setNow(Date.now());
        setIndicator({ phase: 'reconnecting', disconnectedAt });
      }, CONNECTION_INDICATOR_SHOW_DELAY_MS);
      return () => window.clearTimeout(timer);
    }

    disconnectedAtRef.current = null;
    const shouldFlash = connectionPhase === 'connected' && wasVisibleRef.current;
    wasVisibleRef.current = false;
    if (!shouldFlash) {
      setIndicator({ phase: 'hidden' });
      return undefined;
    }

    setIndicator({ phase: 'reconnected' });
    const timer = window.setTimeout(() => setIndicator({ phase: 'hidden' }), RECONNECTED_FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [connectionPhase, reconnecting]);

  React.useEffect(() => {
    if (indicator.phase !== 'reconnecting') return undefined;
    const interval = window.setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS);
    return () => window.clearInterval(interval);
  }, [indicator.phase]);

  if (indicator.phase === 'hidden') return null;

  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center px-3">
      <div
        role="status"
        aria-live="polite"
        className="oc-glass-popover flex max-w-full items-center gap-2 whitespace-nowrap rounded-full border border-[var(--interactive-border)] px-3 py-1.5 text-sm text-muted-foreground shadow-sm"
      >
        {indicator.phase === 'reconnecting' ? (
          <>
            <Icon name="loader-4" className="size-3.5 shrink-0 animate-spin" />
            <span className="truncate">
              {t('fork.connection.reconnecting', {
                seconds: Math.floor((now - indicator.disconnectedAt) / 1_000),
              })}
            </span>
          </>
        ) : (
          <span>{t('fork.connection.reconnected')}</span>
        )}
      </div>
    </div>
  );
});

ConnectionIndicator.displayName = 'ConnectionIndicator';
