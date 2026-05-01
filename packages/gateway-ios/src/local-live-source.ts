import type { HrcLifecycleEvent, HrcMessageRecord } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'
import type { HrcDatabase } from 'hrc-store-sqlite'

export type LocalLiveFilter = {
  hostSessionId?: string | undefined
  generation?: number | undefined
}

export type LocalLiveSource = {
  pollEvents(afterSeq: number, filter: LocalLiveFilter): Promise<HrcLifecycleEvent[]>
  pollMessages(afterSeq: number, filter: LocalLiveFilter): Promise<HrcMessageRecord[]>
  close?(): void
}

export function createSqliteLocalLiveSource(dbPath: string): LocalLiveSource {
  const db = openHrcDatabase(dbPath)
  return createSqliteLocalLiveSourceFromDb(db)
}

export function createSqliteLocalLiveSourceFromDb(db: HrcDatabase): LocalLiveSource {
  return {
    async pollEvents(afterSeq, filter) {
      const fromHrcSeq = Math.max(1, afterSeq + 1)
      return db.hrcEvents
        .listFromHrcSeq(fromHrcSeq, {
          hostSessionId: filter.hostSessionId,
          generation: filter.generation,
        })
        .filter((event) => event.hrcSeq > afterSeq)
    },

    async pollMessages(afterSeq, filter) {
      return db.messages.query({
        afterSeq,
        hostSessionId: filter.hostSessionId,
        generation: filter.generation,
      })
    },

    close() {
      db.close()
    },
  }
}
