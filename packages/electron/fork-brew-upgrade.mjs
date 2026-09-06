// FORK: Homebrew owns installation and replacement of the ad-hoc-signed macOS app.
import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const FORK_CASK = 'openchamber-xinhao';
export const RELAUNCH_SCRIPT = '"$1" upgrade --cask "$2"; status=$?; /usr/bin/open "$3"; exit $status';

let upgradeInFlight = false;

export const resolveBrewExecutable = ({ env = process.env, existsSync = fs.existsSync } = {}) => {
  const candidates = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'];
  for (const directory of String(env.PATH || '').split(path.delimiter)) {
    if (directory) candidates.push(path.join(directory, 'brew'));
  }
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
};

export const appBundleFromExecutable = (exePath) => {
  const match = /^(.+?\.app)(?:\/|$)/.exec(String(exePath || ''));
  return match?.[1] ?? null;
};

export const brewEnv = (base) => ({
  ...base,
  HOMEBREW_NO_ENV_HINTS: '1',
  HOMEBREW_NO_COLOR: '1',
  HOMEBREW_NO_AUTO_UPDATE: '1',
  HOMEBREW_NO_INSTALL_CLEANUP: '1',
});

const outputTail = (lines, fallback) => {
  const message = lines.filter(Boolean).slice(-3).join('\n') || fallback;
  return message.length <= 400 ? message : message.slice(-400);
};

const defaultReadLogTail = (logPath) => {
  try {
    return outputTail(fs.readFileSync(logPath, 'utf8').split(/\r?\n/), 'Homebrew upgrade failed.');
  } catch {
    return 'Homebrew upgrade failed.';
  }
};

const runBrewPhase = ({ brew, args, env, phase, spawn, onStatus }) => new Promise((resolve, reject) => {
  const child = spawn(brew, args, {
    env: brewEnv(env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderrLines = [];
  let settled = false;

  const finish = (error) => {
    if (settled) return;
    settled = true;
    if (error) reject(error);
    else resolve();
  };

  const readLines = (stream, stderr = false) => {
    let pending = '';
    stream?.setEncoding?.('utf8');
    stream?.on?.('data', (chunk) => {
      const parts = `${pending}${chunk}`.split(/\r?\n/);
      pending = parts.pop() ?? '';
      for (const rawLine of parts) {
        const line = rawLine.trim();
        if (!line) continue;
        if (stderr) {
          stderrLines.push(line);
          if (stderrLines.length > 3) stderrLines.shift();
        }
        onStatus({ phase, line });
      }
    });
    return () => {
      const line = pending.trim();
      if (!line) return;
      if (stderr) {
        stderrLines.push(line);
        if (stderrLines.length > 3) stderrLines.shift();
      }
      onStatus({ phase, line });
    };
  };

  const flushStdout = readLines(child.stdout);
  const flushStderr = readLines(child.stderr, true);
  child.once('error', (error) => finish(error));
  child.once('close', (code) => {
    flushStdout();
    flushStderr();
    if (code === 0) {
      finish();
      return;
    }
    finish(new Error(outputTail(stderrLines, `Homebrew exited with code ${code ?? 'unknown'}.`)));
  });
});

export const runForkBrewUpgrade = async ({
  cask = FORK_CASK,
  appBundle,
  logPath,
  env = process.env,
  spawn = childProcess.spawn,
  openLog = fs.openSync,
  closeLog = fs.closeSync,
  readLogTail = defaultReadLogTail,
  onStatus = () => {},
  /** Relax the host app's quit guards; return the function that restores them. */
  beforeHandoff = () => () => {},
  resolveBrew = resolveBrewExecutable,
} = {}) => {
  if (upgradeInFlight) {
    throw new Error('A Homebrew update is already in progress.');
  }

  const rejectPrecondition = (message) => {
    onStatus({ phase: 'failed', message });
    throw new Error(message);
  };
  if (process.platform !== 'darwin') rejectPrecondition('Homebrew app updates are only supported on macOS.');
  const brew = resolveBrew({ env });
  if (!brew) rejectPrecondition('Homebrew was not found. Install Homebrew or run the update command in Terminal.');
  if (!appBundle) rejectPrecondition('The app bundle could not be located. Homebrew updates are unavailable in development builds.');
  if (!logPath) rejectPrecondition('The Homebrew update log path is unavailable.');

  upgradeInFlight = true;
  try {
    onStatus({ phase: 'update' });
    await runBrewPhase({ brew, args: ['update'], env, phase: 'update', spawn, onStatus });
    onStatus({ phase: 'fetch' });
    await runBrewPhase({ brew, args: ['fetch', '--cask', cask], env, phase: 'fetch', spawn, onStatus });
  } catch (error) {
    upgradeInFlight = false;
    const message = error instanceof Error ? error.message : String(error);
    onStatus({ phase: 'failed', message });
    throw error;
  }

  let logFd;
  // `beforeHandoff` relaxes the app's quit guards so brew's quit request goes
  // through and returns the function that puts them back. That runs whenever
  // the app outlives the handoff (brew failed, or had nothing to do), so a
  // failed update does not leave window-close behaving like quit.
  let restoreGuards = () => {};
  try {
    onStatus({ phase: 'install', logPath });
    logFd = openLog(logPath, 'a');
    restoreGuards = beforeHandoff() ?? restoreGuards;
    const child = spawn('/bin/sh', ['-c', RELAUNCH_SCRIPT, 'sh', brew, cask, appBundle], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: brewEnv(env),
    });
    let reported = false;
    const settle = (status) => {
      if (reported) return;
      reported = true;
      upgradeInFlight = false;
      restoreGuards();
      onStatus(status);
    };
    child.on('error', (error) => settle({
      phase: 'failed',
      message: error instanceof Error ? error.message : String(error),
      logPath,
    }));
    child.on('exit', (code) => {
      if (code === 0) {
        settle({ phase: 'done', restarted: false });
        return;
      }
      settle({ phase: 'failed', message: readLogTail(logPath), logPath });
    });
    child.unref();
  } catch (error) {
    upgradeInFlight = false;
    restoreGuards();
    const message = error instanceof Error ? error.message : String(error);
    onStatus({ phase: 'failed', message, logPath });
    throw error;
  } finally {
    if (logFd !== undefined) closeLog(logFd);
  }
};
