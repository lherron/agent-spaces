;(() => {
  const escapeHtml = (value) =>
    value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

  const highlightCode = (value) => {
    let html = escapeHtml(value)
    html = html.replace(
      /\b([A-Za-z_][A-Za-z0-9_]*\??)(?=\s*:)/g,
      '<span class="syntax-field">$1</span>'
    )
    html = html.replace(
      /\b(type|Promise|Record|RuntimeCompileRequest|RuntimeCompileResponse|CompiledRuntimePlan|CompileDiagnostic)\b/g,
      '<span class="syntax-keyword">$1</span>'
    )
    html = html.replace(/'([^']*)'/g, '<span class="syntax-string">\'$1\'</span>')
    return html || '&nbsp;'
  }

  const renderLine = (line, index) => {
    const commentIndex = line.indexOf('//')
    const hasComment = commentIndex >= 0
    const codePart = hasComment ? line.slice(0, commentIndex).replace(/\s+$/, '') : line
    const commentPart = hasComment ? line.slice(commentIndex + 2).trim() : ''
    const codeClass = hasComment ? 'schema-code has-comment' : 'schema-code no-comment'
    const trimmedCode = codePart.trim()
    const isBlockComment = hasComment && (trimmedCode.endsWith('{') || /^type\s+/.test(trimmedCode))
    const commentClass = isBlockComment ? 'schema-comment block-comment' : 'schema-comment'
    const markerHtml = isBlockComment ? '' : '<span class="comment-marker">//</span>'
    const commentHtml = hasComment
      ? `<span class="${commentClass}">${markerHtml}${escapeHtml(commentPart)}</span>`
      : ''
    return `<span class="schema-line"><span class="schema-line-no">${index + 1}</span><span class="${codeClass}"><span class="schema-code-text">${highlightCode(codePart)}</span>${commentHtml}</span></span>`
  }

  document.querySelectorAll('.contract-object code').forEach((code) => {
    if (code.dataset.highlighted === 'true') return
    const raw = code.textContent || ''
    code.innerHTML = raw.split('\n').map(renderLine).join('')
    code.dataset.highlighted = 'true'
  })
})()
