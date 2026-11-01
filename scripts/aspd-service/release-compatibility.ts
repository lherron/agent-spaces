/** A release whose daemon payloads accept an explicit immutable release root. */
export const FIXED_EXECUTABLE_RELEASE_ROOT_CAPABILITY = 'aspd.fixed-executable-release-root/v1'

export function supportsFixedExecutableReleaseRoot(input: {
  capabilities?: readonly string[] | undefined
}): boolean {
  return input.capabilities?.includes(FIXED_EXECUTABLE_RELEASE_ROOT_CAPABILITY) === true
}
