export type QueueSchedule = (callback: () => void) => () => void

export type QueueTask<T> = {
  value: T
  schedule: QueueSchedule
  run: (value: T, isCurrent: () => boolean) => Promise<void>
  onError: (error: unknown) => void
}

export function createSerialLatestQueue<T>() {
  let latest: QueueTask<T> | undefined
  let dirty = false
  let running = false
  let scheduled = false
  let cancelScheduled: (() => void) | undefined
  let generation = 0

  function scheduleDrain(task: QueueTask<T>): void {
    if (running || scheduled) return
    scheduled = true
    try {
      const cancel = task.schedule(() => {
        scheduled = false
        cancelScheduled = undefined
        void drain()
      })
      cancelScheduled = cancel
    } catch (error) {
      scheduled = false
      cancelScheduled = undefined
      task.onError(error)
    }
  }

  async function drain(): Promise<void> {
    if (running) return
    running = true
    try {
      while (dirty && latest) {
        const task = latest
        latest = undefined
        dirty = false
        const taskGeneration = generation
        try {
          await task.run(task.value, () => generation === taskGeneration)
        } catch (error) {
          task.onError(error)
        }
      }
    } finally {
      running = false
      if (dirty && latest) scheduleDrain(latest)
    }
  }

  return {
    enqueue(task: QueueTask<T>): void {
      latest = task
      dirty = true
      scheduleDrain(task)
    },
    reset(): void {
      generation += 1
      latest = undefined
      dirty = false
      if (scheduled) cancelScheduled?.()
      scheduled = false
      cancelScheduled = undefined
    },
  }
}
