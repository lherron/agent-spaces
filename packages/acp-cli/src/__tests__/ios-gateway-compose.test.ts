import { describe, expect, test } from 'bun:test'

import { renderServerHelp } from '../server-runtime.js'

describe('iOS gateway composition', () => {
  describe('help text', () => {
    test('includes --enable-ios-gateway flag', () => {
      const help = renderServerHelp()
      expect(help).toContain('--enable-ios-gateway')
    })

    test('includes ACP_IOS_GATEWAY_ENABLED env var', () => {
      const help = renderServerHelp()
      expect(help).toContain('ACP_IOS_GATEWAY_ENABLED')
    })

    test('includes iOS gateway env vars', () => {
      const help = renderServerHelp()
      expect(help).toContain('ACP_IOS_GATEWAY_HOST')
      expect(help).toContain('ACP_IOS_GATEWAY_PORT')
      expect(help).toContain('ACP_IOS_GATEWAY_TOKEN')
      expect(help).toContain('ACP_IOS_GATEWAY_ID')
    })
  })

  describe('feature gate defaults', () => {
    test('serve without --enable-ios-gateway does not mention iOS in help as required', () => {
      // The help text documents the flag, but the flag is opt-in.
      // Verify the help describes it as an enabling flag, not a disabling one.
      const help = renderServerHelp()
      expect(help).toContain('--enable-ios-gateway')
      // Should NOT have a --no-ios or --disable style flag
      expect(help).not.toContain('--no-ios')
      expect(help).not.toContain('--disable-ios')
    })
  })
})
