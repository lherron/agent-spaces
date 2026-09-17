/**
 * spaces-harness-muse: Muse workspace composer plus the CLI adapter
 * (spike 11, T-08591).
 */
export {
  MUSE_AGENTS_FILE,
  MUSE_MANIFEST_FILE,
  MUSE_SETTINGS_FILE,
  MUSE_SKILLS_DIR,
  MUSE_WORKSPACE_DIRNAME,
  buildMuseAgentsMarkdown,
  composeMuseWorkspace,
  loadMuseWorkspaceBundle,
} from './composer.js'
export type {
  ComposeMuseWorkspaceInput,
  ComposeMuseWorkspaceOptions,
  ComposeMuseWorkspaceResult,
  MuseComposerWarning,
  MuseManifest,
  MuseSpaceSource,
  MuseWorkspaceBundle,
  MuseWorkspaceFingerprint,
} from './composer.js'
export { DEFAULT_MUSE_SERVE_BIN, buildMuseServeDescriptor } from './descriptor.js'
export type {
  BuildMuseServeDescriptorOptions,
  MuseServeDescriptor,
} from './descriptor.js'
export {
  MUSE_PATH_ENV,
  MUSE_SKIP_COMMON_PATHS_ENV,
  detectMuse,
  museCommandCandidates,
} from './detect.js'
export type { MuseCommandResult, MuseDetection, MuseDiscoveryOptions } from './detect.js'
export { museHomeEnv, prepareMuseHome } from './prepare-home.js'
export type { PrepareMuseHomeOptions, PreparedMuseHome } from './prepare-home.js'
export { MuseAdapter, museAdapter, museCliHomeDir } from './adapters/muse-adapter.js'
export { register } from './register.js'
