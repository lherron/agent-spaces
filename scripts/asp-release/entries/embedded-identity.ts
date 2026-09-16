import type { AspReleaseIdentity } from 'spaces-harness-broker-protocol'

// Replaced by `bun build --define` when a release is built (scripts/asp-release.ts).
// A checkout run leaves it undefined, so the executable reports no release.
declare const ASP_RELEASE_EMBEDDED_IDENTITY: AspReleaseIdentity | undefined

export const embeddedReleaseIdentity: AspReleaseIdentity | undefined =
  typeof ASP_RELEASE_EMBEDDED_IDENTITY === 'undefined' ? undefined : ASP_RELEASE_EMBEDDED_IDENTITY
