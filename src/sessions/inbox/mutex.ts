export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>()

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(operation)
    let tail: Promise<unknown>
    tail = next.finally(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    })
    this.tails.set(key, tail)
    return await next
  }
}
