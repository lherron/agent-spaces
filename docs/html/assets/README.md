# HTML Proposal Assets

Reusable assets for standalone proposal pages in `docs/html`.

## Contract Viewer

Use the contract viewer for annotated TypeScript-like contracts:

```html
<link rel="stylesheet" href="assets/proposal-shell.css" />
<link rel="stylesheet" href="assets/contract-viewer.css" />

<article class="contract-object request">
  <div class="contract-object-head">...</div>
  <div class="code-panel">
    <pre><code>type Example = {
  field: string // Field-level explanation.
  nested: { // Block/type-level explanation.
    value: number // Nested field explanation.
  }
}</code></pre>
  </div>
</article>

<script src="assets/contract-viewer.js" defer></script>
```

Block/type comments are detected when a commented line opens a block with `{` or
starts with `type`. Those comments render as definition comments without the
`//` marker; field comments keep the marker.

Accent colors can be customized per object:

```html
<article
  class="contract-object"
  style="--contract-accent: #007274; --contract-accent-rgb: 0, 114, 116"
>
  ...
</article>
```
