/**
 * Shared keyed registry core for runtime registries.
 *
 * Keep this package-internal: domain registries expose their own method names
 * and error messages while sharing the Map mechanics.
 */
export class KeyedRegistry<K, V> {
  private readonly entries = new Map<K, V>()

  protected registerEntry(key: K, value: V, duplicateMessagePrefix: string): void {
    if (this.entries.has(key)) {
      throw new Error(`${duplicateMessagePrefix}${String(key)}`)
    }
    this.entries.set(key, value)
  }

  protected getEntry(key: K): V | undefined {
    return this.entries.get(key)
  }

  protected getEntryOrThrow(key: K, missingMessagePrefix: string): V {
    const value = this.entries.get(key)
    if (!value) {
      throw new Error(`${missingMessagePrefix}${String(key)}`)
    }
    return value
  }

  protected hasEntry(key: K): boolean {
    return this.entries.has(key)
  }

  protected values(): V[] {
    return Array.from(this.entries.values())
  }

  protected keys(): K[] {
    return Array.from(this.entries.keys())
  }

  protected entryList(): [K, V][] {
    return Array.from(this.entries.entries())
  }

  protected clearEntries(): void {
    this.entries.clear()
  }
}
