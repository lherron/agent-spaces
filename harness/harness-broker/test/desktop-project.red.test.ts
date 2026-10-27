import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  cleanupDesktopJoinFixtures,
  desktopJoinFixture,
  occupied,
  registered,
  runJoin,
  scopeCache,
} from './desktop-join-fixture'

afterEach(cleanupDesktopJoinFixtures)

describe('desktop project resolution', () => {
  test('the deepest registry root wins over an enclosing project and names the joined address', async () => {
    const fixture = await desktopJoinFixture({ workspace: 'outer/inner/work' })
    const run = await runJoin(fixture, (scopeRef) => registered(scopeRef), {
      projectRoot: undefined,
      workspaceCwd: fixture.workspace,
      registryProjects: [
        { projectId: 'praesidium', root: join(fixture.dir, 'outer') },
        { projectId: 'hrc-ios', root: join(fixture.dir, 'outer', 'inner') },
      ],
    })

    expect(run.registered).toEqual(['agent:stella:project:hrc-ios:task:primary-nova'])
    expect(run.outcome).toEqual({ exit: 0, reason: 'serving' })
    expect(scopeCache(fixture)).toMatchObject({ projectId: 'hrc-ios' })
  })

  test.each([
    { marker: 'a .git marker', git: true, reason: 'no-project:project_unregistered' },
    { marker: 'no marker', git: false, reason: 'no-project:project_unresolved' },
  ])(
    'a workspace with $marker and no registry coverage does not join: $reason',
    async ({ git, reason }) => {
      const fixture = await desktopJoinFixture({ workspace: 'project/work' })
      if (git) mkdirSync(join(fixture.dir, 'project', '.git'), { recursive: true })
      else writeFileSync(join(fixture.dir, 'project', 'note.txt'), 'no git here')

      const run = await runJoin(
        fixture,
        () => {
          throw new Error('an unresolved project must never register')
        },
        { projectRoot: undefined, workspaceCwd: fixture.workspace, registryProjects: [] }
      )

      expect(run.outcome).toEqual({ exit: 0, reason })
      expect(run.requests).toEqual([])
    }
  )

  test('the slot sequence runs primary-nova..primary-cosmos, then rolls over to primary-nova-2', async () => {
    const fixture = await desktopJoinFixture()
    let registers = 0
    const run = await runJoin(fixture, (scopeRef) => {
      registers += 1
      return registers <= 10 ? occupied : registered(scopeRef)
    })

    expect(run.registered).toHaveLength(11)
    expect(run.registered[0]).toBe('agent:stella:project:workspace:task:primary-nova')
    expect(run.registered[9]).toBe('agent:stella:project:workspace:task:primary-cosmos')
    expect(run.registered[10]).toBe('agent:stella:project:workspace:task:primary-nova-2')
    expect(scopeCache(fixture)).toMatchObject({ slotToken: 'primary-nova-2' })
  })
})
