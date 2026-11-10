/** A release whose daemon payloads accept an explicit immutable release root. */
export const FIXED_EXECUTABLE_RELEASE_ROOT_CAPABILITY = 'aspd.fixed-executable-release-root/v1'

export function supportsFixedExecutableReleaseRoot(input: {
  capabilities?: readonly string[] | undefined
}): boolean {
  return input.capabilities?.includes(FIXED_EXECUTABLE_RELEASE_ROOT_CAPABILITY) === true
}

/**
 * A release whose raspd runs sole when started without `--upstream` (T-13018).
 * An older raspd reads a missing `--upstream` as `<run>/aspd-bun.sock`, so a
 * release without this capability is never started without one.
 */
export const RASPD_SOLE_CAPABILITY = 'raspd.sole/v1'

export function supportsRaspdSole(input: {
  capabilities?: readonly string[] | undefined
}): boolean {
  return input.capabilities?.includes(RASPD_SOLE_CAPABILITY) === true
}
