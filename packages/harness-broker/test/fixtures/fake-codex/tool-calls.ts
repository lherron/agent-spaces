import {
  expectMethod,
  framed,
  initializeAndReadThreadRequest,
} from '../../../src/testing/fake-codex-app-server'

const io = framed()
const thread = await initializeAndReadThreadRequest(io, 'thread/start')
io.respond(thread, { threadId: 'thread_tools' })
const turn = await expectMethod(io, 'turn/start')

const tools = [
  {
    started: {
      type: 'commandExecution',
      id: 'cmd_1',
      command: 'pwd',
      cwd: process.cwd(),
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
      status: 'inProgress',
    },
    completed: {
      type: 'commandExecution',
      id: 'cmd_1',
      command: 'pwd',
      cwd: process.cwd(),
      aggregatedOutput: 'output',
      exitCode: 0,
      durationMs: 12,
      status: 'completed',
    },
  },
  {
    started: {
      type: 'fileChange',
      id: 'file_1',
      changes: [{ path: 'src/a.ts' }],
      status: 'inProgress',
    },
    completed: {
      type: 'fileChange',
      id: 'file_1',
      changes: [{ path: 'src/a.ts', status: 'changed' }],
      status: 'completed',
    },
  },
  {
    started: {
      type: 'mcpToolCall',
      id: 'mcp_1',
      server: 'fs',
      tool: 'read',
      arguments: { path: 'README.md' },
      result: null,
      error: null,
      durationMs: null,
      status: 'inProgress',
    },
    completed: {
      type: 'mcpToolCall',
      id: 'mcp_1',
      server: 'fs',
      tool: 'read',
      arguments: { path: 'README.md' },
      result: { ok: true },
      error: null,
      durationMs: 12,
      status: 'completed',
    },
  },
  {
    started: { type: 'webSearch', id: 'web_1', query: 'codex' },
    completed: { type: 'webSearch', id: 'web_1', query: 'codex' },
  },
  {
    started: { type: 'imageView', id: 'img_1', path: '/tmp/image.png' },
    completed: { type: 'imageView', id: 'img_1', path: '/tmp/image.png' },
  },
]

io.notify('turn/started', { turnId: 'turn_1' })
for (const tool of tools) {
  io.notify('item/started', {
    turnId: 'turn_1',
    item: tool.started,
  })
  if (tool.started.type === 'commandExecution') {
    io.notify('item/commandExecution/outputDelta', {
      turnId: 'turn_1',
      itemId: tool.started.id,
      delta: 'output',
    })
  }
  if (tool.started.type === 'fileChange') {
    io.notify('item/fileChange/outputDelta', {
      turnId: 'turn_1',
      itemId: tool.started.id,
      delta: 'changed',
    })
  }
  if (tool.started.type === 'mcpToolCall') {
    io.notify('item/mcpToolCall/progress', {
      turnId: 'turn_1',
      itemId: tool.started.id,
      data: { progress: 1 },
    })
  }
  io.notify('item/completed', {
    turnId: 'turn_1',
    item: tool.completed,
  })
}
io.notify('turn/completed', {
  turnId: 'turn_1',
  status: 'completed',
  finalOutput: 'Tools complete.',
})
io.respond(turn, { ok: true })
