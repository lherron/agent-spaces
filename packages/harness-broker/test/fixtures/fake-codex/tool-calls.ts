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
  { id: 'cmd_1', type: 'commandExecution', name: 'command', input: { command: 'pwd' } },
  { id: 'file_1', type: 'fileChange', name: 'file_change', input: { path: 'src/a.ts' } },
  { id: 'mcp_1', type: 'mcpToolCall', name: 'mcp_tool', input: { server: 'fs', tool: 'read' } },
  { id: 'web_1', type: 'webSearch', name: 'web_search', input: { query: 'codex' } },
  { id: 'img_1', type: 'imageView', name: 'image_view', input: { path: '/tmp/image.png' } },
]

io.notify('turn/started', { turnId: 'turn_1' })
for (const tool of tools) {
  io.notify('item/started', {
    turnId: 'turn_1',
    item: { type: tool.type, id: tool.id, input: tool.input },
  })
  if (tool.type === 'commandExecution') {
    io.notify('item/commandExecution/outputDelta', {
      turnId: 'turn_1',
      id: tool.id,
      text: 'output',
    })
  }
  if (tool.type === 'fileChange') {
    io.notify('item/fileChange/outputDelta', {
      turnId: 'turn_1',
      id: tool.id,
      text: 'changed',
    })
  }
  if (tool.type === 'mcpToolCall') {
    io.notify('item/mcpToolCall/progress', {
      turnId: 'turn_1',
      id: tool.id,
      data: { progress: 1 },
    })
  }
  io.notify('item/completed', {
    turnId: 'turn_1',
    item: {
      type: tool.type,
      id: tool.id,
      name: tool.name,
      result: { ok: true },
      durationMs: 12,
    },
  })
}
io.notify('turn/completed', {
  turnId: 'turn_1',
  status: 'completed',
  finalOutput: 'Tools complete.',
})
io.respond(turn, { ok: true })
