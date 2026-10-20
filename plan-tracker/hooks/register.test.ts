import { expect, mock, test } from 'claude-code/testing'

import { derive, formatRow, inProject, match, merge, parseLine } from './register'
import type { Plan } from './register'
import type { Snap } from '../types'

const DIR = '/home/u/.claude/plans/'
const at = (min: number) => new Date(Date.UTC(2026, 9, 1, 0, min)).toISOString()
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
const ok = (s: string, min: number, id: string) => res(s, min, id, 'User has approved your plan. You can now start coding.')
const REJECTED = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file)."
const no = (s: string, min: number, id: string) => res(s, min, id, `${REJECTED} STOP what you are doing and wait.`, true)
const feedback = (s: string, min: number, id: string) =>
  res(s, min, id, `${REJECTED} To tell you how to proceed, the user said:\ncheck gap`, true)

const LINES = [
  // approved, then a commit: done
  submit('s1', 1, 'u1', 'a.md'), ok('s1', 2, 'u1'), commit('s1', 3, 'c1'),
  // b approved but the commit lands after c is submitted in the same session: b pending, c done
  submit('s1', 4, 'u2', 'b.md'), ok('s1', 5, 'u2'),
  submit('s1', 6, 'u3', 'c.md'), ok('s1', 7, 'u3'), commit('s1', 8, 'c2'),
  // rejected with feedback, then a commit: done
  submit('s2', 1, 'u4', 'd.md'), feedback('s2', 2, 'u4'), commit('s2', 3, 'c3'),
  // rejected with feedback, nothing after: pending
  submit('s3', 1, 'u5', 'e.md'), feedback('s3', 2, 'u5'),
  // a command that only mentions a commit is not one
  use('s3', 3, 'c8', 'Bash', { command: "grep -c 'git commit' x.jsonl" }),
  use('s3', 4, 'c9', 'Bash', { command: 'python3 -c "if \\"git commit\\" in s: pass"' }),
  // plain reject: cancelled
  submit('s4', 1, 'u6', 'f.md'), no('s4', 2, 'u6'),
  // rejected, then resubmitted and approved and committed: the last answer counts
  submit('s5', 1, 'u7', 'g.md'), no('s5', 2, 'u7'), submit('s5', 3, 'u8', 'g.md'), ok('s5', 4, 'u8'), commit('s5', 5, 'c4'),
  // written, never submitted
  use('s6', 1, 'w1', 'Write', { file_path: DIR + 'h.md', content: '# h' }, { cwd: '/work/notes' }),
  // commit before the approval does not count
  commit('s7', 1, 'c5'), submit('s7', 2, 'u9', 'i.md'), ok('s7', 3, 'u9'),
  // a failed commit does not count
  submit('s8', 1, 'u10', 'j.md'), ok('s8', 2, 'u10'), commit('s8', 3, 'c6'), res('s8', 4, 'c6', 'nothing to commit', true),
  // a tool_use_error answers nothing
  submit('s9', 1, 'u11', 'k.md'), res('s9', 2, 'u11', '<tool_use_error>You are not in plan mode</tool_use_error>', true),
  // file deleted, submit still in a transcript: comes back as a gone row
  submit('s10', 1, 'u12', 'z.md'), ok('s10', 2, 'u12'), commit('s10', 3, 'c7'),
  // subagent and sidechain plans are skipped
  submit('s11', 1, 'u13', 'x-agent-abc.md'), submit('s11', 2, 'u14', 'y.md', { isSidechain: true }),
  'not json',
]

const PLANS: Plan[] = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'].map(n => ({
  file: `${n}.md`,
  title: `${n} title`,
  mtimeMs: 5,
}))

test('derive: status rules', () => {
  const out = derive(LINES.flatMap(parseLine), PLANS)
  const auto = Object.fromEntries(Object.entries(out).map(([f, s]) => [f.replace('.md', ''), s.auto]))
  expect(auto).toEqual({
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
    z: 'done',
  })
  expect(out['a.md']?.project).toBe('shop')
  expect(out['h.md']?.project).toBe('notes')
  expect(out['a.md']?.ts).toBe(Date.parse(at(1)))
  expect(out['z.md']).toEqual(expect.objectContaining({ gone: true, title: 'z.md title' }))
  expect(out['a.md']?.gone).toBeUndefined()
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
})

test('formatRow: fixed columns, cut titles, gone tag', () => {
  const row = { file: 'a.md', title: 'A very long plan title that will not fit', module: 'shop · Auth', ts: new Date(2026, 9, 19).getTime(), status: 'cancelled' as const, gone: false }
  const line = (r: typeof row, cols: number) => formatRow(r, cols).map(s => s.text).join('')
  expect(line(row, 60)).toHaveLength(60)
  expect(line(row, 60)).toMatch(/^Oct 19  A very long plan tit…  shop · Auth\s+● cancelled$/)
  const gone = formatRow({ ...row, gone: true }, 60)
  expect(gone.find(s => s.text === ' (file gone)')?.dim).toBe(true)
  expect(line({ ...row, status: 'done' as never }, 60)).toMatch(/● done$/)
})

test('match: exact filename first, then substring of name or title', () => {
  const snap = { 'serene-crab.md': { title: 'Domain migration' }, 'crab-cake.md': { title: 'Other' } } as unknown as Record<string, Snap>
  expect(match(snap, 'serene-crab')).toEqual(['serene-crab.md'])
  expect(match(snap, 'crab')).toHaveLength(2)
  expect(match(snap, 'DOMAIN')).toEqual(['serene-crab.md'])
  expect(match(snap, 'nope')).toEqual([])
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

const run = (args: string) =>
  ({ command: 'plans', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } }) as const

test('/plans scans, draws status rows, overrides by hand', async ($, on) => {
  mock.store(on)
  on('session.cwd', () => ({ value: '/work/shop' }))
  let spawned: readonly string[] = []
  on('process.run', () => ({ value: { exitCode: 0, stdout: '/home/u\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.list', () => ({ value: PLANS.map(p => ({ name: p.file, kind: 'file' as const, size: 1, mtimeMs: 5, isLink: false })) }))
  on('fs.read', ($, e) => ({ value: `# Plan: ${e.path.split('/').pop()!.replace('.md', '')} plan\n\nbody` }))
  on('process.spawn', async function* ($, e) {
    spawned = e.argv
    // split mid-line, as a pipe would
    const text = LINES.join('\n') + '\n'
    yield { stream: 'stdout' as const, text: text.slice(0, 101) }
    yield { stream: 'stdout' as const, text: text.slice(101) }
    return { value: { code: 0, signal: null } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('model.complete', () => ({
    value: {
      isAnswered: true,
      text: 'Login flow',
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }))

  const opened = await $.command.run(run(''))
  expect(opened.text).toMatch(/opened/)
  expect(spawned[0]).toBe('perl')
  expect(spawned[spawned.length - 1]).toBe('/home/u/.claude/projects')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /Plans · shop/ })).toBeDefined()
    expect(await ui.find({ text: /5 done · 5 pending · 1 cancelled/ })).toBeDefined()
    expect(await ui.find({ text: /^a plan$/ })).toBeDefined()
    // h.md was made in /work/notes, another project
    expect(await ui.find({ text: /^h plan$/ })).toBeUndefined()
    expect(await ui.find({ text: /Login flow/ })).toBeDefined()
    expect(await ui.find({ text: /\(file gone\)/ })).toBeDefined()
    expect(await ui.find({ text: /● cancelled/ })).toBeDefined()
    await ui.unmount()
  }

  expect((await $.command.run(run('cancel a.md'))).text).toMatch(/a plan: cancelled/)
  expect((await $.command.run(run('done nope'))).text).toMatch(/No plan matches/)
  expect((await $.command.run(run('done h.md'))).text).toMatch(/No plan matches/)
  expect((await $.command.run(run('wat'))).text).toMatch(/\/plans opens/)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ text: /4 done · 5 pending · 2 cancelled/ })).toBeDefined()
  expect((await $.command.run(run('auto a'))).text).toMatch(/a plan: back to done/)
  expect(await ui.find({ text: /5 done · 5 pending · 1 cancelled/ })).toBeDefined()
  await ui.unmount()
})
