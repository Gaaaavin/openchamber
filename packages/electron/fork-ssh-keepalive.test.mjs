import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { ElectronSshManager } from './ssh-manager.mjs';

const KEEPALIVE_OPTIONS = [
  'ServerAliveInterval=15',
  'ServerAliveCountMax=3',
  'TCPKeepAlive=yes',
];

const createChild = () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  return child;
};

const captureSpawns = (platform) => {
  const calls = [];
  const manager = new ElectronSshManager({
    settingsFilePath: '/tmp/unused-openchamber-settings.json',
    appVersion: '0.0.0-test',
    emit: () => {},
    platform,
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      return createChild();
    },
  });
  return { calls, manager };
};

const optionValues = (args, key) => args
  .flatMap((arg, index) => arg === '-o' ? [args[index + 1]] : [])
  .filter((arg) => arg?.toLowerCase().startsWith(`${key.toLowerCase()}=`));

test('adds keepalive defaults to the ControlMaster and macOS forwarding argv', async () => {
  const { calls, manager } = captureSpawns('darwin');
  const parsed = { destination: 'user@example.test', args: [] };

  await manager.spawnMasterProcess(parsed, '/tmp/control.sock');
  await manager.spawnMainForward(parsed, '/tmp/control.sock', '127.0.0.1', 3000, 4000);

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args.slice(0, 6), [
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'TCPKeepAlive=yes',
  ]);
  for (const call of calls) {
    for (const option of KEEPALIVE_OPTIONS) assert.ok(call.args.includes(option));
  }
  assert.ok(calls[0].args.includes('ControlMaster=yes'));
  assert.ok(calls[1].args.includes('ControlMaster=no'));
  assert.ok(calls[1].args.includes('ExitOnForwardFailure=yes'));
});

test('adds keepalive defaults to the independent Windows forwarding argv', async () => {
  const { calls, manager } = captureSpawns('win32');

  await manager.spawnMainForward(
    { destination: 'user@example.test', args: [] },
    'C:\\Temp\\unused.sock',
    '127.0.0.1',
    3000,
    4000,
  );

  assert.equal(calls.length, 1);
  for (const option of KEEPALIVE_OPTIONS) assert.ok(calls[0].args.includes(option));
  assert.ok(calls[0].args.includes('ControlPath=none'));
  assert.equal(calls[0].options.windowsHide, true);
});

test('keeps a user-supplied ServerAliveInterval before the fork default', async () => {
  const { calls, manager } = captureSpawns('darwin');
  const parsed = {
    destination: 'user@example.test',
    args: ['-o', 'ServerAliveInterval=60'],
  };

  await manager.spawnMasterProcess(parsed, '/tmp/control.sock');

  assert.deepEqual(optionValues(calls[0].args, 'ServerAliveInterval'), [
    'ServerAliveInterval=60',
    'ServerAliveInterval=15',
  ]);
});
