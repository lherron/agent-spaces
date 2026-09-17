// Release-only narrow surface for the in-process Pi SDK worker.
//
// The upstream package root also re-exports its interactive UI, image, and
// extension-compilation surfaces. Bundling that barrel into the immutable
// worker retains build-host __dirname values for optional native tooling that
// the broker route disables. Import only the SDK/session modules this route
// actually uses.
export { readStoredCredential } from '../../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js'
export { DefaultResourceLoader } from '../../node_modules/@earendil-works/pi-coding-agent/dist/core/resource-loader.js'
export { ModelRuntime } from '../../node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.js'
export { createAgentSession } from '../../node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.js'
export { SessionManager } from '../../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js'
export { SettingsManager } from '../../node_modules/@earendil-works/pi-coding-agent/dist/core/settings-manager.js'
export { createBashToolDefinition } from '../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js'
export { defineTool } from '../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.js'
