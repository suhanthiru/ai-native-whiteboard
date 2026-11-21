import { existsSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

const fileSchema = z.object({ plugins: z.record(z.string(), z.string()) })
const FILE = 'approved.json'

/**
 * plugins/approved.json (and boards/<b>/plugins/approved.json): the content
 * hash the user approved for each plugin. Committed to git, so approvals are
 * part of the history and roll back with it.
 */
export class ApprovedStore {
  private chain: Promise<void> = Promise.resolve()

  async isApproved(pluginsDir: string, name: string, hash: string): Promise<boolean> {
    return (await this.read(pluginsDir))[name] === hash
  }

  /** Serialised read-modify-write, written atomically, so two quick Keeps cannot lose one. */
  approve(pluginsDir: string, name: string, hash: string): Promise<void> {
    const job = this.chain.then(async () => {
      const current = await this.read(pluginsDir)
      const next = Object.fromEntries(Object.entries({ ...current, [name]: hash }).sort(([a], [b]) => a.localeCompare(b)))
      const file = join(pluginsDir, FILE)
      await writeFile(`${file}.tmp`, JSON.stringify({ plugins: next }, null, 2) + '\n', 'utf8')
      await rename(`${file}.tmp`, file)
    })
    this.chain = job.catch(() => undefined)
    return job
  }

  async read(pluginsDir: string): Promise<Record<string, string>> {
    const file = join(pluginsDir, FILE)
    if (!existsSync(file)) return {}
    try {
      const parsed = fileSchema.safeParse(JSON.parse(await readFile(file, 'utf8')))
      return parsed.success ? parsed.data.plugins : {}
    } catch {
      return {} // unreadable file: nothing counts as approved, so plugins ask again
    }
  }
}
