import { expect, mock, test } from 'claude-code/testing'

import { parseTree } from './register'

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

test('commands: open loads tree, analyze shows recs, scan queues prompt', async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on)
  let submitted = ''
  on('session.cwd', () => ({ value: '/work/shop' }))
  on('fs.read', () => ({ value: MD }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('prompt.submit', ($, e) => {
    submitted = e.text
    return { text: e.text }
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

  await $.command.run(run('scan'))
  await clock.advance(1)
  expect(submitted).toMatch(/FEATURES\.md/)
})
