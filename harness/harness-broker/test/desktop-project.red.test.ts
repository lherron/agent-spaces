import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  desktopScopeRef,
  desktopSlotTokenSequence,
  resolveDesktopProject,
} from '../src/desktop-project.js'

function dir(name: string): string {
  const path = join(
    tmpdir(),
    `desktop-project-${process.pid}-${name}-${Math.random().toString(36).slice(2)}`
  )
  mkdirSync(path, { recursive: true })
  return path
}

describe('desktop project resolution', () => {
  test('registry deepest root wins over an enclosing project', async () => {
    const outer = dir('outer')
    const inner = join(outer, 'inner')
    mkdirSync(inner, { recursive: true })
    const workspace = join(inner, 'work')
    mkdirSync(workspace, { recursive: true })
    const result = await resolveDesktopProject({
      workspaceCwd: workspace,
      registryProjects: [
        { projectId: 'praesidium', root: outer },
        { projectId: 'hrc-ios', root: inner },
      ],
    })
    expect(result).toMatchObject({ bound: { projectId: 'hrc-ios' } })
    if (result.bound !== undefined) {
      const { realpathSync } = await import('node:fs')
      expect(result.bound.projectRoot).toBe(realpathSync(inner))
    }
  })

  test('marker-only workspace without registry coverage is pending unregistered', async () => {
    const root = dir('marked')
    mkdirSync(join(root, '.git'), { recursive: true })
    const workspace = join(root, 'work')
    mkdirSync(workspace, { recursive: true })
    const result = await resolveDesktopProject({ workspaceCwd: workspace, registryProjects: [] })
    expect(result).toMatchObject({ pending: true, reason: 'project_unregistered' })
  })

  test('no registry and no marker is pending unresolved', async () => {
    const root = dir('bare')
    const workspace = join(root, 'work')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(root, 'note.txt'), 'no git here')
    const result = await resolveDesktopProject({ workspaceCwd: workspace, registryProjects: [] })
    expect(result).toMatchObject({ pending: true, reason: 'project_unresolved' })
  })

  test('slot sequence starts at primary-nova and rounds with numeric suffixes', () => {
    const tokens = Array.from(desktopSlotTokenSequence()).slice(0, 12)
    expect(tokens[0]).toBe('primary-nova')
    expect(tokens[9]).toBe('primary-cosmos')
    expect(tokens[10]).toBe('primary-nova-2')
    expect(tokens[11]).toBe('primary-comet-2')
    expect(desktopScopeRef('stella', 'demo', 'primary-nova')).toBe(
      'agent:stella:project:demo:task:primary-nova'
    )
  })
})
