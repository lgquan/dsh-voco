export interface TestSnapshotStore<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
  set(value: T): void
}

export function createSnapshotStore<T>(initial: T): TestSnapshotStore<T> {
  let current = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => current,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: (value) => {
      current = value
      for (const listener of listeners) listener()
    },
  }
}
