export class EventIterator<T> implements AsyncIterable<T>, AsyncIterator<T> {
  #buffer: T[] = []
  #waiters: Array<(result: IteratorResult<T>) => void> = []
  #closed = false
  // Owner deregistration hook, fired exactly once when the consumer abandons
  // this iterator via `return()` (a `for await … of` break / early return).
  // The owning {@link InvocationEventHub} installs it so an abandoned stream is
  // dropped from the hub's live-stream map instead of leaking until dispose.
  #onReturn: (() => void) | undefined

  /** Install the one-shot owner-deregistration hook (see {@link return}). */
  setOnReturn(onReturn: () => void): void {
    this.#onReturn = onReturn
  }

  push(event: T): void {
    if (this.#closed) {
      return
    }

    const waiter = this.#waiters.shift()
    if (waiter) {
      waiter({ done: false, value: event })
      return
    }

    this.#buffer.push(event)
  }

  close(): void {
    if (this.#closed) {
      return
    }

    this.#closed = true
    const waiters = this.#waiters.splice(0)
    for (const waiter of waiters) {
      waiter({ done: true, value: undefined })
    }
  }

  next(): Promise<IteratorResult<T>> {
    const event = this.#buffer.shift()
    if (event !== undefined) {
      return Promise.resolve({ done: false, value: event })
    }

    if (this.#closed) {
      return Promise.resolve({ done: true, value: undefined })
    }

    return new Promise<IteratorResult<T>>((resolve) => {
      this.#waiters.push(resolve)
    })
  }

  return(): Promise<IteratorResult<T>> {
    // The consumer abandoned the stream (for-await break / early return). Fire
    // the owner-deregistration hook exactly once so the hub forgets this stream
    // rather than retaining it until dispose/closeAll — otherwise short-lived
    // attaches that break out of their loop slowly leak registered streams.
    const onReturn = this.#onReturn
    this.#onReturn = undefined
    onReturn?.()
    return Promise.resolve({ done: true, value: undefined })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this
  }
}
