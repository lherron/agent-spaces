import type { DriverSummary } from 'spaces-harness-broker-protocol'
import type { Driver } from './driver'

export interface DriverRegistry {
  get(kind: string): Driver | undefined
  summaries(): DriverSummary[]
}

export function createDriverRegistry(drivers: Driver[]): DriverRegistry {
  const map = new Map<string, Driver>()
  for (const driver of drivers) {
    map.set(driver.kind, driver)
  }

  return {
    get(kind: string): Driver | undefined {
      return map.get(kind)
    },
    summaries(): DriverSummary[] {
      return drivers.map((d) => ({
        kind: d.kind,
        version: d.version,
        available: true,
        capabilities: d.capabilities(),
      }))
    },
  }
}
