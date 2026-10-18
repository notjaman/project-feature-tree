import { expect, mock, test } from 'claude-code/testing'

import { chart, parseTree } from './register'

const MD = `# Shop
- Auth
  - [x] Email login
  - [ ] Magic link
- Billing
  - Stripe checkout
`

const PANE = {
  plugin: 'project-feature-tree',
  component: 'Pane',
  requestId: 'feature-tree',
  props: {
    title: 'Feature tree',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

// what a person typing /feature-tree at the terminal raises
const run = (args: string) =>
  ({ command: 'feature-tree', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } }) as const

test('parseTree nests modules and features with status', () => {
  const { title, nodes } = parseTree(MD, 'dir')
  expect(title).toBe('Shop')
  expect(nodes.map(n => n.text)).toEqual(['Auth', 'Billing'])
  expect(nodes[0]?.children).toEqual([
    { text: 'Email login', done: true, children: [] },
    { text: 'Magic link', done: false, children: [] },
  ])
  expect(nodes[1]?.children[0]?.done).toBe(true)
  expect(parseTree('- A', 'dir').title).toBe('dir')
})

test('chart: module cards under the project, wrapping to the pane width', () => {
  const { nodes } = parseTree(MD, 'dir')
  const lines = (cols: number) => chart('Shop', nodes, cols).rows.map(r => r.map(s => s.text).join('').trimEnd())
  const wide = lines(60)
  expect(wide[1]).toBe(' '.repeat(10) + '│ Shop │')
  expect(wide[3]).toBe('  ┌' + '─'.repeat(11) + '┴' + '─'.repeat(11) + '┐')
  expect(wide[5]).toBe('│ Auth 1/2 │            │ Billing 1/1 │')
  expect(wide[8]).toBe('  └─ ○ Magic link')
  // too narrow for two cards side by side: Billing wraps under Auth
  expect(lines(30)).toContain('│ Billing 1/1 │')
  // each module has its own color; planned features are dimmed
  const { rows } = chart('Shop', nodes, 60)
  expect(rows[8]?.find(s => s.text.includes('Magic'))?.dim).toBe(true)
  expect(rows[7]?.find(s => s.text.includes('└─'))?.color).toBe('suggestion')
})

test('commands: open loads tree, analyze shows recs, scan spawns background agent', async ($, on) => {
  mock.store(on)
  let spawned = ''
  on('session.cwd', () => ({ value: '/work/shop' }))
  on('fs.read', () => ({ value: MD }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.spawn', ($, e) => {
    spawned = e.prompt
    return { model: 'test' }
  })
  on('model.complete', () => ({
    value: {
      isAnswered: true,
      text: '## Next\n- Password reset',
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    if (surface === 'terminal') {
      expect(await ui.find({ text: /No FEATURES\.md.*\/feature-tree scan/ })).toBeDefined()
      await $.command.run(run(''))
      expect(await ui.find({ text: /Magic link/ })).toBeDefined()
      expect(await ui.find({ text: /1 planned/ })).toBeDefined()
      expect(await ui.find({ text: /Run \/feature-tree analyze/ })).toBeDefined()
      const ran = await $.command.run(run('analyze'))
      expect(ran.text).toMatch(/updated/)
    }
    expect(await ui.find({ text: /Password reset/ })).toBeDefined()
    expect(await ui.find({ text: /Run \/feature-tree analyze/ })).toBeUndefined()
    await ui.unmount()
  }

  // the kit answers no agentId (core sets it), so the "Scanning" row is not reachable here
  const scan = await $.command.run(run('scan'))
  expect(scan.text).toMatch(/background/)
  expect(spawned).toMatch(/FEATURES\.md/)
})
