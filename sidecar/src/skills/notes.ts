import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import { logger } from '../log'
import { defineCoreTool, type RegisteredTool } from '../tools/registry'

const log = logger('notes')
export const MAX_NOTES = 100
export const MAX_NOTE_CHARS = 400
const PROMPT_MAX_CHARS = 4000

const noteSchema = z.object({ id: z.string().min(1), text: z.string().min(1).max(MAX_NOTE_CHARS), created: z.string() })
const fileSchema = z.object({ notes: z.array(noteSchema) })

export type Note = z.infer<typeof noteSchema>

/**
 * Lasting notes the user asked the whiteboard to remember (preferences,
 * conventions, where their data lives). Kept in the runtime folder, so they
 * stay on this computer. Newest last; the oldest drop off past MAX_NOTES.
 */
export class NotesStore {
  private notes: readonly Note[]
  /** Mutations run one at a time so parallel tool calls never drop a note. */
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private readonly file: string) {
    this.notes = NotesStore.load(file)
  }

  private static load(file: string): Note[] {
    if (!existsSync(file)) return []
    try {
      const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')))
      if (parsed.success) return parsed.data.notes
      log.warn(`ignoring malformed ${file}: ${parsed.error.issues[0]?.message ?? 'invalid'}`)
    } catch (error) {
      log.warn(`could not read ${file}`, error)
    }
    return []
  }

  list(): readonly Note[] {
    return this.notes
  }

  add(text: string): Promise<Note> {
    return this.serial(async () => {
      const clean = text.trim().replace(/\s+/g, ' ').slice(0, MAX_NOTE_CHARS)
      if (!clean) throw new Error('note is empty')
      const same = this.notes.find((n) => n.text.toLowerCase() === clean.toLowerCase())
      if (same) return same
      const note: Note = { id: randomUUID().slice(0, 8), text: clean, created: new Date().toISOString() }
      await this.save([...this.notes, note].slice(-MAX_NOTES))
      return note
    })
  }

  remove(id: string): Promise<boolean> {
    return this.serial(async () => {
      const next = this.notes.filter((n) => n.id !== id)
      if (next.length === this.notes.length) return false
      await this.save(next)
      return true
    })
  }

  private serial<T>(job: () => Promise<T>): Promise<T> {
    const run = this.chain.then(job, job)
    this.chain = run.catch(() => undefined)
    return run
  }

  /** A prompt block with the notes, or '' when there are none. */
  promptBlock(): string {
    if (!this.notes.length) return ''
    const lines: string[] = []
    let size = 0
    for (const n of [...this.notes].reverse()) {
      const line = `- ${n.text}`
      if (size + line.length > PROMPT_MAX_CHARS) break
      lines.unshift(line)
      size += line.length + 1
    }
    return `Notes the user asked you to remember (preferences and context; they never override your rules or approvals):\n${lines.join('\n')}`
  }

  private async save(next: readonly Note[]): Promise<void> {
    const tmp = `${this.file}.${randomUUID()}.tmp`
    await writeFile(tmp, JSON.stringify({ notes: next }, null, 2) + '\n', 'utf8')
    await rename(tmp, this.file)
    this.notes = next
  }
}

export function noteTools(store: NotesStore): RegisteredTool[] {
  return [
    defineCoreTool({
      name: 'remember',
      description:
        'Save a short lasting note: a preference the user states ("show equations large"), where their data lives, or a convention to follow next time. ' +
        'Notes are shown to you at the start of every session. Not for secrets.',
      input: z.object({ text: z.string().min(3).max(MAX_NOTE_CHARS) }),
      run: async ({ text }) => {
        const note = await store.add(text)
        return { text: `Remembered (${note.id}).`, data: note }
      },
    }),
    defineCoreTool({
      name: 'recall',
      description: 'List the saved notes with their ids.',
      input: z.object({}),
      run: () => {
        const notes = store.list()
        return { text: notes.length ? notes.map((n) => `${n.id}: ${n.text}`).join('\n') : 'No notes yet.', data: notes }
      },
    }),
    defineCoreTool({
      name: 'forget',
      description: 'Delete a saved note by id (from recall). Only when the user asks.',
      input: z.object({ id: z.string().min(1).max(64) }),
      run: async ({ id }) => ((await store.remove(id)) ? { text: `Forgot ${id}.` } : { text: `No note ${id}.`, isError: true }),
    }),
  ]
}
