import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { runBrokerCli } from '../../src/cli'
import { createTestDriver } from '../../src/testing/test-driver'

const effectsPath = process.env['T08346_DRIVER_START_EFFECTS']
const delayMs = Number(process.env['T08346_DRIVER_START_DELAY_MS'] ?? '0')

if (effectsPath === undefined) {
  throw new Error('T08346_DRIVER_START_EFFECTS is required')
}

await runBrokerCli({
  additionalDrivers: [
    () =>
      createTestDriver({
        kind: 't08346-controlled-driver',
        async onStart(ctx) {
          await mkdir(dirname(effectsPath), { recursive: true })
          await appendFile(effectsPath, `${ctx.invocationId}\n`)
          if (delayMs > 0) await Bun.sleep(delayMs)
        },
      }).driver,
  ],
})
