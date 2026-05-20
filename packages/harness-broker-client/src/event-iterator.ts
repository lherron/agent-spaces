export class EventIterator<T> implements AsyncIterable<T>, AsyncIterator<T> {
  #buffer: T[] = []
  #waiters: Array<(result: IteratorResult<T>) => void> = []
  #closed = false

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
    return Promise.resolve({ done: true, value: undefined })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this
  }
}
