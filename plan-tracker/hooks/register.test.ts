import { expect, mock, test } from 'claude-code/testing'

import { boxes, derive, formatRow, inProject, merge, parseLine, pathsOf } from './register'
import type { Plan } from './register'
import type { Snap } from '../types'

const DIR = '/home/u/.claude/plans/'
const at = (min: number) => new Date(Date.UTC(2026, 9, 1, 0, min)).toISOString()
// a day after the fixtures, and well past the 7-day idle window
const SOON = Date.UTC(2026, 9, 2)
const LATE = Date.UTC(2026, 9, 20)
const use = (session: string, min: number, id: string, name: string, input: object, extra: object = {}) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: at(min),
    cwd: '/work/shop',
    sessionId: session,
    ...extra,
    message: { content: [{ type: 'tool_use', id, name, input }] },
  })
const res = (session: string, min: number, id: string, content: string, isError = false) =>
  JSON.stringify({
    type: 'user',
    timestamp: at(min),
    sessionId: session,
    message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] },
  })
const submit = (s: string, min: number, id: string, file: string, extra: object = {}) =>
  use(s, min, id, 'ExitPlanMode', { plan: `# Plan: ${file} title\n\nbody`, planFilePath: DIR + file }, extra)
const commit = (s: string, min: number, id: string) => use(s, min, id, 'Bash', { command: 'git add . && git commit -m x' })
const edit = (s: string, min: number, id: string, path: string) => use(s, min, id, 'Edit', { file_path: path, old_string: 'a', new_string: 'b' })
const ok = (s: string, min: number, id: string) => res(s, min, id, 'User has approved your plan. You can now start coding.')
const REJECTED = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file)."
const no = (s: string, min: number, id: string) => res(s, min, id, `${REJECTED} STOP what you are doing and wait.`, true)
const feedback = (s: string, min: number, id: string) =>
  res(s, min, id, `${REJECTED} To tell you how to proceed, the user said:\ncheck gap`, true)

const LINES = [
  // approved, then a commit: done
  submit('s1', 1, 'u1', 'a.md'), ok('s1', 2, 'u1'), commit('s1', 3, 'c1'),
  // b approved, but the commit lands after c is submitted in the same session: b needs a check, c done
  submit('s1', 4, 'u2', 'b.md'), ok('s1', 5, 'u2'),
  submit('s1', 6, 'u3', 'c.md'), ok('s1', 7, 'u3'), commit('s1', 8, 'c2'),
  // rejected with feedback, then a commit: done
  submit('s2', 1, 'u4', 'd.md'), feedback('s2', 2, 'u4'), commit('s2', 3, 'c3'),
  // rejected with feedback, nothing after (commands that only mention a commit are not one): check
  submit('s3', 1, 'u5', 'e.md'), feedback('s3', 2, 'u5'),
  use('s3', 3, 'c8', 'Bash', { command: "grep -c 'git commit' x.jsonl" }),
  use('s3', 4, 'c9', 'Bash', { command: 'python3 -c "if \\"git commit\\" in s: pass"' }),
  // plain reject: cancelled
  submit('s4', 1, 'u6', 'f.md'), no('s4', 2, 'u6'),
  // rejected, then resubmitted, approved and committed: the last answer counts
  submit('s5', 1, 'u7', 'g.md'), no('s5', 2, 'u7'), submit('s5', 3, 'u8', 'g.md'), ok('s5', 4, 'u8'), commit('s5', 5, 'c4'),
  // written, never submitted
  use('s6', 1, 'w1', 'Write', { file_path: DIR + 'h.md', content: '# h' }, { cwd: '/work/notes' }),
  // a commit before the approval does not count
  commit('s7', 1, 'c5'), submit('s7', 2, 'u9', 'i.md'), ok('s7', 3, 'u9'),
  // a failed commit does not count
  submit('s8', 1, 'u10', 'j.md'), ok('s8', 2, 'u10'), commit('s8', 3, 'c6'), res('s8', 4, 'c6', 'nothing to commit', true),
  // a tool_use_error answers nothing
  submit('s9', 1, 'u11', 'k.md'), res('s9', 2, 'u11', '<tool_use_error>You are not in plan mode</tool_use_error>', true),
  // approved, then Claude edits a project file: done
  submit('s12', 1, 'u15', 'm.md'), ok('s12', 2, 'u15'), edit('s12', 3, 'e1', '/work/shop/src/m.ts'),
  // approved, then only Claude's own config is edited: check
  submit('s13', 1, 'u16', 'n.md'), ok('s13', 2, 'u16'), edit('s13', 3, 'e2', '/home/u/.claude/settings.json'),
  // file deleted, submit still in a transcript: comes back as a gone row
  submit('s10', 1, 'u12', 'z.md'), ok('s10', 2, 'u12'), commit('s10', 3, 'c7'),
  // subagent and sidechain plans are skipped
  submit('s11', 1, 'u13', 'x-agent-abc.md'), submit('s11', 2, 'u14', 'y.md', { isSidechain: true }),
  'not json',
]

const PLANS: Plan[] = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'm', 'n'].map(n => ({
  file: `${n}.md`,
  title: `${n} title`,
  // older than every fixture, so it never counts as recent activity
  mtimeMs: 5,
}))

const autos = (rows: Record<string, Snap>) =>
  Object.fromEntries(Object.entries(rows).map(([f, s]) => [f.replace('.md', ''), s.auto]))

test('derive: status rules', () => {
  const { rows, checks } = derive(LINES.flatMap(parseLine), PLANS, SOON)
  expect(autos(rows)).toEqual({
    a: 'done',
    b: 'pending',
    c: 'done',
    d: 'done',
    e: 'pending',
    f: 'cancelled',
    g: 'done',
    h: 'pending',
    i: 'pending',
    j: 'pending',
    k: 'pending',
    m: 'done',
    n: 'pending',
    z: 'done',
  })
  // answered plans with no work in their session go on to git and the model
  expect(Object.keys(checks).sort()).toEqual(['b.md', 'e.md', 'i.md', 'j.md', 'n.md'])
  expect(checks['b.md']).toEqual({ since: Date.parse(at(5)), approved: true, last: Date.parse(at(5)) })
  expect(checks['e.md']?.approved).toBe(false)
  expect(rows['a.md']?.project).toBe('shop')
  expect(rows['h.md']?.project).toBe('notes')
  expect(rows['a.md']?.ts).toBe(Date.parse(at(1)))
  expect(rows['z.md']).toEqual(expect.objectContaining({ gone: true, title: 'z.md title' }))
  expect(rows['a.md']?.gone).toBeUndefined()
})

test('derive: never submitted or never answered goes idle into cancelled', () => {
  const { rows } = derive(LINES.flatMap(parseLine), PLANS, LATE)
  expect(rows['h.md']?.auto).toBe('cancelled')
  expect(rows['k.md']?.auto).toBe('cancelled')
  // a recent edit to the plan file keeps it pending
  const fresh = PLANS.map(p => (p.file === 'h.md' ? { ...p, mtimeMs: LATE - 1000 } : p))
  expect(derive(LINES.flatMap(parseLine), fresh, LATE).rows['h.md']?.auto).toBe('pending')
})

test('pathsOf: backticked file paths as git pathspecs', () => {
  const md = 'Edit `src/app/page.tsx` and `README.md`, see `/work/shop/api/x.ts:12`; not `https://x.io/a`, `../up.ts`, `e.props.bodyColumns`, `--flag`, `~/.claude/x.md`'
  expect(pathsOf(md, '/work/shop')).toEqual([':(literal)src/app/page.tsx', ':(glob)**/README.md', ':(literal)api/x.ts'])
})

test('merge: stored rows outlive their files, labels carry over', () => {
  const snap: Record<string, Snap> = {
    'old.md': { title: 'Old', project: 'p', ts: 1, auto: 'done', mtimeMs: 3, label: 'Billing', labelMtime: 3 },
    'a.md': { title: 'A', project: 'p', ts: 2, auto: 'pending', mtimeMs: 5, label: 'Auth', labelMtime: 5 },
  }
  const out = merge(snap, { 'a.md': { title: 'A', project: 'p', ts: 2, auto: 'done', mtimeMs: 5 } })
  expect(out['old.md']).toEqual(expect.objectContaining({ gone: true, auto: 'done', label: 'Billing' }))
  expect(out['a.md']).toEqual(expect.objectContaining({ auto: 'done', label: 'Auth', labelMtime: 5 }))
  expect(out['a.md']?.gone).toBeUndefined()
  // deleted since the last scan, found again in a transcript: keeps its mtime so the label stays
  const gone = merge(snap, { 'a.md': { title: 'A', project: 'p', ts: 2, auto: 'done', mtimeMs: 0, gone: true } })
  expect(gone['a.md']?.mtimeMs).toBe(5)
  // file still there, its transcript cleaned up: the status worked out before stays
  const seen = { 'a.md': { ...snap['a.md']!, auto: 'done' as const, seen: true } }
  expect(merge(seen, { 'a.md': { title: 'A', project: 'p', ts: 2, auto: 'pending', mtimeMs: 5 } })['a.md']?.auto).toBe('done')
  expect(merge(seen, { 'a.md': { title: 'A', project: 'p', ts: 2, auto: 'pending', mtimeMs: 5, seen: true } })['a.md']?.auto).toBe('pending')
  // another project's folder plans are outside this scan: not marked gone
  const other = { '/work/blog/plan/x.md': { title: 'X', project: 'blog', cwd: '/work/blog', ts: 1, auto: 'done' as const, mtimeMs: 1 } }
  expect(merge(other, {}, k => k.startsWith('/work/shop/'))['/work/blog/plan/x.md']?.gone).toBeUndefined()
  expect(merge(other, {})['/work/blog/plan/x.md']?.gone).toBe(true)
})

test('boxes: ticked and open checkbox steps', () => {
  expect(boxes('# P\n- [x] a\n  - [X] b\n* [ ] c\n- not a box\n`- [ ]` in text')).toEqual({ ticked: 2, open: 1 })
  expect(boxes('# Overview')).toEqual({ ticked: 0, open: 0 })
})

test('formatRow: fixed columns, cut titles, gone tag', () => {
  const row = { file: 'a.md', title: 'A very long plan title that will not fit', module: 'Auth', ts: new Date(2026, 9, 19).getTime(), status: 'cancelled' as const, gone: false }
  const line = (r: typeof row, cols: number) => formatRow(r, cols).map(s => s.text).join('')
  expect(line(row, 60)).toHaveLength(60)
  expect(line(row, 60)).toMatch(/^Oct 19  A very long plan tit…  Auth\s+● cancelled$/)
  const gone = formatRow({ ...row, gone: true }, 60)
  expect(gone.find(s => s.text === ' (file gone)')?.dim).toBe(true)
  expect(line({ ...row, status: 'done' as never }, 60)).toMatch(/● done$/)
})

test('inProject: made in the session folder or one inside it', () => {
  const s = (cwd?: string) => ({ title: 't', project: 'shop', ts: 1, auto: 'done', mtimeMs: 1, ...(cwd ? { cwd } : {}) }) as Snap
  expect(inProject(s('/work/shop'), '/work/shop')).toBe(true)
  expect(inProject(s('/work/shop/api'), '/work/shop')).toBe(true)
  expect(inProject(s('/work/shopfront'), '/work/shop')).toBe(false)
  expect(inProject(s('/work'), '/work/shop')).toBe(false)
  // rows stored before cwd was kept fall back to the folder name
  expect(inProject(s(), '/other/shop')).toBe(true)
})

const PANE = {
  plugin: 'plan-tracker',
  component: 'Pane',
  requestId: 'plans',
  props: {
    title: 'Plans',
    isFocused: false,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const run = { command: 'plans', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const

const USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

test('/plans scans, settles answered plans through git and the model, draws status rows', async ($, on) => {
  mock.store(on)
  on('session.cwd', () => ({ value: '/work/shop' }))
  let spawned: readonly string[] = []
  const gitCalls: string[][] = []
  const asked: string[] = []
  on('process.run', ($, e) => {
    const out = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv[0] === 'printenv') return out('/home/u\n')
    gitCalls.push([...e.argv])
    // first added 2026-10-10 00:00 UTC
    if (e.argv.includes('--diff-filter=A')) return out('1791590400\n')
    // a later commit touched the file plan b names
    if (e.argv.includes(':(literal)src/b.ts')) return out('feat: b\n')
    return out(e.argv.includes('-n') ? 'chore: unrelated\n' : '')
  })
  const entry = (name: string, kind: 'file' | 'dir' = 'file') => ({ name, kind, size: 1, mtimeMs: 5, isLink: false })
  const TREE: Record<string, ReturnType<typeof entry>[]> = {
    '/home/u/.claude/plans': PLANS.map(p => entry(p.file)),
    '/work/shop': [entry('plan', 'dir'), entry('docs', 'dir'), entry('server', 'dir'), entry('README.md')],
    '/work/shop/plan': [entry('01-foundation.md'), entry('02-data.md'), entry('00-overview.md'), entry('notes.txt')],
    '/work/shop/docs': [entry('superpowers', 'dir')],
    '/work/shop/docs/superpowers': [entry('plans', 'dir')],
    '/work/shop/docs/superpowers/plans': [entry('2026-09-21-points.md')],
    // a code folder named plans outside docs/ is not a plan folder
    '/work/shop/server': [entry('api', 'dir')],
    '/work/shop/server/api': [entry('plans', 'dir')],
    '/work/shop/server/api/plans': [entry('route.md')],
  }
  on('fs.list', ($, e) => ({ value: TREE[e.path ?? ''] ?? [] }))
  const FOLDER: Record<string, string> = {
    '/work/shop/plan/01-foundation.md': '# 01 — Foundation\n- [x] repo\n- [x] deploy',
    '/work/shop/plan/02-data.md': '# 02 — Data model\n- [x] tables\n- [ ] seed',
    '/work/shop/plan/00-overview.md': '# 00 — Overview\n\nWhat the site is.',
    '/work/shop/docs/superpowers/plans/2026-09-21-points.md': '# Points system\n- [ ] ledger\n- [ ] badge',
  }
  on('fs.read', ($, e) => {
    const folder = FOLDER[e.path]
    if (folder) return { value: folder }
    const n = e.path.split('/').pop()!.replace('.md', '')
    return { value: `# Plan: ${n} plan\n\nbody${n === 'b' ? ' Touch `src/b.ts`.' : ''}` }
  })
  on('process.spawn', async function* ($, e) {
    spawned = e.argv
    // split mid-line, as a pipe would
    const text = LINES.join('\n') + '\n'
    yield { stream: 'stdout' as const, text: text.slice(0, 101) }
    yield { stream: 'stdout' as const, text: text.slice(101) }
    return { value: { code: 0, signal: null } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('model.complete', ($, e) => {
    const prompt = String(e.prompt)
    if (!String(e.system).includes('carried out')) return { value: { isAnswered: true, text: 'Login flow', usage: USAGE } }
    asked.push(prompt.split('\n')[1] ?? '?')
    const pending = prompt.includes('i plan') || prompt.includes('Overview')
    return { value: { isAnswered: true, text: pending ? 'PENDING' : 'DONE', usage: USAGE } }
  })

  expect((await $.command.run(run)).text).toMatch(/opened/)
  expect(spawned[0]).toBe('perl')
  expect(spawned[spawned.length - 1]).toBe('/home/u/.claude/projects')
  // git runs in the plan's own folder, from when it was answered
  expect(gitCalls[0]?.slice(0, 5)).toEqual(['git', '-C', '/work/shop', 'log', '--all'])
  // b settled by git; e is feedback, so it never reaches the model; folder plans with no ticks do
  expect([...asked].sort()).toEqual(['# 00 — Overview', '# Plan: i plan', '# Plan: j plan', '# Plan: n plan', '# Points system'])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /Plans · shop/ })).toBeDefined()
    // done: a b c d g j m n z, 01 (all ticked), points (model) · pending: i, 02 (part ticked), overview (model)
    // cancelled: e (idle feedback) f k (idle, no answer)
    expect(await ui.find({ text: /11 done · 3 pending · 3 cancelled/ })).toBeDefined()
    expect(await ui.find({ text: /^01 — Foundation$/ })).toBeDefined()
    expect(await ui.find({ text: /^Sep 21/ })).toBeDefined()
    expect(await ui.find({ text: /route/ })).toBeUndefined()
    expect(await ui.find({ text: /^a plan$/ })).toBeDefined()
    // h.md was made in /work/notes, another project
    expect(await ui.find({ text: /^h plan$/ })).toBeUndefined()
    expect(await ui.find({ text: /Login flow/ })).toBeDefined()
    expect(await ui.find({ text: /\(file gone\)/ })).toBeDefined()
    await ui.unmount()
  }

  // verdicts are cached until a new commit lands or the file changes
  await $.command.run(run)
  expect(asked).toHaveLength(5)
})
