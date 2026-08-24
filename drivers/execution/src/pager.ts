/**
 * Get the number of rows available for content (terminal height minus status line).
 */
function getPageSize(): number {
  return (process.stdout.rows ?? 24) - 2
}

/**
 * Wait for a single keypress. Returns the key character.
 */
function waitForKey(): Promise<string> {
  return new Promise((resolve) => {
    const wasRaw = process.stdin.isRaw
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true)
    }
    process.stdin.resume()

    const onData = (data: Buffer) => {
      process.stdin.removeListener('data', onData)
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(wasRaw ?? false)
      }
      process.stdin.pause()
      const key = data.toString()
      // Handle Ctrl-C
      if (key === '\x03') {
        process.exit(130)
      }
      resolve(key)
    }

    process.stdin.on('data', onData)
  })
}

/**
 * Page through lines of output. Returns when all lines are shown or user presses 'q'.
 *
 * When the user presses 'q', remaining lines are printed immediately
 * so no content is lost.
 */
export async function paginate(lines: string[]): Promise<void> {
  // If not a TTY, just dump everything
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    for (const line of lines) {
      console.log(line)
    }
    return
  }

  const pageSize = getPageSize()

  // If it fits in one page, no paging needed
  if (lines.length <= pageSize) {
    for (const line of lines) {
      console.log(line)
    }
    return
  }

  let offset = 0
  while (offset < lines.length) {
    const end = Math.min(offset + pageSize, lines.length)
    for (let i = offset; i < end; i++) {
      console.log(lines[i] ?? '')
    }
    offset = end

    if (offset >= lines.length) break

    // Show status line
    const remaining = lines.length - offset
    process.stdout.write(
      `\x1b[7m -- ${remaining} more lines (SPACE/Enter: next page, q: skip) -- \x1b[0m`
    )

    const key = await waitForKey()

    // Clear the status line
    process.stdout.write('\r\x1b[K')

    if (key === 'q' || key === 'Q') {
      // Dump remaining lines and continue
      for (let i = offset; i < lines.length; i++) {
        console.log(lines[i] ?? '')
      }
      break
    }
    // Any other key (space, enter, etc.) → next page
  }
}
