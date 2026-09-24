import { expect, test } from 'bun:test'
import {
  IN_PROCESS_TRANSPORT_DRIVER_KINDS,
  NATIVE_WORKER_DRIVER_KINDS,
  SDK_BLOCK_DRIVER_KINDS,
  TMUX_SURFACE_DRIVER_KINDS,
} from '../src/index.js'

test('driver kind contract sets retain their published memberships', () => {
  expect([...NATIVE_WORKER_DRIVER_KINDS]).toEqual([
    'agent-harness',
    'agent-harness-tmux',
    'foundry-resident',
  ])
  expect([...SDK_BLOCK_DRIVER_KINDS]).toEqual([
    'pi-sdk',
    'agent-harness',
    'agent-harness-tmux',
    'foundry-resident',
  ])
  expect([...IN_PROCESS_TRANSPORT_DRIVER_KINDS]).toEqual(['pi-sdk', 'arris-resident'])
  expect([...TMUX_SURFACE_DRIVER_KINDS]).toEqual([
    'claude-code-tmux',
    'codex-cli-tmux',
    'pi-tui-tmux',
    'muse-cli-tmux',
    'agent-harness-tmux',
  ])
})
