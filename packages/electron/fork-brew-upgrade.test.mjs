import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import {
  FORK_CASK,
  RELAUNCH_SCRIPT,
  appBundleFromExecutable,
  brewEnv,
  resolveBrewExecutable,
  runForkBrewUpgrade,
} from './fork-brew-upgrade.mjs';

const phaseChild = ({ code = 0, stdout = '', stderr = '' } = {}) => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  queueMicrotask(() => {
    if (stdout) child.stdout.write(stdout);
    if (stderr) child.stderr.write(stderr);
    child.stdout.end();
    child.stderr.end();
    child.emit('close', code);
  });
  return child;
};

const detachedChild = () => {
  const child = new EventEmitter();
  child.unrefCalled = false;
  child.unref = () => { child.unrefCalled = true; };
  return child;
};

test('resolves Homebrew by standard-path precedence, then PATH', () => {
  const existing = new Set(['/opt/homebrew/bin/brew', '/usr/local/bin/brew', '/custom/bin/brew']);
  assert.equal(resolveBrewExecutable({ env: { PATH: '/custom/bin' }, existsSync: (candidate) => existing.has(candidate) }), '/opt/homebrew/bin/brew');
  existing.delete('/opt/homebrew/bin/brew');
  assert.equal(resolveBrewExecutable({ env: { PATH: '/custom/bin' }, existsSync: (candidate) => existing.has(candidate) }), '/usr/local/bin/brew');
  existing.delete('/usr/local/bin/brew');
  assert.equal(resolveBrewExecutable({ env: { PATH: '/missing:/custom/bin' }, existsSync: (candidate) => existing.has(candidate) }), '/custom/bin/brew');
  assert.equal(resolveBrewExecutable({ env: { PATH: '/missing' }, existsSync: () => false }), null);
});

test('derives the first app bundle from an executable path', () => {
  assert.equal(appBundleFromExecutable('/Applications/OpenChamber.app/Contents/MacOS/OpenChamber'), '/Applications/OpenChamber.app');
  assert.equal(appBundleFromExecutable('/Applications/Outer.app/Nested.app/Contents/MacOS/App'), '/Applications/Outer.app');
  assert.equal(appBundleFromExecutable('/usr/local/bin/electron'), null);
});

test('adds noninteractive Homebrew environment settings', () => {
  assert.deepEqual(brewEnv({ PATH: '/bin', KEEP: 'yes' }), {
    PATH: '/bin',
    KEEP: 'yes',
    HOMEBREW_NO_ENV_HINTS: '1',
    HOMEBREW_NO_COLOR: '1',
    HOMEBREW_NO_AUTO_UPDATE: '1',
    HOMEBREW_NO_INSTALL_CLEANUP: '1',
  });
});

test('runs update and fetch before a detached upgrade handoff', async () => {
  const calls = [];
  const statuses = [];
  const handoff = detachedChild();
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    if (calls.length === 1) return phaseChild({ stdout: 'Updated Homebrew\n' });
    if (calls.length === 2) return phaseChild({ stderr: 'Downloaded cask\n' });
    return handoff;
  };

  await runForkBrewUpgrade({
    appBundle: '/Applications/Open Chamber.app',
    logPath: '/tmp/brew upgrade.log',
    env: { PATH: '/bin' },
    spawn,
    openLog: () => 42,
    closeLog: () => {},
    resolveBrew: () => '/brew path/with space/brew',
    onStatus: (status) => statuses.push(status),
  });

  assert.deepEqual(calls.map(({ command, args }) => [command, args]), [
    ['/brew path/with space/brew', ['update']],
    ['/brew path/with space/brew', ['fetch', '--cask', FORK_CASK]],
    ['/bin/sh', ['-c', RELAUNCH_SCRIPT, 'sh', '/brew path/with space/brew', FORK_CASK, '/Applications/Open Chamber.app']],
  ]);
  assert.equal(calls[0].options.detached, undefined);
  assert.equal(calls[1].options.detached, undefined);
  assert.equal(calls[2].options.detached, true);
  assert.equal(handoff.unrefCalled, true);
  assert.deepEqual(statuses.filter(({ line }) => !line).map(({ phase }) => phase), ['update', 'fetch', 'install']);

  handoff.emit('exit', 1);
});

test('phase failure rejects with the bounded stderr tail and skips fetch', async () => {
  const calls = [];
  const statuses = [];
  await assert.rejects(runForkBrewUpgrade({
    appBundle: '/Applications/OpenChamber.app',
    logPath: '/tmp/brew-upgrade.log',
    spawn: (...args) => {
      calls.push(args);
      return phaseChild({ code: 1, stderr: 'one\ntwo\nthree\nfour\n' });
    },
    resolveBrew: () => '/opt/homebrew/bin/brew',
    onStatus: (status) => statuses.push(status),
  }), /two\nthree\nfour/);
  assert.equal(calls.length, 1);
  assert.equal(statuses.at(-1)?.phase, 'failed');
});

test('a detached non-zero exit reports the log tail', async () => {
  const statuses = [];
  const handoff = detachedChild();
  let call = 0;
  await runForkBrewUpgrade({
    appBundle: '/Applications/OpenChamber.app',
    logPath: '/tmp/brew-upgrade.log',
    spawn: () => (++call < 3 ? phaseChild() : handoff),
    openLog: () => 7,
    closeLog: () => {},
    readLogTail: () => 'upgrade log failure',
    resolveBrew: () => '/opt/homebrew/bin/brew',
    onStatus: (status) => statuses.push(status),
  });
  handoff.emit('exit', 2);
  assert.deepEqual(statuses.at(-1), {
    phase: 'failed',
    message: 'upgrade log failure',
    logPath: '/tmp/brew-upgrade.log',
  });
});

test('an app that outlives the handoff gets its quit guards back and may retry', async () => {
  const guards = { relaxed: 0, restored: 0 };
  const run = async (exitCode) => {
    const statuses = [];
    const handoff = detachedChild();
    let call = 0;
    await runForkBrewUpgrade({
      appBundle: '/Applications/OpenChamber.app',
      logPath: '/tmp/brew-upgrade.log',
      spawn: () => (++call < 3 ? phaseChild() : handoff),
      openLog: () => 7,
      closeLog: () => {},
      readLogTail: () => 'tail',
      resolveBrew: () => '/opt/homebrew/bin/brew',
      onStatus: (status) => statuses.push(status),
      beforeHandoff: () => {
        guards.relaxed += 1;
        return () => { guards.restored += 1; };
      },
    });
    assert.equal(guards.restored, guards.relaxed - 1, 'guards stay relaxed until the child settles');
    handoff.emit('exit', exitCode);
    return statuses.at(-1);
  };

  // brew had nothing to do: the app keeps running, so the guards come back
  // and the in-flight lock releases for the next attempt.
  assert.deepEqual(await run(0), { phase: 'done', restarted: false });
  assert.equal(guards.restored, 1);
  // A second run is allowed and a failure restores them too.
  assert.equal((await run(3)).phase, 'failed');
  assert.equal(guards.relaxed, 2);
  assert.equal(guards.restored, 2);
});

test('rejects a second run while the first phase is in flight', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const first = runForkBrewUpgrade({
    appBundle: '/Applications/OpenChamber.app',
    logPath: '/tmp/brew-upgrade.log',
    spawn: () => child,
    resolveBrew: () => '/opt/homebrew/bin/brew',
  });
  await assert.rejects(runForkBrewUpgrade({
    appBundle: '/Applications/OpenChamber.app',
    logPath: '/tmp/brew-upgrade.log',
    resolveBrew: () => '/opt/homebrew/bin/brew',
  }), /already in progress/);
  child.stderr.end('first run failed\n');
  child.stdout.end();
  child.emit('close', 1);
  await assert.rejects(first, /first run failed/);
});
