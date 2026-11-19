import type { TmuxPaneInputSelector } from '../../runtime/tmux'

export const selectAntigravityInput: TmuxPaneInputSelector = (snapshot) => {
  const line = snapshot.line.trimEnd()
  const prompt = /^>(?: |$)/u.test(line)
  const modeHint = snapshot.styledLine.includes('\x1b[38;5;8m') && line.startsWith('> Auto mode:')
  return {
    prompt,
    empty: prompt && snapshot.cursorX === 2 && (line === '>' || modeHint),
    fingerprint: JSON.stringify([line, snapshot.cursorX, snapshot.cursorY]),
  }
}
