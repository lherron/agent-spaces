// Bun switches fd 1/2 to O_NONBLOCK the moment `process.stdout`/`process.stderr`
// is materialized — any `.isTTY` probe does it, chalk's color detection included.
// From then on `console.log`, `fs.writeSync(1)` and anything still buffered at
// `process.exit` silently drop every byte past the pipe buffer (~64 KB) whenever
// the reader is slower than the writer (T-10368). Restoring blocking mode on the
// shared file description makes every write path wait for the reader instead.

const F_GETFL = 3
const F_SETFL = 4
const O_NONBLOCK: Partial<Record<NodeJS.Platform, number>> = { darwin: 0x4, linux: 0x800 }
const LIBC: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'libc.dylib',
  linux: 'libc.so.6',
}

type Fcntl = (fd: number, cmd: number, ...args: bigint[]) => number

// fcntl is variadic: Apple arm64 reads its third argument from the first stack
// slot, while x86_64 and linux arm64 read it from the third argument register.
// Passing the value in every register slot and the first stack slot (9 args)
// satisfies both without a per-ABI signature; surplus args are caller-cleaned.
const FCNTL_SLOTS = 7

function loadFcntl(platform: NodeJS.Platform): Fcntl | undefined {
  const lib = LIBC[platform]
  if (!lib || typeof Bun === 'undefined') return undefined
  const { dlopen, FFIType } = require('bun:ffi') as typeof import('bun:ffi')
  const { symbols } = dlopen(lib, {
    fcntl: {
      args: [FFIType.i32, FFIType.i32, ...Array(FCNTL_SLOTS).fill(FFIType.i64)],
      returns: FFIType.i32,
    },
  })
  return symbols.fcntl as unknown as Fcntl
}

function fcntlCall(fcntl: Fcntl, fd: number, cmd: number, value: number): number {
  return fcntl(fd, cmd, ...Array<bigint>(FCNTL_SLOTS).fill(BigInt(value)))
}

/**
 * Put stdout and stderr back into blocking mode for the life of the process.
 * Call once at CLI startup. Returns the fds left blocking; a no-op (empty) off
 * Bun or on an unsupported platform, and never throws.
 */
export function ensureBlockingStdio(platform: NodeJS.Platform = process.platform): number[] {
  const nonblock = O_NONBLOCK[platform]
  if (nonblock === undefined) return []

  let fcntl: Fcntl | undefined
  try {
    fcntl = loadFcntl(platform)
  } catch {
    return []
  }
  if (!fcntl) return []

  // Materialize the streams first so Bun's own O_NONBLOCK switch has already
  // happened; it does not re-apply it afterwards.
  void process.stdout.isTTY
  void process.stderr.isTTY

  const blocking: number[] = []
  for (const fd of [1, 2]) {
    const flags = fcntlCall(fcntl, fd, F_GETFL, 0)
    if (flags < 0) continue
    if (flags & nonblock) {
      const wanted = flags & ~nonblock
      fcntlCall(fcntl, fd, F_SETFL, wanted)
      if (fcntlCall(fcntl, fd, F_GETFL, 0) !== wanted) continue
    }
    blocking.push(fd)
  }
  return blocking
}
