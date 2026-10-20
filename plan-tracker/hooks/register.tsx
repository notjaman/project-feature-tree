import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Row, Snap, Status } from '../types'

const PANE = 'plans'
const TITLE = 'Plans'
// ponytail: a const, not userConfig; make it an option if people want a different labeller
const LABEL_MODEL = 'claude-haiku-5-5'

const rows = atom({ plugin: 'plan-tracker', key: 'rows' } as const, null)
const scanning = atom({ plugin: 'plan-tracker', key: 'scanning' } as const, false)

// transcript lines worth parsing: plan submits and their answers, commits, failed tool calls, plan-file writes
const PATTERN = String.raw`"name":"ExitPlanMode"|approved your plan|"is_error":true|git (-C [^ ]+ )?commit|\.claude/plans/`
// prints every line of every .jsonl under the folder that matches the pattern
const FILTER = String.raw`my ($re, $dir) = @ARGV; $re = qr/$re/; find(sub { return unless /\.jsonl$/ && -f; open(my $f, "<", $_) or return; while (<$f>) { print if $_ =~ $re } }, $dir)`
// a commit run as a command, not a script or grep that only mentions one
const COMMIT = /(?:^|&&|\|\||[;|(\n])\s*git\s+(?:-C\s+\S+\s+)?commit\b/
const PLAN_PATH = /\/\.claude\/plans\/([^/]+\.md)$/

const LABEL_SYSTEM =
  'You name the module or feature a software plan works on. Reply with 2-4 plain words and nothing else: no project name, punctuation or quotes.'

export type Ev =
  | { k: 'submit'; id: string; file: string; ts: number; cwd: string; session: string; title: string }
  | { k: 'result'; id: string; ts: number; isError: boolean; text: string }
  | { k: 'commit'; id: string; ts: number; session: string }
  | { k: 'write'; file: string; ts: number; cwd: string }

export type Plan = { file: string; title: string; mtimeMs: number }

const len = (s: string) => [...s].length
const cut = (s: string, max: number) => (len(s) > max ? [...s].slice(0, Math.max(0, max - 1)).join('') + '…' : s)
const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - len(s)))
const base = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p

export function titleOf(md: string, file: string) {
  const heading = /^#\s+(.+)$/m.exec(md)?.[1]
  return heading ? heading.replace(/^plan:\s*/i, '').trim() : file.replace(/\.md$/, '')
}

const textOf = (c: unknown): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map(b => (typeof b?.text === 'string' ? b.text : '')).join('') : ''

// One transcript line to the events the status rules read.
export function parseLine(line: string): Ev[] {
  let d: any
  try {
    d = JSON.parse(line)
  } catch {
    return []
  }
  const blocks = d?.message?.content
  const ts = Date.parse(d?.timestamp)
  if (!Array.isArray(blocks) || Number.isNaN(ts)) return []
  const cwd = typeof d.cwd === 'string' ? d.cwd : ''
  const session = String(d.sessionId ?? '')
  return blocks.flatMap((b: any): Ev[] => {
    if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string') {
      // the answer's wording sits in its first few hundred characters
      return [{ k: 'result', id: b.tool_use_id, ts, isError: b.is_error === true, text: textOf(b.content).slice(0, 400) }]
    }
    if (b?.type !== 'tool_use' || typeof b.id !== 'string') return []
    const input = b.input ?? {}
    if (b.name === 'ExitPlanMode' && !d.isSidechain && typeof input.planFilePath === 'string') {
      const file = PLAN_PATH.exec(input.planFilePath)?.[1]
      if (!file || file.includes('-agent-')) return []
      return [{ k: 'submit', id: b.id, file, ts, cwd, session, title: titleOf(String(input.plan ?? ''), file) }]
    }
    if (b.name === 'Bash' && COMMIT.test(String(input.command ?? ''))) return [{ k: 'commit', id: b.id, ts, session }]
    if (b.name === 'Write' || b.name === 'Edit') {
      const file = PLAN_PATH.exec(String(input.file_path ?? ''))?.[1]
      if (file && !file.includes('-agent-')) return [{ k: 'write', file, ts, cwd }]
    }
    return []
  })
}

type Answer = { approved: boolean; feedback: boolean; ts: number }

function answerOf(r: Extract<Ev, { k: 'result' }> | undefined): Answer | undefined {
  if (!r) return undefined
  if (r.text.startsWith('User has approved your plan')) return { approved: true, feedback: false, ts: r.ts }
  if (r.isError && r.text.includes("doesn't want to proceed"))
    return { approved: false, feedback: r.text.includes('the user said:'), ts: r.ts }
  // a tool_use_error (not in plan mode) answers nothing
  return undefined
}

// Status from the plan's last answered submit:
// plain reject = cancelled; approved, or rejected with feedback, = done once a commit lands
// in that session before the next plan is submitted there, pending until then.
export function derive(evs: Ev[], plans: Plan[]): Record<string, Snap> {
  const results = new Map<string, Extract<Ev, { k: 'result' }>>()
  const submits: Extract<Ev, { k: 'submit' }>[] = []
  const commits: Extract<Ev, { k: 'commit' }>[] = []
  const writes: Extract<Ev, { k: 'write' }>[] = []
  for (const e of evs) {
    if (e.k === 'result') results.set(e.id, e)
    else if (e.k === 'submit') submits.push(e)
    else if (e.k === 'commit') commits.push(e)
    else writes.push(e)
  }
  submits.sort((a, b) => a.ts - b.ts)
  const landed = commits.filter(c => results.get(c.id)?.isError !== true)

  const statusOf = (file: string): Status => {
    let last: { s: (typeof submits)[number]; a: Answer } | undefined
    for (const s of submits) {
      const a = s.file === file ? answerOf(results.get(s.id)) : undefined
      if (a) last = { s, a }
    }
    if (!last) return 'pending'
    const { s, a } = last
    if (!a.approved && !a.feedback) return 'cancelled'
    const end = submits.find(o => o.session === s.session && o.ts > s.ts && o.file !== file)?.ts ?? Infinity
    return landed.some(c => c.session === s.session && c.ts > a.ts && c.ts < end) ? 'done' : 'pending'
  }

  // plans whose file is gone but whose submit is still in a transcript come back as gone rows
  const all = new Map(plans.map(p => [p.file, { ...p, gone: false }]))
  for (const s of submits) if (!all.has(s.file)) all.set(s.file, { file: s.file, title: s.title, mtimeMs: 0, gone: true })

  const out: Record<string, Snap> = {}
  for (const p of all.values()) {
    const first = [...submits, ...writes].filter(e => e.file === p.file).sort((a, b) => a.ts - b.ts)[0]
    out[p.file] = {
      title: p.title,
      // ponytail: project = cwd basename; git toplevel if sessions start in subdirs
      project: first?.cwd ? base(first.cwd) : '—',
      ...(first?.cwd ? { cwd: first.cwd } : {}),
      ts: first?.ts ?? p.mtimeMs,
      auto: statusOf(p.file),
      ...(submits.some(s => s.file === p.file) ? { seen: true } : {}),
      mtimeMs: p.mtimeMs,
      ...(p.gone ? { gone: true } : {}),
    }
  }
  return out
}

// Fresh rows win; stored rows missing from this scan stay, marked gone; labels carry over.
export function merge(snap: Record<string, Snap>, fresh: Record<string, Snap>) {
  const out: Record<string, Snap> = {}
  for (const [f, s] of Object.entries(snap)) out[f] = { ...s, gone: true }
  for (const [f, s] of Object.entries(fresh)) {
    const old = snap[f]
    out[f] = {
      ...s,
      // a file deleted since the last scan keeps its old mtime, so its label stays current
      ...(s.gone && old ? { mtimeMs: old.mtimeMs } : {}),
      // its transcript was cleaned up: keep the status worked out while it was there
      ...(!s.seen && old?.seen ? { auto: old.auto, seen: true } : {}),
      ...(old?.label ? { label: old.label, labelMtime: old.labelMtime } : {}),
    }
  }
  return out
}

export const STATUS_TEXT: Record<Status, string> = { done: '● done', pending: '○ pending', cancelled: '● cancelled' }
const COLOR: Record<Status, string> = { done: 'success', pending: 'warning', cancelled: 'error' }
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DATE_W = 6
const STATUS_W = 11
const GONE = ' (file gone)'

// ponytail: month and day only; add the year once the timeline spans one
const day = (ts: number) => {
  const d = new Date(ts)
  return `${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, '0')}`
}

const widths = (cols: number) => {
  const room = Math.max(8, cols - DATE_W - STATUS_W - 6)
  const title = Math.ceil(room * 0.55)
  return { title, module: room - title }
}

export type Seg = { text: string; dim: boolean }

export function formatRow(r: Row, cols: number): Seg[] {
  const w = widths(cols)
  const tag = r.gone ? GONE : ''
  const title = cut(r.title, Math.max(1, w.title - len(tag)))
  return [
    { text: pad(day(r.ts), DATE_W) + '  ', dim: true },
    { text: title, dim: false },
    { text: tag, dim: true },
    { text: ' '.repeat(Math.max(0, w.title - len(title) - len(tag))) + '  ' + pad(cut(r.module, w.module), w.module) + '  ', dim: false },
    { text: STATUS_TEXT[r.status], dim: false },
  ].filter(s => s.text !== '')
}

export function header(cols: number) {
  const w = widths(cols)
  return pad('Date', DATE_W) + '  ' + pad('Plan', w.title) + '  ' + pad('Module / feature', w.module) + '  Status'
}

// Exact filename first, then a case-insensitive substring of filename or title.
export function match(snap: Record<string, Snap>, name: string) {
  const files = Object.keys(snap)
  const exact = files.filter(f => f === name || f === `${name}.md`)
  if (exact.length) return exact
  const q = name.toLowerCase()
  return files.filter(f => f.toLowerCase().includes(q) || snap[f]!.title.toLowerCase().includes(q))
}

const VERBS: Record<string, Status | null> = { done: 'done', pending: 'pending', cancel: 'cancelled', auto: null }
const USAGE =
  '/plans opens the pane · /plans done|pending|cancel <name> sets a status by hand · /plans auto <name> goes back to the derived status'

let home: Promise<string> | undefined
const plansDir = async ($: EngineInterface) => {
  home ??= $.process.run(['printenv', 'HOME']).then(r => r.stdout.trim())
  return `${await home}/.claude/plans`
}

// every read-modify-write of the store goes through here, so a scan and a label never undo each other
let queue: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn)
  queue = run.catch(() => undefined)
  return run
}
const getSnap = async ($: EngineInterface) => ((await $.store.get('rows')) ?? {}) as Record<string, Snap>
const getOverrides = async ($: EngineInterface) => ((await $.store.get('overrides')) ?? {}) as Record<string, Status>

// A plan is this project's when it was made in the session's folder or one inside it.
// ponytail: a session started in a subfolder misses plans made at the root; match on git toplevel if that bites
export function inProject(s: Snap, cwd: string) {
  if (!s.cwd) return s.project === base(cwd)
  return s.cwd === cwd || s.cwd.startsWith(`${cwd}/`)
}

// the store keeps every project's plans; the pane, labels and commands see this project's
async function projectSnap($: EngineInterface) {
  const cwd = await $.session.cwd()
  return Object.fromEntries(Object.entries(await getSnap($)).filter(([, s]) => inProject(s, cwd)))
}

async function publish($: EngineInterface) {
  const snap = await projectSnap($)
  const ov = await getOverrides($)
  const list: Row[] = Object.entries(snap)
    .map(([file, s]) => ({
      file,
      title: s.title,
      module: s.label ?? '…',
      ts: s.ts,
      status: ov[file] ?? s.auto,
      gone: s.gone === true,
    }))
    .sort((a, b) => b.ts - a.ts)
  await update($, rows, () => list)
}

async function readEvents($: EngineInterface, projects: string) {
  const evs: Ev[] = []
  let buf = ''
  const take = (text: string) => {
    for (const line of text.split('\n')) if (line) evs.push(...parseLine(line))
  }
  // transcripts outgrow $.fs.read's 4 MiB cap, so perl streams just the lines that matter
  // (perl, not grep: the system grep takes ~10x longer on long JSON lines)
  const filter = $.process.spawn({ argv: ['perl', '-MFile::Find', '-e', FILTER, PATTERN, projects] })
  for await (const { stream, text } of filter) {
    if (stream !== 'stdout') continue
    buf += text
    const nl = buf.lastIndexOf('\n')
    if (nl < 0) continue
    take(buf.slice(0, nl))
    buf = buf.slice(nl + 1)
  }
  take(buf)
  return evs
}

// ponytail: full rescan each time (~1.3 s over 225 MB); per-transcript mtime cache if it gets slow
let isScanning = false
async function scan($: EngineInterface) {
  if (isScanning) return
  isScanning = true
  await update($, scanning, () => true)
  try {
    const dir = await plansDir($)
    const entries = await $.fs.list(dir).catch(() => [])
    const plans = await Promise.all(
      entries
        .filter(e => e.kind === 'file' && e.name.endsWith('.md') && !e.name.includes('-agent-'))
        .map(async e => ({
          file: e.name,
          mtimeMs: e.mtimeMs,
          title: titleOf(await $.fs.read(`${dir}/${e.name}`).then(t => (typeof t === 'string' ? t : ''), () => ''), e.name),
        })),
    )
    const evs = await readEvents($, dir.replace(/plans$/, 'projects'))
    const fresh = derive(evs, plans)
    await serial(async () => $.store.set('rows', merge(await getSnap($), fresh)))
    await publish($)
  } finally {
    isScanning = false
    await update($, scanning, () => false)
  }
  void labelAll($)
}

async function askLabel($: EngineInterface, title: string, text: string) {
  try {
    const reply = await $.model.complete({
      model: LABEL_MODEL,
      system: LABEL_SYSTEM,
      prompt: `${title}\n\n${text.slice(0, 3000)}`,
      maxTokens: 30,
      timeoutMs: 30_000,
    })
    if (!reply.isAnswered) return undefined
    return cut(reply.text.split('\n')[0]!.replace(/["'`.*]/g, '').trim(), 40) || undefined
  } catch {
    return undefined
  }
}

// Labels plans one at a time, newest first, redrawing after each; a failed plan waits for the next session.
let isLabeling = false
const failed = new Set<string>()
async function labelAll($: EngineInterface) {
  if (isLabeling) return
  isLabeling = true
  try {
    for (;;) {
      const snap = await projectSnap($)
      const file = Object.keys(snap)
        .filter(f => snap[f]!.labelMtime !== snap[f]!.mtimeMs && !failed.has(f))
        .sort((a, b) => snap[b]!.ts - snap[a]!.ts)[0]
      if (!file) return
      const s = snap[file]!
      const text = s.gone ? '' : await $.fs.read(`${await plansDir($)}/${file}`).then(t => (typeof t === 'string' ? t : ''), () => '')
      const label = await askLabel($, s.title, text)
      if (!label) {
        failed.add(file)
        continue
      }
      await serial(async () => {
        const now = await getSnap($)
        if (now[file]) await $.store.set('rows', { ...now, [file]: { ...now[file], label, labelMtime: now[file].mtimeMs } })
      })
      await publish($)
    }
  } finally {
    isLabeling = false
  }
}

// ponytail: module flag, so after a hot reload the pane only rescans once /plans runs again
let isOpen = false

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'plans',
      description: "Timeline of this project's plan files, with their status",
      argumentHint: '[done|pending|cancel|auto <name>]',
    })
    await publish($)
    return next(e)
  })

  on('command.run', { command: 'plans' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    const name = rest.join(' ')
    if (verb === '') {
      isOpen = true
      await $.ui.open({ id: PANE, title: TITLE })
      await scan($)
      return { text: 'Plans pane opened.' }
    }
    if (!(verb in VERBS) || !name) return { text: USAGE }
    const status = VERBS[verb]!
    const snap = await projectSnap($)
    const hits = match(snap, name)
    if (hits.length === 0) return { text: `No plan matches "${name}".` }
    if (hits.length > 1) return { text: `"${name}" matches ${hits.length} plans: ${hits.slice(0, 8).join(', ')}` }
    const file = hits[0]!
    await serial(async () => {
      const { [file]: _, ...ov } = await getOverrides($)
      await $.store.set('overrides', status ? { ...ov, [file]: status } : ov)
    })
    await publish($)
    return { text: `${snap[file]!.title}: ${status ?? `back to ${snap[file]!.auto}`}` }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) isOpen = false
    return next(e)
  })

  // a finished turn may have submitted, answered or committed a plan; the transcript is flushed by now
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (isOpen && !e.agentId) void scan($)
    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, rows)
    const isBusy = await read($, scanning)
    if (list === null) return <Text dimColor>Scanning plans…</Text>
    const count = (s: Status) => list.filter(r => r.status === s).length
    const cols = e.props.bodyColumns
    const project = base(await $.session.cwd())
    return (
      <Box flexDirection="column">
        <Text bold>
          {TITLE} · {project}{' '}
          <Text dimColor>
            {count('done')} done · {count('pending')} pending · {count('cancelled')} cancelled
            {isBusy ? ' · scanning…' : ''}
          </Text>
        </Text>
        {list.length === 0 && <Text dimColor>No plans for this project yet.</Text>}
        {list.length > 0 && (
          <Text mono dimColor>
            {header(cols)}
          </Text>
        )}
        {list.map(r => (
          <Text mono>
            {formatRow(r, cols).map(s => (
              <Text color={COLOR[r.status]} dimColor={s.dim}>
                {s.text}
              </Text>
            ))}
          </Text>
        ))}
      </Box>
    )
  })
}
