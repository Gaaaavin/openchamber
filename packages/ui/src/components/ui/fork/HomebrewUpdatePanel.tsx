import React, { useEffect, useState } from 'react';
import { z } from 'zod';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { copyTextToClipboard } from '@/lib/clipboard';
import { getDesktopBridge, revealDesktopPath } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';

type HomebrewUpdatePhase = 'idle' | 'update' | 'fetch' | 'install' | 'done' | 'failed';

type HomebrewUpdateStatus = {
  phase: HomebrewUpdatePhase;
  line?: string;
  logPath?: string;
  message?: string;
};

type HomebrewUpdatePanelProps = {
  updateCommand: string;
  downloading: boolean;
  error: string | null;
  onUpdate: () => void;
};

const emittedStatusSchema = z.object({
  phase: z.enum(['update', 'fetch', 'install', 'done', 'failed']),
  line: z.string().optional(),
  logPath: z.string().optional(),
  message: z.string().optional(),
});

export const HomebrewUpdatePanel: React.FC<HomebrewUpdatePanelProps> = ({
  updateCommand,
  downloading,
  error,
  onUpdate,
}) => {
  const { t } = useI18n();
  const [status, setStatus] = useState<HomebrewUpdateStatus>({ phase: 'idle' });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let mounted = true;
    let unlisten: (() => void) | undefined;
    const bridge = getDesktopBridge();
    if (!bridge?.listen) return;

    void bridge.listen('openchamber:fork-update-status', (event) => {
      const parsed = emittedStatusSchema.safeParse(event.payload);
      if (parsed.success && mounted) setStatus(parsed.data);
    }).then((dispose) => {
      if (mounted) unlisten = dispose;
      else dispose();
    });

    return () => {
      mounted = false;
      unlisten?.();
    };
  }, []);

  const copyCommand = async () => {
    const result = await copyTextToClipboard(updateCommand);
    if (!result.ok) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  const phaseLabel = status.phase === 'update'
    ? t('fork.update.phase.update')
    : t('fork.update.phase.fetch');
  const failure = error || (status.phase === 'failed' ? status.message : null);
  const openLog = () => {
    if (status.logPath) void revealDesktopPath(status.logPath);
  };

  return (
    <div className="mt-4 space-y-3">
      {status.phase === 'idle' && (
        <>
          <div className="flex items-center gap-2 p-1 pl-3 bg-[var(--surface-elevated)]/50 rounded-md border border-[var(--surface-subtle)]">
            <code className="flex-1 overflow-x-auto whitespace-nowrap font-mono text-sm text-foreground">
              {updateCommand}
            </code>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => void copyCommand()}
              aria-label={copied ? t('updateDialog.actions.copied') : t('updateDialog.actions.copyCommand')}
              title={copied ? t('updateDialog.actions.copied') : t('updateDialog.actions.copyCommand')}
            >
              <Icon name={copied ? 'check' : 'clipboard'} className="size-4" />
            </Button>
          </div>
          <Button type="button" onClick={onUpdate} disabled={downloading || status.phase !== 'idle'}>
            {t('fork.update.updateNow')}
          </Button>
          <p className="typography-meta text-muted-foreground">{t('fork.update.hint')}</p>
        </>
      )}

      {(status.phase === 'update' || status.phase === 'fetch') && (
        <div className="min-w-0 space-y-2">
          <div className="flex items-center gap-2">
            <Icon name="loader-4" className="size-4 shrink-0 animate-spin text-[var(--primary-base)]" />
            <span aria-live="polite" className="typography-meta text-foreground">{phaseLabel}</span>
          </div>
          {status.line && <p className="truncate font-mono text-xs text-muted-foreground">{status.line}</p>}
        </div>
      )}

      {status.phase === 'install' && (
        <div className="flex items-center gap-2">
          <Icon name="loader-4" className="size-4 shrink-0 animate-spin text-[var(--primary-base)]" />
          <span aria-live="polite" className="typography-meta text-foreground">{t('fork.update.phase.install')}</span>
        </div>
      )}

      {status.phase === 'done' && (
        <p className="typography-meta text-muted-foreground">{t('fork.update.nothingToDo')}</p>
      )}

      {failure && (
        <div className="space-y-2 rounded-lg border border-[var(--status-error-border)] bg-[var(--status-error-background)] p-3">
          <p className="text-sm text-[var(--status-error)]">{failure}</p>
          {status.logPath && (
            <Button type="button" variant="link" size="sm" onClick={openLog}>
              {t('fork.update.openLog')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
};
