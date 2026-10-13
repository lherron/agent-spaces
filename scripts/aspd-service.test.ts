import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  adoptLaunchdPlist,
  bootstrapLaunchd,
  renderLaunchdPlist,
  renderLaunchdScript,
} from './aspd-service.ts'

const dirs: string[] = []
const savedPath = process.env.PATH
afterEach(() => {
  process.env.PATH = savedPath
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A scratch dir whose bin/ holds only the stubs a test installs, ahead of system dirs. */
function scratchBin(stubs: Record<string, string>): { dir: string; bin: string } {
  const dir = mkdtempSync(join(tmpdir(), 'aspd-launchd-'))
  dirs.push(dir)
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  for (const [name, body] of Object.entries(stubs)) {
    writeFileSync(join(bin, name), body)
    chmodSync(join(bin, name), 0o755)
  }
  process.env.PATH = `${bin}:/usr/bin:/bin`
  return { dir, bin }
}

function plistJson(path: string): Record<string, unknown> {
  return JSON.parse(
    Bun.spawnSync(['plutil', '-convert', 'json', '-o', '-', path]).stdout.toString()
  )
}

function writeScratchPlist(dir: string): string {
  const plistPath = join(dir, 'com.example.aspd.plist')
  writeFileSync(
    plistPath,
    renderLaunchdPlist({
      label: 'com.example.aspd',
      launchScript: '/ns/service/launchd-run.sh',
      logPath: '/ns/logs/aspd-launchd.log',
    })
  )
  return plistPath
}

const ADOPT_AGENT = join(import.meta.dir, '..', '..', 'macos', 'adopt-agent')

describe('aspd launchd supervision rendering', () => {
  test('the launch script records the daemon pid and execs the release with only the literal env', async () => {
    const ns = mkdtempSync(join(tmpdir(), "aspd-ns-it's-"))
    dirs.push(ns)
    const releasePath = join(ns, 'releases', 'asp-test')
    mkdirSync(releasePath, { recursive: true })
    mkdirSync(join(ns, 'run'))
    mkdirSync(join(ns, 'logs'))
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
      requestLogPath: join(ns, 'logs', 'aspd.log'),
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
    expect(observed).toContain(
      `argv=serve --socket ${join(ns, 'run', 'aspd.sock')} --log ${join(ns, 'logs', 'aspd.log')}`
    )
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

describe('aspd launchd-jobs adoption and bootstrap', () => {
  test.skipIf(!existsSync(ADOPT_AGENT))(
    'a present adopter rewrites the plist onto the shim',
    () => {
      const { dir, bin } = scratchBin({
        'praesidium-launch': '#!/bin/sh\nexec "$@"\n',
        'praesidium-adopt': `#!/bin/sh\nPRAESIDIUM_LAUNCH_SHIM="$(dirname "$0")/praesidium-launch" exec ${ADOPT_AGENT} "$@"\n`,
      })
      const shim = join(bin, 'praesidium-launch')
      const plistPath = writeScratchPlist(dir)
      adoptLaunchdPlist(plistPath)
      adoptLaunchdPlist(plistPath)
      expect(Bun.spawnSync(['plutil', '-lint', plistPath]).exitCode).toBe(0)
      const json = plistJson(plistPath)
      expect(json.ProgramArguments).toEqual([shim, '/bin/sh', '/ns/service/launchd-run.sh'])
      expect(json.AssociatedBundleIdentifiers).toEqual(['com.praesidium.AgentHost'])
    }
  )

  test('an absent adopter leaves the plist untouched', () => {
    const { dir } = scratchBin({})
    const plistPath = writeScratchPlist(dir)
    const before = readFileSync(plistPath, 'utf8')
    adoptLaunchdPlist(plistPath)
    expect(readFileSync(plistPath, 'utf8')).toBe(before)
  })

  test('a failing adopter fails the operation', () => {
    const { dir } = scratchBin({
      'praesidium-adopt': '#!/bin/sh\necho "adopt broke on $1" >&2\nexit 3\n',
    })
    const plistPath = writeScratchPlist(dir)
    expect(() => adoptLaunchdPlist(plistPath)).toThrow(/praesidium-adopt failed .*adopt broke on/)
  })

  const flakyLaunchctl = (failures: number, output: string, code: number) =>
    `#!/bin/sh\nn=$(cat "$0.count" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$0.count"\necho "$*" >> "$0.calls"\nif [ $n -le ${failures} ]; then echo "${output}" >&2; exit ${code}; fi\nexit 0\n`

  test('bootstrap retries launchd error 5 and then succeeds', async () => {
    const { bin } = scratchBin({
      launchctl: flakyLaunchctl(2, 'Bootstrap failed: 5: Input/output error', 5),
    })
    expect(await bootstrapLaunchd('gui/501', '/la/x.plist', 1)).toEqual({ attempts: 3 })
    expect(readFileSync(join(bin, 'launchctl.calls'), 'utf8').trim().split('\n')).toEqual(
      Array(3).fill('bootstrap gui/501 /la/x.plist')
    )
  })

  test('bootstrap gives up after the retry budget on persistent error 5', async () => {
    const { bin } = scratchBin({
      launchctl: flakyLaunchctl(99, 'Bootstrap failed: 5: Input/output error', 5),
    })
    await expect(bootstrapLaunchd('gui/501', '/la/x.plist', 1)).rejects.toThrow(
      /after 4 attempt\(s\): Bootstrap failed: 5/
    )
    expect(readFileSync(join(bin, 'launchctl.count'), 'utf8').trim()).toBe('4')
  })

  test('bootstrap does not retry other launchd errors', async () => {
    const { bin } = scratchBin({
      launchctl: flakyLaunchctl(99, 'Bootstrap failed: 37: Operation already in progress', 37),
    })
    await expect(bootstrapLaunchd('gui/501', '/la/x.plist', 1)).rejects.toThrow(/after 1 attempt/)
    expect(readFileSync(join(bin, 'launchctl.count'), 'utf8').trim()).toBe('1')
  })
})
