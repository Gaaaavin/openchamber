import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  FORK_UPDATE_COMMAND,
  checkForkRelease,
  parseForkReleaseTag,
  readForkRelease,
} from './fork-release.mjs';

const current = parseForkReleaseTag('v1.22.2-xinhao.202609051200-abc1234');

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

test('parses fork release tags and rejects upstream or malformed tags', () => {
  assert.deepEqual(parseForkReleaseTag('v1.22.2-xinhao.202609051200-ABC1234'), {
    version: '1.22.2-xinhao.202609051200-ABC1234',
    upstreamVersion: '1.22.2',
    stamp: '202609051200',
    sha: 'abc1234',
  });
  assert.equal(parseForkReleaseTag('v1.22.2'), null);
  assert.equal(parseForkReleaseTag('v1.22.2-xinhao.2026-abc'), null);
  assert.equal(parseForkReleaseTag(undefined), null);
});

test('reads the release tag electron-builder wrote into package.json', () => {
  const found = readForkRelease({
    packageJsonPath: '/app/package.json',
    readFile: () => JSON.stringify({ name: '@openchamber/electron', forkRelease: 'v1.22.2-xinhao.202609051200-abc1234' }),
  });
  assert.equal(found?.stamp, '202609051200');

  assert.equal(readForkRelease({ packageJsonPath: '/app/package.json', readFile: () => '{}' }), null);
  assert.equal(readForkRelease({ packageJsonPath: '/missing', readFile: () => { throw new Error('ENOENT'); } }), null);
});

test('untagged builds report no update and still carry the brew command', async () => {
  const result = await checkForkRelease({
    currentRelease: null,
    appVersion: '1.22.2',
    fetchImpl: async () => { throw new Error('must not fetch'); },
  });
  assert.equal(result.available, false);
  assert.equal(result.currentVersion, '1.22.2');
  assert.equal(result.updateCommand, FORK_UPDATE_COMMAND);
  assert.equal(result.packageManager, 'homebrew');
});

test('a newer stamp is an available update with release metadata', async () => {
  const result = await checkForkRelease({
    currentRelease: current,
    fetchImpl: async () => jsonResponse({
      tag_name: 'v1.22.3-xinhao.202609071800-def5678',
      body: '## Notes\nrun brew upgrade',
      published_at: '2026-09-07T18:00:00Z',
      html_url: 'https://github.com/Gaaaavin/openchamber/releases/tag/v1.22.3-xinhao.202609071800-def5678',
    }),
  });
  assert.equal(result.available, true);
  assert.equal(result.version, '1.22.3-xinhao.202609071800-def5678');
  assert.equal(result.currentVersion, '1.22.2-xinhao.202609051200-abc1234');
  assert.equal(result.body, '## Notes\nrun brew upgrade');
  assert.equal(result.date, '2026-09-07T18:00:00Z');
  assert.match(result.releaseUrl, /releases\/tag\/v1\.22\.3/);
  assert.equal(result.updateCommand, FORK_UPDATE_COMMAND);
});

test('same or older stamp, unparseable tag, and 404 are authoritative no-update', async () => {
  for (const tag_name of ['v1.22.2-xinhao.202609051200-abc1234', 'v1.22.2-xinhao.202609011200-0000000', 'v1.22.9']) {
    const result = await checkForkRelease({ currentRelease: current, fetchImpl: async () => jsonResponse({ tag_name }) });
    assert.equal(result.available, false, tag_name);
    assert.equal(result.version, null);
  }
  const missing = await checkForkRelease({ currentRelease: current, fetchImpl: async () => jsonResponse({}, 404) });
  assert.equal(missing.available, false);
});

test('network and HTTP failures surface as check errors, not as no-update', async () => {
  await assert.rejects(
    checkForkRelease({ currentRelease: current, fetchImpl: async () => { throw new Error('offline'); } }),
    /Unable to check for updates: offline.*network connection/,
  );
  await assert.rejects(
    checkForkRelease({ currentRelease: current, fetchImpl: async () => jsonResponse({}, 503) }),
    /HTTP 503/,
  );
});
