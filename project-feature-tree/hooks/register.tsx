import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Recs } from '../types'

const PANE = 'feature-tree'
const TITLE = 'Feature tree'
// ponytail: project root = session cwd; resolve git toplevel if sessions start in subdirs
const FILE = 'FEATURES.md'
// ponytail: a const, not userConfig; make it an option if it needs changing per project
const REC_MODEL = 'claude-opus-5-5'

const tree = atom({ plugin: 'project-feature-tree', key: 'tree' } as const, null)
const busy = atom({ plugin: 'project-feature-tree', key: 'busy' } as const, false)

const SCAN_PROMPT = `Scan this project's codebase and record its modules and features in ${FILE} at the project root.

Format, exactly:
# <project name>
- <Module>
  - [x] <feature that is built>
  - [ ] <feature that is stubbed, TODO or half-done>

Modules are top-level bullets, features nested under them (2-space indent), one short line each.
If ${FILE} already exists, update it in place: keep every existing line, its wording and every "[ ]" planned item; only add newly found modules/features and tick "[x]" what is now finished. Do not change anything else.`

const UPKEEP = {
  id: 'project-feature-tree:upkeep',
  scope: 'session',
  text: `This project tracks its modules and features in ${FILE} (nested bullets, "- [x]" built, "- [ ]" planned). When you finish building a feature, tick it or add it under its module in ${FILE}.`,
} as const

const REC_SYSTEM = `You review a software project's feature tree (modules with their features; [x] built, [ ] planned).
Reply in terse Markdown with two sections:
## Missing
Per module, features a module like it usually needs that the tree lacks.
## Next
The 3-5 features to build next, ranked, one line each with a short why.
Never suggest anything already in the tree, built or planned.`

export type Node = { text: string; done: boolean; children: Node[] }

export function parseTree(md: string, fallback: string) {
  let title: string | undefined
  const root: Node = { text: '', done: true, children: [] }
  // root's indent -1 is below every bullet's, so the stack never empties
  const stack = [{ indent: -1, node: root }]
  const top = () => stack[stack.length - 1]!
  for (const line of md.split('\n')) {
    const heading = /^#\s+(.+)/.exec(line)?.[1]
    if (heading) {
      title ??= heading.trim()
      continue
    }
    const [, lead = '', box, label] = /^(\s*)[-*+]\s+(?:\[([ xX])\]\s+)?(.+)$/.exec(line) ?? []
    if (!label) continue
    const indent = lead.replace(/\t/g, '  ').length
    const node: Node = { text: label.trim(), done: box !== ' ', children: [] }
    while (top().indent >= indent) stack.pop()
    top().node.children.push(node)
    stack.push({ indent, node })
  }
  return { title: title ?? fallback, nodes: root.children }
}

function rows(nodes: Node[], prefix = ''): { glyphs: string; node: Node }[] {
  return nodes.flatMap((node, i) => {
    const isLast = i === nodes.length - 1
    return [
      { glyphs: prefix + (isLast ? '└─ ' : '├─ '), node },
      ...rows(node.children, prefix + (isLast ? '   ' : '│  ')),
    ]
  })
}

const leaves = (nodes: Node[]): Node[] =>
  nodes.flatMap(n => (n.children.length ? leaves(n.children) : [n]))

const recsKey = (cwd: string) => `recs:${cwd}`

async function load($: EngineInterface) {
  const text = await $.fs.read(FILE).then(
    t => (typeof t === 'string' ? t : null),
    () => null,
  )
  await update($, tree, () => text)
  return text
}

async function analyze($: EngineInterface, text: string) {
  await update($, busy, () => true)
  try {
    const reply = await $.model.complete({
      model: REC_MODEL,
      system: REC_SYSTEM,
      prompt: text,
      maxTokens: 1500,
      timeoutMs: 120_000,
    })
    if (!reply.isAnswered) return `Analyze failed: ${reply.reason}`
    const recs: Recs = { tree: text, text: reply.text }
    await $.store.set(recsKey(await $.session.cwd()), recs)
    return 'Recommendations updated in the Feature tree pane.'
  } finally {
    await update($, busy, () => false)
  }
}

const USAGE = '/feature-tree opens the pane · /feature-tree scan writes or updates FEATURES.md · /feature-tree analyze refreshes recommendations'

// ponytail: no cwd.change handling; reload on it if worktrees switch mid-session
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'feature-tree',
      description: "Show this project's feature tree and recommendations",
      argumentHint: '[scan|analyze]',
    })
    if ((await load($)) !== null) void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  on('command.run', { command: 'feature-tree' }, async ($, e) => {
    const sub = e.args.trim()
    if (sub === 'scan') {
      // deferred: the host refuses a submit from command.run, its turn would wait on this command
      $.clock.after(0, () => void $.prompt.submit({ text: SCAN_PROMPT }))
      return { text: 'Feature scan queued.' }
    }
    if (sub !== '' && sub !== 'analyze') return { text: USAGE }
    const text = await load($)
    await $.ui.open({ id: PANE, title: TITLE })
    if (sub === '') return { text: 'Feature tree pane opened.' }
    if (text === null || parseTree(text, '').nodes.length === 0)
      return { text: `No features in ${FILE} yet. Run /feature-tree scan first.` }

    return { text: await analyze($, text) }
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    await load($)

    return done
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if ((await read($, tree)) === null) return composed

    return { sections: [...composed.sections, UPKEEP] }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Markdown } = $.ui.resolve(e)
    const text = await read($, tree)
    const isBusy = await read($, busy)
    const cwd = await $.session.cwd()
    const recs = (await $.store.get(recsKey(cwd))) as Recs | undefined
    const { title, nodes } = parseTree(text ?? '', cwd.split('/').filter(Boolean).pop() ?? 'project')
    const features = leaves(nodes)
    const done = features.filter(f => f.done).length

    return (
      <Box flexDirection="column">
        <Text bold>
          {title} <Text dimColor>{done} done · {features.length - done} planned</Text>
        </Text>
        {text === null && <Text dimColor>No {FILE} in this project yet. Run /feature-tree scan.</Text>}
        {text !== null && nodes.length === 0 && (
          <Text dimColor>{FILE} has no bullets yet. Run /feature-tree scan.</Text>
        )}
        {rows(nodes).map(({ glyphs, node }) => (
          <Text mono>
            <Text dimColor>{glyphs}</Text>
            {node.children.length ? (
              <Text bold>{node.text}</Text>
            ) : node.done ? (
              <Text>
                <Text color="success">✓</Text> {node.text}
              </Text>
            ) : (
              <Text dimColor>○ {node.text}</Text>
            )}
          </Text>
        ))}
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Recommendations</Text>
          {isBusy && <Text dimColor>Analyzing…</Text>}
          {!isBusy && recs && <Markdown key="recs" text={recs.text} />}
          {!isBusy && nodes.length > 0 && (!recs || recs.tree !== text) && (
            <Text dimColor>{recs ? 'Stale: tree changed. ' : ''}Run /feature-tree analyze.</Text>
          )}
        </Box>
      </Box>
    )
  })
}
