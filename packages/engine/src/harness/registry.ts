/**
 * HarnessRegistry - Central registry for harness adapters
 *
 * Manages registration and lookup of harness adapters for different
 * coding agent runtimes (Claude Code, Pi, etc.).
 */

import type { HarnessAdapter, HarnessDetection, HarnessId } from 'spaces-core'

/**
 * Registry for harness adapters
 *
 * Provides a central place to register and retrieve harness adapters.
 * The registry is initialized with built-in adapters (Claude, Pi) and
 * allows additional adapters to be registered for extensibility.
 */
export class HarnessRegistry {
  private adapters = new Map<HarnessId, HarnessAdapter>()

  /**
   * Register a harness adapter
   *
   * @param adapter - The adapter to register
   * @throws Error if an adapter with the same ID is already registered
   */
  register(adapter: HarnessAdapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`Harness adapter already registered: ${adapter.id}`)
    }
    this.adapters.set(adapter.id, adapter)
  }

  /**
   * Get a harness adapter by ID
   *
   * @param id - The harness ID to look up
   * @returns The adapter, or undefined if not registered
   */
  get(id: HarnessId): HarnessAdapter | undefined {
    return this.adapters.get(id)
  }

  /**
   * Get a harness adapter by ID, throwing if not found
   *
   * @param id - The harness ID to look up
   * @returns The adapter
   * @throws Error if the adapter is not registered
   */
  getOrThrow(id: HarnessId): HarnessAdapter {
    const adapter = this.adapters.get(id)
    if (!adapter) {
      throw new Error(`Harness adapter not found: ${id}`)
    }
    return adapter
  }

  /**
   * Check if a harness is registered
   *
   * @param id - The harness ID to check
   */
  has(id: HarnessId): boolean {
    return this.adapters.has(id)
  }

  /**
   * Get all registered harness adapters
   */
  getAll(): HarnessAdapter[] {
    return Array.from(this.adapters.values())
  }

  /**
   * Get all registered harness IDs
   */
  getIds(): HarnessId[] {
    return Array.from(this.adapters.keys())
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
      Array.from(this.adapters.entries()).map(async ([id, adapter]) => {
        try {
          const detection = await adapter.detect()
          results.set(id, detection)
        } catch (error) {
          // If detection throws, treat as unavailable with error
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
        const adapter = this.adapters.get(id)
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
    this.adapters.clear()
  }
}

/**
 * Global harness registry singleton
 *
 * This is the primary registry used by the engine and CLI.
 * Adapters are registered during initialization.
 */
export const harnessRegistry = new HarnessRegistry()
