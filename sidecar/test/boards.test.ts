import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BoardIndex, scoreBoard } from '../src/boards/index'
import { compareLock, computeLock, readLock, writeLock } from '../src/boards/lock'
import { checkRequirement, checkRequirements, mcapTopics } from '../src/boards/requirements'
import { BoardData, BoardPathError } from '../src/boards/scoped'
import { boardSchema } from '../src/boards/schema'

const DEMO_DATA = join(process.cwd(), 'boards', 'titan-demo', 'data')

let root: string
let data: BoardData

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'wb-boards-'))
  const board = join(root, 'boards', 'demo')
  mkdirSync(join(board, 'data', 'logs'), { recursive: true })
  writeFileSync(join(board, 'data', 'a.txt'), 'hello')
  writeFileSync(join(board, 'data', 'logs', 'b.bin'), Buffer.from([1, 2, 3]))
  writeFileSync(join(board, 'data', '.gitkeep'), '')
  writeFileSync(join(root, 'secret.txt'), 'nope')
  writeFileSync(join(board, 'board.json'), JSON.stringify({ name: 'demo', title: 'Proto Forest', aliases: ['the forest'] }))
  mkdirSync(join(root, 'boards', 'broken'))
  writeFileSync(join(root, 'boards', 'broken', 'board.json'), '{"name": 7}')
  data = new BoardData(join(board, 'data'))
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('BoardData (scoped file access)', () => {
  it('lists files relative to data/, skipping dotfiles', async () => {
    expect(await data.list()).toEqual([
      { path: 'a.txt', size: 5 },
      { path: 'logs/b.bin', size: 3 },
    ])
  })

  it('reads files inside the board', async () => {
    expect((await data.read('a.txt')).toString()).toBe('hello')
    expect((await data.read('data/logs/b.bin')).length).toBe(3)
    const file = await data.open('logs/b.bin')
    expect(await file.size()).toBe(3n)
    expect([...(await file.read(1n, 2n))]).toEqual([2, 3])
    await file.close()
  })

  it.each(['../../secret.txt', '../board.json', '/etc/hosts', 'C:/Windows/win.ini', 'missing.txt'])('refuses %j', async (p) => {
    await expect(data.read(p)).rejects.toBeInstanceOf(BoardPathError)
  })

  it('refuses symlinks that point outside the board', async () => {
    const link = join(data.dataDir, 'escape.txt')
    try {
      symlinkSync(join(root, 'secret.txt'), link)
    } catch {
      return // creating symlinks needs extra rights on Windows; the realpath check is covered elsewhere
    }
    await expect(data.read('escape.txt')).rejects.toThrow(/outside the board/)
  })
})

describe('data.lock.json', () => {
  it('records, reads and compares files', async () => {
    const lockFile = join(root, 'boards', 'demo', 'data.lock.json')
    const lock = await computeLock(data)
    expect(lock.files.map((f) => f.path)).toEqual(['a.txt', 'logs/b.bin'])
    await writeLock(lockFile, lock)
    expect(await readLock(lockFile)).toEqual(lock)

    const hash = async (p: string) => lock.files.find((f) => f.path === p)?.sha256 ?? ''
    const same = await compareLock(lock, await data.list(), hash)
    expect(same.issues).toEqual([])
    expect(same.files.every((f) => f.status === 'ok')).toBe(true)

    const changed = await compareLock(lock, [{ path: 'a.txt', size: 99 }, { path: 'new.bin', size: 1 }], hash)
    expect(changed.files.map((f) => `${f.path}:${f.status}`)).toEqual(['a.txt:changed', 'logs/b.bin:missing', 'new.bin:unlocked'])
    expect(changed.issues).toHaveLength(2)
  })

  it('suggests locking when there is no lock file', async () => {
    const result = await compareLock(null, [{ path: 'x', size: 1 }], async () => '')
    expect(result.issues[0]).toMatch(/lock_board_data/)
    expect(await readLock(join(root, 'nope.json'))).toBeNull()
  })
})

describe('board index', () => {
  it('finds boards by spoken name or alias and skips invalid ones', async () => {
    const index = new BoardIndex(join(root, 'boards'))
    const boards = await index.scan()
    expect(boards.map((b) => b.file.name)).toEqual(['demo'])
    expect(index.find('pull up the proto forest')?.file.name).toBe('demo')
    expect(index.find('the forest')?.file.name).toBe('demo')
    expect(index.find('spaceship')).toBeNull()
  })

  it('scores exact names highest', () => {
    const board = boardSchema.parse({ name: 'titan-demo', title: 'Titan', aliases: ['titan'] })
    expect(scoreBoard('titan', board)).toBe(100)
    expect(scoreBoard('the titan robot', board)).toBeGreaterThan(40)
    expect(scoreBoard('', board)).toBe(0)
  })

  it('rejects absolute model paths in board.json', () => {
    expect(boardSchema.safeParse({ name: 'x', model: 'C:/models/a.glb' }).success).toBe(false)
    expect(boardSchema.safeParse({ name: 'x', model: 'data/a.glb' }).success).toBe(true)
  })
})

describe('plugin data requirements', () => {
  const demo = new BoardData(DEMO_DATA)

  it('reads topics from an MCAP summary', async () => {
    const topics = await mcapTopics(demo, 'run_01.mcap', 0)
    expect(topics).toEqual(['/camera', '/imu', '/left_encoder', '/lidar', '/right_encoder'])
  })

  it('is met when a file with the topics exists', async () => {
    const files = await demo.list()
    expect((await checkRequirement({ type: 'mcap', topics: ['/lidar'] }, demo, files)).met).toBe(true)
    expect((await checkRequirements([{ type: 'glb' }, { type: 'mcap' }], demo, files)).files).toContain('titan.glb')
  })

  it('explains what is missing', async () => {
    const files = await demo.list()
    const missingTopic = await checkRequirement({ type: 'mcap', topics: ['/gps'] }, demo, files)
    expect(missingTopic.met).toBe(false)
    expect(missingTopic.message).toMatch(/\/gps/)
    const noFile = await checkRequirement({ type: 'pointcloud', hint: 'drop a .las scan into data/' }, demo, files)
    expect(noFile.message).toBe('drop a .las scan into data/')
    expect((await checkRequirement({ type: 'mcap' }, null, [])).message).toMatch(/open a board/)
  })
})
