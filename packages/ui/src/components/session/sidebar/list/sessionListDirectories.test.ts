import { describe, expect, test } from 'bun:test';
import { buildKnownSessionDirectories } from './sessionListDirectories';

describe('buildKnownSessionDirectories', () => {
  test('normalizes project roots, preserves case, and optionally includes worktrees', () => {
    const worktrees = new Map([
      ['/Repo', [{ path: '/Repo/Worktree', projectDirectory: '/Repo', branch: 'worktree', label: 'worktree' }]],
    ]);

    expect([...buildKnownSessionDirectories([{ path: '/Repo' }], worktrees)]).toEqual([
      '/Repo',
      '/Repo/Worktree',
    ]);
    expect([...buildKnownSessionDirectories([{ path: '/Repo' }], worktrees, { includeWorktrees: false })]).toEqual([
      '/Repo',
    ]);
  });
});
