import { randomUUID } from 'node:crypto'
import type { ApprovalRequest } from '@wb/sdk'
import type { StateStore } from './state/store'

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000

interface Waiting {
  resolve: (approved: boolean) => void
  timer: NodeJS.Timeout
}

/**
 * Things only the user can approve: keeping a new plugin, installing its npm
 * dependencies, and every call to a tool that moves hardware. Requests show
 * as cards in the control window; nothing proceeds until the user clicks.
 */
export class Approvals {
  private readonly waiting = new Map<string, Waiting>()

  constructor(private readonly store: StateStore) {}

  request(input: Omit<ApprovalRequest, 'id'>, timeoutMs = APPROVAL_TIMEOUT_MS): Promise<boolean> {
    const id = randomUUID()
    const request: ApprovalRequest = { ...input, id }
    this.store.update((s) => ({ ...s, approvals: [...s.approvals, request] }))
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(id, false), timeoutMs)
      this.waiting.set(id, { resolve, timer })
    })
  }

  settle(id: string, approved: boolean): boolean {
    const waiting = this.waiting.get(id)
    this.store.update((s) => ({ ...s, approvals: s.approvals.filter((a) => a.id !== id) }))
    if (!waiting) return false
    clearTimeout(waiting.timer)
    this.waiting.delete(id)
    waiting.resolve(approved)
    return true
  }

  /** Drop pending requests for a plugin (e.g. it was deleted while waiting). */
  cancelFor(plugin: string): void {
    for (const a of this.store.get().approvals) if (a.plugin === plugin) this.settle(a.id, false)
  }
}
