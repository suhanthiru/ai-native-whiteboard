import { McapIndexedReader } from '@mcap/core'
import { defineAdapter, type AdapterApi, type ReadableFile } from '@wb/sdk'
import { makeDecoder, mapTopic, toOutgoing, type Decoder } from './decode'

const STATUS_EVERY_MS = 200
const MAX_SLEEP_MS = 250
const RATES = [0.25, 0.5, 1, 2, 4]

interface State {
  api: AdapterApi
  reader: McapIndexedReader
  file: ReadableFile
  fileName: string
  prefix: string
  loop: boolean
  start: bigint
  end: bigint
  cursor: bigint
  rate: number
  playing: boolean
  token: number
  decoders: Map<number, { topic: string; decode: Decoder | null; error?: string }>
  lastStatus: number
}

let state: State | null = null

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const seconds = (ns: bigint) => Number(ns) / 1e9

function status(s: State) {
  return { playing: s.playing, t: seconds(s.cursor - s.start), duration: seconds(s.end - s.start), rate: s.rate, file: s.fileName }
}

function publishStatus(s: State, force = false): void {
  const now = Date.now()
  if (!force && now - s.lastStatus < STATUS_EVERY_MS) return
  s.lastStatus = now
  s.api.publish(mapTopic(s.prefix, 'playback'), status(s), seconds(s.cursor - s.start))
}

async function run(s: State, token: number): Promise<void> {
  const wallStart = Date.now()
  const logStart = s.cursor
  for await (const msg of s.reader.readMessages({ startingAt: s.cursor })) {
    if (token !== s.token) return
    // Wait until this message's moment, in short slices so pause/seek stay responsive.
    for (;;) {
      const due = Number(msg.logTime - logStart) / 1e6 / s.rate
      const wait = due - (Date.now() - wallStart)
      if (wait <= 0) break
      await sleep(Math.min(wait, MAX_SLEEP_MS))
      if (token !== s.token) return
    }
    s.cursor = msg.logTime
    const channel = s.decoders.get(msg.channelId)
    if (channel?.decode) {
      const out = toOutgoing(channel.decode(msg.data))
      const t = seconds(msg.logTime - s.start)
      if (out.kind === 'binary') s.api.publishBinary(channel.topic, out.payload, t, out.meta)
      else s.api.publish(channel.topic, out.data, t)
    }
    publishStatus(s)
  }
  if (token !== s.token) return
  if (s.loop) {
    s.cursor = s.start
    return run(s, token)
  }
  s.playing = false
  publishStatus(s, true)
}

function play(s: State): string {
  if (s.playing) return 'Already playing.'
  if (s.cursor >= s.end) s.cursor = s.start
  s.playing = true
  s.token += 1
  void run(s, s.token).catch((e: unknown) => s.api.log(`playback stopped: ${e instanceof Error ? e.message : String(e)}`))
  publishStatus(s, true)
  return `Playing ${s.fileName} at ${s.rate}x.`
}

function pause(s: State): string {
  s.playing = false
  s.token += 1
  publishStatus(s, true)
  return 'Paused.'
}

async function pickFile(api: AdapterApi): Promise<string> {
  const wanted = typeof api.config.file === 'string' ? api.config.file : null
  const files = (await api.board.data.list()).filter((f) => f.path.toLowerCase().endsWith('.mcap'))
  const chosen = wanted ? files.find((f) => f.path === wanted) : files[0]
  if (!chosen) throw new Error(wanted ? `data/${wanted} not found` : 'no .mcap file in data/')
  return chosen.path
}

export default defineAdapter({
  async start(api) {
    const fileName = await pickFile(api)
    const file = await api.board.data.open(fileName)
    const reader = await McapIndexedReader.Initialize({ readable: file })
    const prefix = typeof api.config.topicPrefix === 'string' ? api.config.topicPrefix : api.board.name.split('-')[0] ?? ''
    const decoders: State['decoders'] = new Map()
    for (const [id, ch] of reader.channelsById) {
      const schema = reader.schemasById.get(ch.schemaId)
      try {
        decoders.set(id, { topic: mapTopic(prefix, ch.topic), decode: makeDecoder({ topic: ch.topic, messageEncoding: ch.messageEncoding, schemaName: schema?.name ?? '', schemaEncoding: schema?.encoding ?? '', schemaData: schema?.data ?? new Uint8Array() }) })
      } catch (error) {
        decoders.set(id, { topic: mapTopic(prefix, ch.topic), decode: null, error: error instanceof Error ? error.message : String(error) })
        api.log(String(error))
      }
    }
    const start = reader.statistics?.messageStartTime ?? 0n
    const end = reader.statistics?.messageEndTime ?? start
    const s: State = { api, reader, file, fileName, prefix, loop: api.config.loop !== false, start, end, cursor: start, rate: 1, playing: false, token: 0, decoders, lastStatus: 0 }
    state = s

    const topics = [...decoders.values()].map((d) => (d.decode ? d.topic : `${d.topic} (unsupported: ${d.error})`))
    api.registerTool({ name: 'play', description: `Play the recorded log (${fileName}) into the data bus. Topics: ${topics.join(', ')}`, inputSchema: { type: 'object', properties: {} }, run: () => play(s) })
    api.registerTool({ name: 'pause', description: 'Pause playback.', inputSchema: { type: 'object', properties: {} }, run: () => pause(s) })
    api.registerTool({
      name: 'seek',
      description: 'Jump to a time in the log, in seconds from its start.',
      inputSchema: { type: 'object', properties: { t: { type: 'number', minimum: 0 } }, required: ['t'] },
      run: (args) => {
        const t = Math.max(0, Math.min(Number(args.t) || 0, seconds(s.end - s.start)))
        const wasPlaying = s.playing
        pause(s)
        s.cursor = s.start + BigInt(Math.round(t * 1e9))
        if (wasPlaying) play(s)
        publishStatus(s, true)
        return `At ${t.toFixed(1)}s.`
      },
    })
    api.registerTool({
      name: 'set_rate',
      description: `Playback speed: one of ${RATES.join(', ')}.`,
      inputSchema: { type: 'object', properties: { rate: { type: 'number', enum: RATES } }, required: ['rate'] },
      run: (args) => {
        const rate = Number(args.rate)
        if (!RATES.includes(rate)) throw new Error(`rate must be one of ${RATES.join(', ')}`)
        const wasPlaying = s.playing
        pause(s)
        s.rate = rate
        if (wasPlaying) play(s)
        return `Speed ${rate}x.`
      },
    })
    api.registerTool({ name: 'status', description: 'Playback position, duration, speed and topics.', inputSchema: { type: 'object', properties: {} }, run: () => ({ text: `${s.playing ? 'Playing' : 'Paused'} at ${status(s).t.toFixed(1)}s of ${status(s).duration.toFixed(1)}s.`, ...status(s), topics }) })

    publishStatus(s, true)
    if (api.config.autoplay === true) play(s)
  },
  async stop() {
    if (!state) return
    state.token += 1
    await state.file.close()
    state = null
  },
})
