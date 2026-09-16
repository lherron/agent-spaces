import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderLaunchdPlist, renderLaunchdScript } from './aspd-service.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('aspd launchd supervision rendering', () => {
  test('the launch script records the daemon pid and execs the release with only the literal env', async () => {
    const ns = mkdtempSync(join(tmpdir(), "aspd-ns-it's-"))
    dirs.push(ns)
    const releasePath = join(ns, 'releases', 'asp-test')
    mkdirSync(releasePath, { recursive: true })
    mkdirSync(join(ns, 'run'))
    const fakeAspd = join(releasePath, 'aspd')
    writeFileSync(
      fakeAspd,
      `#!/bin/sh\nprintf 'pid=%s\\n' "$$" > "${join(ns, 'observed')}"\nenv | sort >> "${join(ns, 'observed')}"\nprintf 'argv=%s\\n' "$*" >> "${join(ns, 'observed')}"\n`
    )
    chmodSync(fakeAspd, 0o755)
    const script = renderLaunchdScript({
      ns,
      socketPath: join(ns, 'run', 'aspd.sock'),
      releaseId: 'asp-test',
      releasePath,
      env: { HOME: '/home/it', ASP_HOME: "/state/o'brien home", PATH: '/usr/bin:/bin' },
      logPath: join(ns, 'logs', 'aspd-launchd.log'),
    })
    const scriptPath = join(ns, 'launchd-run.sh')
    writeFileSync(scriptPath, script)

    const proc = Bun.spawn(['/bin/sh', scriptPath], {
      env: { AMBIENT_SECRET: 'must-not-leak', PATH: '/usr/bin:/bin' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(await proc.exited).toBe(0)
    const observed = readFileSync(join(ns, 'observed'), 'utf8')
    const record = JSON.parse(readFileSync(join(ns, 'run', 'aspd.json'), 'utf8'))

    expect(observed).toContain(`pid=${proc.pid}`)
    expect(record).toMatchObject({ pid: proc.pid, releaseId: 'asp-test', releasePath })
    expect(observed).toContain("ASP_HOME=/state/o'brien home")
    expect(observed).toContain('HOME=/home/it')
    expect(observed).not.toContain('AMBIENT_SECRET')
    expect(observed).toContain(`argv=serve --socket ${join(ns, 'run', 'aspd.sock')}`)
  })

  test('the plist lints and names the launch script under KeepAlive', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aspd-plist-'))
    dirs.push(dir)
    const plistPath = join(dir, 'com.example.aspd.plist')
    writeFileSync(
      plistPath,
      renderLaunchdPlist({
        label: 'com.example.aspd',
        launchScript: '/ns/service/launchd-run.sh',
        logPath: '/ns/logs/a&b.log',
      })
    )
    const lint = Bun.spawnSync(['plutil', '-lint', plistPath])
    expect(lint.exitCode).toBe(0)
    const json = JSON.parse(
      Bun.spawnSync(['plutil', '-convert', 'json', '-o', '-', plistPath]).stdout.toString()
    )
    expect(json).toEqual({
      Label: 'com.example.aspd',
      ProgramArguments: ['/bin/sh', '/ns/service/launchd-run.sh'],
      RunAtLoad: true,
      KeepAlive: true,
      ExitTimeOut: 180,
      StandardOutPath: '/ns/logs/a&b.log',
      StandardErrorPath: '/ns/logs/a&b.log',
    })
  })
})
