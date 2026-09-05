// FORK: live tokens-per-second readout inside the floating "working" chip
// (StatusRow). Port of JDScript/opencode's fork-tps; fed by text growth in
// the sync store, one flush after each delta. The chip exists exactly when a
// rate can exist, so the meter never toggles a row of its own.
import React from 'react';
import type { Part } from '@opencode-ai/sdk/v2';

import { useChatColumnSession } from '@/components/chat/chatColumnSession';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { getActiveAssistantContext } from '@/hooks/useAssistantStatus';
import { useI18n } from '@/lib/i18n';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useDirectoryStore } from '@/sync/sync-context';
import type { DirectoryStore } from '@/sync/child-store';

import {
  formatTps,
  measureGrowth,
  smoothRate,
  STALE_MS,
  tokensPerSecond,
  type TpsSample,
  WINDOW_MS,
} from './tps-math';

const proseParts = (parts: readonly Part[]) => parts.filter(
  (part): part is Extract<Part, { type: 'text' | 'reasoning' }> => part.type === 'text' || part.type === 'reasoning',
);

export const LiveTps: React.FC<{ isWorking: boolean }> = ({ isWorking }) => {
  const { t } = useI18n();
  const chatColumnSession = useChatColumnSession();
  const liveSessionId = useSessionUIStore((state) => state.currentSessionId);
  const liveSessionDirectory = useSessionUIStore((state) => state.currentSessionDirectory);
  const sessionId = chatColumnSession ? chatColumnSession.sessionId : liveSessionId;
  const directory = chatColumnSession ? chatColumnSession.directory : liveSessionDirectory;
  const store = useDirectoryStore(directory ?? undefined);
  const samplesRef = React.useRef<TpsSample[]>([]);
  const seenRef = React.useRef<Map<string, number>>(new Map());
  const assistantIdRef = React.useRef<string | null>(null);
  const smoothedRef = React.useRef<number | undefined>(undefined);
  const lastTickAtRef = React.useRef(0);
  const [rate, setRate] = React.useState<number | undefined>(undefined);

  React.useEffect(() => {
    const reset = () => {
      samplesRef.current = [];
      seenRef.current = new Map();
      assistantIdRef.current = null;
      smoothedRef.current = undefined;
      lastTickAtRef.current = Date.now();
      setRate(undefined);
    };

    reset();
    if (!isWorking || !sessionId) return undefined;

    const processState = (state: DirectoryStore, previous?: DirectoryStore) => {
      if (!previous || state.message[sessionId] !== previous.message[sessionId]) {
        const assistantId = getActiveAssistantContext(state.message[sessionId] ?? []).assistantId;
        if (assistantId !== assistantIdRef.current) {
          reset();
          assistantIdRef.current = assistantId;
        }
      }

      const assistantId = assistantIdRef.current;
      if (!assistantId || (previous && state.part[assistantId] === previous.part[assistantId])) return;

      const growth = measureGrowth(proseParts(state.part[assistantId] ?? []), seenRef.current);
      seenRef.current = growth.seen;
      if (growth.tokens === 0) return;

      const now = Date.now();
      samplesRef.current.push({ tokens: growth.tokens, at: now });
      if (samplesRef.current.length > 256) {
        const cutoff = now - WINDOW_MS - STALE_MS;
        samplesRef.current = samplesRef.current.filter((sample) => sample.at >= cutoff);
      }
    };

    processState(store.getState());
    const unsubscribe = store.subscribe(processState);
    return () => {
      unsubscribe();
      reset();
    };
  }, [store, sessionId, isWorking]);

  React.useEffect(() => {
    if (!isWorking) return undefined;
    const updateRate = () => {
      const now = Date.now();
      const raw = tokensPerSecond(samplesRef.current, now);
      smoothedRef.current = smoothRate(smoothedRef.current, raw, now - lastTickAtRef.current);
      lastTickAtRef.current = now;
      setRate(smoothedRef.current);
    };
    updateRate();
    const timer = window.setInterval(updateRate, 1000);
    return () => window.clearInterval(timer);
  }, [isWorking]);

  if (!isWorking) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex flex-none items-baseline gap-1 whitespace-nowrap typography-meta text-muted-foreground tabular-nums">
          <span className="text-muted-foreground/70">{t('fork.tps.label')}</span>
          <span className="min-w-[4ch] text-right font-mono">{formatTps(rate)}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{t('fork.tps.title')}</TooltipContent>
    </Tooltip>
  );
};
