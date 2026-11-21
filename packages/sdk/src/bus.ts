/**
 * The data bus: named live streams (`titan/lidar`, `titan/left_encoder`) that
 * anything can publish to or subscribe to. Each topic keeps its latest message
 * and a bounded history. A throwing subscriber never affects the others.
 */

export interface BusMessage<T = unknown> {
  topic: string
  /** Seconds. Recorded time for playback, wall time for live data. */
  t: number
  data: T
}

export type BusListener<T = unknown> = (message: BusMessage<T>) => void
export type Unsubscribe = () => void

export interface DataBusOptions {
  historySize?: number
  onListenerError?: (topic: string, error: unknown) => void
}

class Ring<T> {
  private readonly items: (T | undefined)[]
  private start = 0
  private count = 0

  constructor(private readonly capacity: number) {
    this.items = new Array<T | undefined>(capacity)
  }

  push(item: T): void {
    const index = (this.start + this.count) % this.capacity
    this.items[index] = item
    if (this.count < this.capacity) this.count += 1
    else this.start = (this.start + 1) % this.capacity
  }

  last(n: number): T[] {
    const take = Math.max(0, Math.min(n, this.count))
    const out: T[] = []
    for (let i = this.count - take; i < this.count; i += 1) {
      const item = this.items[(this.start + i) % this.capacity]
      if (item !== undefined) out.push(item)
    }
    return out
  }

  clear(): void {
    this.items.fill(undefined)
    this.start = 0
    this.count = 0
  }
}

export const DEFAULT_HISTORY = 2000

export class DataBus {
  private readonly listeners = new Map<string, Set<BusListener>>()
  private readonly wildcard = new Set<BusListener>()
  private readonly latestByTopic = new Map<string, BusMessage>()
  private readonly historyByTopic = new Map<string, Ring<BusMessage>>()
  private readonly topicListeners = new Set<(topics: string[]) => void>()
  private readonly historySize: number
  private readonly onListenerError: (topic: string, error: unknown) => void

  constructor(options: DataBusOptions = {}) {
    this.historySize = Math.max(1, options.historySize ?? DEFAULT_HISTORY)
    this.onListenerError = options.onListenerError ?? (() => undefined)
  }

  publish<T>(topic: string, data: T, t: number = Date.now() / 1000): void {
    if (!topic) throw new Error('topic is required')
    const message: BusMessage<T> = { topic, t, data }
    const isNew = !this.latestByTopic.has(topic)
    this.latestByTopic.set(topic, message)
    let ring = this.historyByTopic.get(topic)
    if (!ring) {
      ring = new Ring<BusMessage>(this.historySize)
      this.historyByTopic.set(topic, ring)
    }
    ring.push(message)
    if (isNew) this.emitTopics()
    this.deliver(this.listeners.get(topic), message)
    this.deliver(this.wildcard, message)
  }

  /** Subscribe to one topic, or to every topic with `*`. */
  subscribe<T = unknown>(topic: string, listener: BusListener<T>): Unsubscribe {
    const l = listener as BusListener
    if (topic === '*') {
      this.wildcard.add(l)
      return () => this.wildcard.delete(l)
    }
    let set = this.listeners.get(topic)
    if (!set) {
      set = new Set()
      this.listeners.set(topic, set)
    }
    set.add(l)
    return () => {
      set?.delete(l)
    }
  }

  latest<T = unknown>(topic: string): BusMessage<T> | undefined {
    return this.latestByTopic.get(topic) as BusMessage<T> | undefined
  }

  history<T = unknown>(topic: string, n: number = this.historySize): BusMessage<T>[] {
    return (this.historyByTopic.get(topic)?.last(n) ?? []) as BusMessage<T>[]
  }

  topics(): string[] {
    return [...this.latestByTopic.keys()].sort()
  }

  onTopics(listener: (topics: string[]) => void): Unsubscribe {
    this.topicListeners.add(listener)
    return () => this.topicListeners.delete(listener)
  }

  /** Forget a topic's data (e.g. when playback seeks). Listeners stay. */
  clear(topic?: string): void {
    if (topic) {
      this.historyByTopic.get(topic)?.clear()
      this.latestByTopic.delete(topic)
    } else {
      this.historyByTopic.clear()
      this.latestByTopic.clear()
    }
    this.emitTopics()
  }

  private deliver(set: Set<BusListener> | undefined, message: BusMessage): void {
    if (!set) return
    for (const listener of [...set]) {
      try {
        listener(message)
      } catch (error) {
        this.onListenerError(message.topic, error)
      }
    }
  }

  private emitTopics(): void {
    const topics = this.topics()
    for (const listener of [...this.topicListeners]) {
      try {
        listener(topics)
      } catch (error) {
        this.onListenerError('(topics)', error)
      }
    }
  }
}
