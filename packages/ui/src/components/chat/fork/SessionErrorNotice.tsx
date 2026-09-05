// FORK: replaces upstream's SessionErrorNotice so an unanswered optimistic
// prompt stays a connection-aware waiting state until OpenCode confirms idle.
import React from 'react';
import type { Message } from '@opencode-ai/sdk/v2';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { isSyntheticPart } from '@/lib/messages/synthetic';
import { showOpenCodeStatus } from '@/lib/openCodeStatus';
import { opencodeClient } from '@/lib/opencode/client';
import { useConfigStore } from '@/stores/useConfigStore';
import { useLatestSessionError } from '@/sync/notification-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import {
  applySessionStatusSnapshot,
  useDirectoryStore,
  useSessionStatus,
} from '@/sync/sync-context';

interface SessionErrorNoticeProps {
  sessionId: string;
  directory?: string;
}

export const WAITING_AFTER_MS = 2_000;
export const VERIFY_AFTER_MS = 20_000;
const CHECK_RETRY_MS = 10_000;
const MAX_CHECK_ATTEMPTS = 3;

type LastMessageState = {
  id: string;
  role: Message['role'];
  timestamp: number;
  hasError: boolean;
  providerID: string;
  modelID: string;
  agent: string;
  variant: string;
  singleText: string | null;
} | null;

type CheckState =
  | { phase: 'unchecked'; attempts: number; retryAt: number | null }
  | { phase: 'checking'; attempts: number; keepWarning: boolean }
  | { phase: 'confirmed-idle'; attempts: number; retryAt: number | null };

const INITIAL_CHECK_STATE: CheckState = { phase: 'unchecked', attempts: 0, retryAt: null };

const sameLastMessageState = (left: LastMessageState, right: LastMessageState): boolean => {
  if (!left || !right) return left === right;
  return left.id === right.id
    && left.role === right.role
    && left.timestamp === right.timestamp
    && left.hasError === right.hasError
    && left.providerID === right.providerID
    && left.modelID === right.modelID
    && left.agent === right.agent
    && left.variant === right.variant
    && left.singleText === right.singleText;
};

const useLastMessageState = (sessionId: string, directory?: string): LastMessageState => {
  const store = useDirectoryStore(directory);
  const cacheRef = React.useRef<LastMessageState>(null);
  const getSnapshot = React.useCallback((): LastMessageState => {
    if (!sessionId) return null;
    const messages = store.getState().message[sessionId];
    const message = messages && messages.length > 0 ? messages[messages.length - 1] : null;
    if (!message) {
      cacheRef.current = null;
      return null;
    }

    const parts = store.getState().part[message.id] ?? [];
    const onlyPart = parts.length === 1 ? parts[0] : undefined;
    const singleText = message.role === 'user'
      && onlyPart?.type === 'text'
      && !isSyntheticPart(onlyPart)
      ? onlyPart.text
      : null;
    const timestamp = message.role === 'user'
      ? message.time.created
      : Math.max(0, message.time.completed ?? 0) || message.time.created;
    const next: LastMessageState = {
      id: message.id,
      role: message.role,
      timestamp,
      hasError: message.role === 'assistant' && Boolean(message.error),
      providerID: message.role === 'user' ? message.model.providerID : '',
      modelID: message.role === 'user' ? message.model.modelID : '',
      agent: message.role === 'user' ? message.agent : '',
      variant: message.role === 'user' ? message.model.variant ?? '' : '',
      singleText,
    };
    const cached = cacheRef.current;
    if (sameLastMessageState(cached, next)) return cached;
    cacheRef.current = next;
    return next;
  }, [sessionId, store]);
  const subscribe = React.useCallback((notify: () => void) => {
    if (!sessionId) return () => undefined;
    return store.subscribe(notify);
  }, [sessionId, store]);
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};

const MutedNotice: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="chat-message-column">
    <div role="status" className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
      <Icon name="loader-4" className="size-4 shrink-0 animate-spin" />
      <span>{children}</span>
    </div>
  </div>
);

export const SessionErrorNotice: React.FC<SessionErrorNoticeProps> = ({ sessionId, directory }) => {
  const { t } = useI18n();
  const latestError = useLatestSessionError(sessionId);
  const status = useSessionStatus(sessionId, directory);
  const store = useDirectoryStore(directory);
  const lastMessage = useLastMessageState(sessionId, directory);
  const connectionPhase = useConfigStore((state) => state.connectionPhase);
  const isConnected = useConfigStore((state) => state.isConnected);
  const [now, setNow] = React.useState(() => Date.now());
  const [checkState, setCheckState] = React.useState<CheckState>(INITIAL_CHECK_STATE);
  const [isResending, setIsResending] = React.useState(false);
  const requestTokenRef = React.useRef(0);
  const generation = `${sessionId}\u0000${directory ?? ''}\u0000${lastMessage?.id ?? ''}`;
  const generationRef = React.useRef(generation);
  generationRef.current = generation;

  // Unknown status (absent from the map after a snapshot replace) is "not
  // active", never "idle": it may hide a reply-wait judgement but must not
  // hide an error OpenCode actually reported.
  const locallyActive = status !== undefined && status.type !== 'idle';
  const reportedError = latestError && !locallyActive
    && (!lastMessage || latestError.time >= lastMessage.timestamp)
    && !(lastMessage?.role === 'assistant' && lastMessage.hasError)
    ? latestError
    : null;

  React.useEffect(() => {
    requestTokenRef.current += 1;
    setCheckState(INITIAL_CHECK_STATE);
    setIsResending(false);
    setNow(Date.now());
    return () => {
      requestTokenRef.current += 1;
    };
  }, [connectionPhase, generation, isConnected, status?.type]);

  const runAuthoritativeCheck = React.useCallback(async () => {
    if (checkState.phase === 'checking') return;
    const requestToken = ++requestTokenRef.current;
    const capturedGeneration = generation;
    const attempts = checkState.attempts + 1;
    const keepWarning = checkState.phase === 'confirmed-idle';
    setCheckState({ phase: 'checking', attempts, keepWarning });
    const snapshot = await opencodeClient.getSessionStatusForDirectory(directory);
    if (requestToken !== requestTokenRef.current || capturedGeneration !== generationRef.current) return;

    if (snapshot === null) {
      const retryAt = attempts < MAX_CHECK_ATTEMPTS ? Date.now() + CHECK_RETRY_MS : null;
      setCheckState(keepWarning
        ? { phase: 'confirmed-idle', attempts, retryAt }
        : { phase: 'unchecked', attempts, retryAt });
      setNow(Date.now());
      return;
    }

    const serverStatus = snapshot[sessionId];
    if (serverStatus && serverStatus.type !== 'idle') {
      applySessionStatusSnapshot(store, snapshot, [sessionId], 'monotonic');
      setCheckState(INITIAL_CHECK_STATE);
      return;
    }
    setCheckState({ phase: 'confirmed-idle', attempts, retryAt: null });
  }, [checkState, directory, generation, sessionId, store]);

  const elapsed = lastMessage?.role === 'user'
    ? Math.max(now, Date.now()) - lastMessage.timestamp
    : 0;
  const connected = connectionPhase === 'connected' && isConnected;

  React.useEffect(() => {
    if (reportedError || lastMessage?.role !== 'user' || !connected || locallyActive) return undefined;
    let wakeAt: number | null = null;
    if (elapsed < WAITING_AFTER_MS) wakeAt = lastMessage.timestamp + WAITING_AFTER_MS;
    else if (elapsed < VERIFY_AFTER_MS) wakeAt = lastMessage.timestamp + VERIFY_AFTER_MS;
    else if (checkState.phase !== 'checking' && checkState.retryAt !== null) wakeAt = checkState.retryAt;
    if (wakeAt === null) return undefined;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, wakeAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [checkState, connected, elapsed, lastMessage, locallyActive, reportedError]);

  React.useEffect(() => {
    if (reportedError || lastMessage?.role !== 'user' || !connected || locallyActive) return;
    if (elapsed < VERIFY_AFTER_MS || checkState.phase === 'checking') return;
    if (checkState.attempts >= MAX_CHECK_ATTEMPTS) return;
    if (checkState.phase === 'confirmed-idle' && checkState.retryAt === null) return;
    if (checkState.retryAt !== null && checkState.retryAt > Date.now()) return;
    void runAuthoritativeCheck();
  }, [checkState, connected, elapsed, lastMessage?.role, locallyActive, reportedError, runAuthoritativeCheck]);

  const handleSendAgain = React.useCallback(async () => {
    if (!lastMessage?.singleText || !lastMessage.providerID || !lastMessage.modelID) return;
    setIsResending(true);
    try {
      await useSessionUIStore.getState().sendMessage(
        lastMessage.singleText,
        lastMessage.providerID,
        lastMessage.modelID,
        lastMessage.agent || undefined,
        undefined,
        undefined,
        undefined,
        lastMessage.variant || undefined,
      );
    } catch {
      // A rejected resend is rolled back and recorded by the send path
      // (send-failure-log); the composer stays silent by design.
    } finally {
      if (generationRef.current === generation) setIsResending(false);
    }
  }, [generation, lastMessage]);

  if (reportedError) {
    const detail = reportedError.error?.message ?? t('chat.sessionError.noDetails');
    const name = reportedError.error?.name;
    return (
      <div className="chat-message-column">
        <div role="status" className="mt-3 max-w-full break-words rounded-2xl border border-[var(--status-error-border)] bg-[var(--status-error-background)] px-4 py-3 text-base leading-relaxed">
          <div className="flex items-start gap-3">
            <Icon name="error-warning" className="mt-0.5 size-4 shrink-0 text-[var(--status-error)]" />
            <div className="min-w-0 flex-1 break-words">
              <div className="font-medium text-foreground">{t('chat.sessionError.title')}</div>
              <div className="mt-1 text-foreground/80">{name ? `${name}: ${detail}` : detail}</div>
            </div>
          </div>
        </div>
      </div>
    );
  }
  if (lastMessage?.role !== 'user') return null;
  if (!connected) return <MutedNotice>{t('fork.replyNotice.reconnecting')}</MutedNotice>;
  if (locallyActive || elapsed < WAITING_AFTER_MS) return null;
  const warningConfirmed = checkState.phase === 'confirmed-idle'
    || (checkState.phase === 'checking' && checkState.keepWarning);
  if (!warningConfirmed) {
    return <MutedNotice>{t('fork.replyNotice.waiting')}</MutedNotice>;
  }

  const actionBusy = checkState.phase === 'checking' || isResending;
  const canSendAgain = lastMessage.singleText !== null && Boolean(lastMessage.providerID && lastMessage.modelID);
  return (
    <div className="chat-message-column">
      <div role="status" className="mt-3 max-w-full break-words rounded-2xl border border-[var(--status-warning-border)] bg-[var(--status-warning-background)] px-4 py-3 text-base leading-relaxed">
        <div className="flex items-start gap-3">
          <Icon name="error-warning" className="mt-0.5 size-4 shrink-0 text-[var(--status-warning)]" />
          <div className="min-w-0 flex-1 break-words">
            <div className="font-medium text-foreground">{t('fork.replyNotice.noReplyTitle')}</div>
            <div className="mt-1 text-foreground/80">
              {t('fork.replyNotice.noReplyBody', { seconds: Math.floor(elapsed / 1000) })}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {canSendAgain && (
                <Button size="sm" onClick={() => void handleSendAgain()} disabled={actionBusy}>
                  {isResending && <Icon name="loader-4" className="size-4 animate-spin" />}
                  {t('fork.replyNotice.sendAgain')}
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => void runAuthoritativeCheck()} disabled={actionBusy}>
                {checkState.phase === 'checking' && <Icon name="loader-4" className="size-4 animate-spin" />}
                {t('fork.replyNotice.checkAgain')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void showOpenCodeStatus()} disabled={actionBusy}>
                {t('fork.replyNotice.statusReport')}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
