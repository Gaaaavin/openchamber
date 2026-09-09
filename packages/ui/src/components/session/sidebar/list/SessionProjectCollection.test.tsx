import { describe, expect, test } from 'bun:test';
import { buildSessionBootstrapDemands } from './sessionBootstrapDemands';

describe('SessionProjectCollection', () => {
  test('preserves project-root demand when its visible rows are absent', () => {
    const demands = buildSessionBootstrapDemands({
      activeProjectDirectory: '/project',
      activeProjectId: 'project',
      collapsedProjects: new Set(),
      currentDirectory: null,
      currentSessionDirectory: null,
    });

    expect(demands.map((demand) => demand.directory)).toEqual(['/project']);
    expect(demands[0]?.priority).toBe('active-project');
  });

});
