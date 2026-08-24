/**
 * HarnessRegistry - Central registry for harness adapters
 *
 * Manages registration and lookup of harness adapters for different
 * coding agent runtimes (Claude Code, Pi, etc.).
 */

import type { HarnessAdapter, HarnessDetection, HarnessId } from 'spaces-config'
import { KeyedRegistry } from '../keyed-registry.js'

/**
 * Registry for harness adapters
 *
 * Provides a central place to register and retrieve harness adapters.
 */
export class HarnessRegistry extends KeyedRegistry<HarnessId, HarnessAdapter> {
  /**
   * Register a harness adapter
   *
   * @param adapter - The adapter to register
   * @throws Error if an adapter with the same ID is already registered
   */
  register(adapter: HarnessAdapter): void {
    this.registerEntry(adapter.id, adapter, 'Harness adapter already registered: ')
  }

  /**
   * Get a harness adapter by ID
   *
   * @param id - The harness ID to look up
   * @returns The adapter, or undefined if not registered
   */
  get(id: HarnessId): HarnessAdapter | undefined {
    return this.getEntry(id)
  }

  /**
   * Get a harness adapter by ID, throwing if not found
   *
   * @param id - The harness ID to look up
   * @returns The adapter
   * @throws Error if the adapter is not registered
   */
  getOrThrow(id: HarnessId): HarnessAdapter {
    return this.getEntryOrThrow(id, 'Harness adapter not found: ')
  }

  /**
   * Check if a harness is registered
   *
   * @param id - The harness ID to check
   */
  has(id: HarnessId): boolean {
    return this.hasEntry(id)
  }

  /**
   * Get all registered harness adapters
   */
  getAll(): HarnessAdapter[] {
    return this.values()
  }

  /**
   * Get all registered harness IDs
   */
  getIds(): HarnessId[] {
    return this.keys()
  }

  /**
   * Detect which harnesses are available
   *
   * Runs detection for all registered harnesses and returns the results.
   *
   * @returns Map of harness ID to detection result
   */
  async detectAvailable(): Promise<Map<HarnessId, HarnessDetection>> {
    const results = new Map<HarnessId, HarnessDetection>()

    await Promise.all(
      this.entryList().map(async ([id, adapter]) => {
        try {
          const detection = await adapter.detect()
          results.set(id, detection)
        } catch (error) {
          // If detection throws, treat as unavailable with error.
          // `HarnessDetection.error` is a flat string, so the underlying
          // stack/cause would otherwise be lost; surface the full error object
          // (preserving stack and `cause`) to a guarded debug log so a
          // misbehaving adapter is diagnosable without altering normal output.
          if (process.env['ASP_DEBUG']) {
            console.debug(`[HarnessRegistry] detect() failed for "${id}":`, error)
          }
          results.set(id, {
            available: false,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      })
    )

    return results
  }

  /**
   * Get all available harnesses (where detection succeeded)
   *
   * @returns Array of harness adapters that are available
   */
  async getAvailable(): Promise<HarnessAdapter[]> {
    const detections = await this.detectAvailable()
    const available: HarnessAdapter[] = []

    for (const [id, detection] of detections) {
      if (detection.available) {
        const adapter = this.get(id)
        if (adapter) {
          available.push(adapter)
        }
      }
    }

    return available
  }

  /**
   * Clear all registered adapters
   *
   * Primarily for testing.
   */
  clear(): void {
    this.clearEntries()
  }
}
