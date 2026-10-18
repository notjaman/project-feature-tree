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
// id of the background scan agent while it runs
const scanning = atom({ plugin: 'project-feature-tree', key: 'scanning' } as const, null)

const SCAN_PROMPT = `Scan this project's codebase and record its modules and features in ${FILE} at the project root.

Format, exactly:
# <project name>
- <Module>
  - [x] <feature that is built>
  - [ ] <feature that is stubbed, TODO or half-done>

Name modules and features the way a user would describe them: plain words, 2-5 each, no library or framework names, routes, file paths, env vars or notes in brackets. Write "Post reactions", not "Post reactions via Supabase RPC (rate-limited)".
Modules are top-level bullets, features nested under them (2-space indent).
If ${FILE} already exists, update it in place: keep every module, feature and "[ ]" planned item; shorten any name that breaks the naming rule above without changing its meaning or its [x]/[ ] mark; add newly found modules/features and tick "[x]" what is now finished. Remove nothing.`

const UPKEEP = {
  id: 'project-feature-tree:upkeep',
  scope: 'session',
  text: `This project tracks its modules and features in ${FILE} (nested bullets, "- [x]" built, "- [ ]" planned). When you finish building a feature, tick it or add it under its module in ${FILE}, named in 2-5 plain words with no technical detail.`,
} as const

const REC_SYSTEM = `You review a software project's feature tree (modules with their features; [x] built, [ ] planned).
Reply in terse Markdown with two sections:
## Missing
Per module, features a module like it usually needs that the tree lacks.
## Next
The 3-5 features to build next, ranked, one line each with a short why.
Name features in plain words a user would use, no technical detail.
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

export type Seg = { text: string; color?: string; dim: boolean }

// theme keys, so each module's color follows the person's light/dark theme
const PALETTE = ['claude', 'suggestion', 'success', 'warning', 'permission', 'ide']
// ponytail: cards are one width and labels are cut to it; wrap long labels if names get cut too often
const CARD_MAX = 30
const CARD_GAP = 2
// box-drawing joint by which sides it connects: up, down, left, right
const JOINTS: Record<string, string> = {
  '1100': '│', '0011': '─', '1011': '┴', '0111': '┬', '1111': '┼', '0101': '┌',
  '0110': '┐', '1001': '└', '1010': '┘', '1101': '├', '1110': '┤',
}

const len = (s: string) => [...s].length
const cut = (s: string, max: number) => (len(s) > max ? [...s].slice(0, Math.max(0, max - 1)).join('') + '…' : s)
const mark = (n: Node) => (n.children.length ? '' : n.done ? '✓ ' : '○ ')

// Org chart that fits `cols`: the project box on top, joined to a row of module boxes;
// each module's features hang under it as a card, and cards wrap into more rows.
export function chart(title: string, nodes: Node[], cols: number) {
  const cards = nodes.map((m, i) => {
    const feats = m.children.length ? leaves(m.children) : []
    const name = feats.length ? `${m.text} ${feats.filter(f => f.done).length}/${feats.length}` : m.text
    return { name, color: PALETTE[i % PALETTE.length]!, lines: rows(m.children) }
  })
  const need = Math.max(
    ...cards.flatMap(c => [len(c.name) + 4, ...c.lines.map(l => 2 + len(l.glyphs) + len(mark(l.node) + l.node.text))]),
  )
  const cardW = Math.max(5, Math.min(need, CARD_MAX, cols))
  const perRow = Math.max(1, Math.min(cards.length, Math.floor((cols + CARD_GAP) / (cardW + CARD_GAP))))
  const width = perRow * cardW + (perRow - 1) * CARD_GAP

  const cells: { ch: string; color?: string; dim: boolean }[][] = []
  const put = (x: number, y: number, ch: string, color?: string, dim = false) => {
    while (cells.length <= y) cells.push(Array.from({ length: width }, () => ({ ch: ' ', dim: false })))
    cells[y]![x] = { ch, color, dim }
  }
  const text = (x: number, y: number, s: string, color?: string, dim = false) =>
    [...s].forEach((ch, i) => put(x + i, y, ch, color, dim))
  // 3-row box at (x, y) with optional joints on its top and bottom edges
  const box = (x: number, y: number, label: string, color?: string, up?: number, down?: number) => {
    const w = len(label) + 4
    text(x, y, '┌' + '─'.repeat(w - 2) + '┐', color)
    text(x, y + 1, `│ ${label} │`, color)
    text(x, y + 2, '└' + '─'.repeat(w - 2) + '┘', color)
    if (up !== undefined) put(up, y, '┴', color)
    if (down !== undefined) put(down, y + 2, '┬', color)
  }

  // the first row's stems are what the project box joins
  const stems = cards.slice(0, perRow).map((_, i) => i * (cardW + CARD_GAP) + 2)
  const rootLabel = cut(title, width - 4)
  const rootW = len(rootLabel) + 4
  const mid = Math.floor((stems[0]! + stems[stems.length - 1]!) / 2)
  const rootX = Math.min(Math.max(mid - Math.floor(rootW / 2), 0), width - rootW)
  const rootC = rootX + Math.floor(rootW / 2)
  box(rootX, 0, rootLabel, undefined, undefined, rootC)
  const lo = Math.min(rootC, ...stems)
  const hi = Math.max(rootC, ...stems)
  for (let col = lo; col <= hi; col++) {
    put(col, 3, JOINTS[[col === rootC, stems.includes(col), col > lo, col < hi].map(Number).join('')] ?? '─')
  }

  // ponytail: rows after the first are not joined back to the project box; draw a trunk if that reads wrong
  let y = 4
  for (let r = 0; r * perRow < cards.length; r++) {
    const row = cards.slice(r * perRow, (r + 1) * perRow)
    row.forEach((c, i) => {
      const x = i * (cardW + CARD_GAP)
      box(x, y, cut(c.name, cardW - 4), c.color, r === 0 ? x + 2 : undefined, c.lines.length ? x + 2 : undefined)
      c.lines.forEach(({ glyphs, node }, j) => {
        const ly = y + 3 + j
        const room = cardW - 2 - len(glyphs)
        text(x + 2, ly, glyphs, c.color)
        if (node.children.length) text(x + 2 + len(glyphs), ly, cut(node.text, room))
        else if (node.done) {
          text(x + 2 + len(glyphs), ly, '✓', c.color)
          text(x + 4 + len(glyphs), ly, cut(node.text, room - 2))
        } else text(x + 2 + len(glyphs), ly, cut('○ ' + node.text, room), undefined, true)
      })
    })
    y += 3 + Math.max(...row.map(c => c.lines.length)) + 1
  }

  // runs of same-styled cells become one Seg
  return {
    width,
    rows: cells.map(row =>
      row.reduce<Seg[]>((segs, c) => {
        const last = segs[segs.length - 1]
        if (last && last.color === c.color && last.dim === c.dim) last.text += c.ch
        else segs.push({ text: c.ch, color: c.color, dim: c.dim })
        return segs
      }, []),
    ),
  }
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
      // a subagent, not $.prompt.submit: runs in the background, no prompt shown, main context untouched
      const run = await $.agent.spawn({
        prompt: SCAN_PROMPT,
        description: `Scan features into ${FILE}`,
        subagentType: 'general-purpose',
      })
      if (run.deny) return { text: `Feature scan refused: ${run.deny}` }
      await update($, scanning, () => run.agentId ?? null)
      await $.ui.open({ id: PANE, title: TITLE })
      return { text: 'Feature scan running in the background.' }
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
    if (e.agentId && e.agentId === (await read($, scanning))) {
      await update($, scanning, () => null)
      $.ui.toast(`${FILE} updated`)
    }

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
    const isScanning = (await read($, scanning)) !== null
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
        {isScanning && <Text dimColor>Scanning the codebase in the background…</Text>}
        {!isScanning && text === null && <Text dimColor>No {FILE} in this project yet. Run /feature-tree scan.</Text>}
        {text !== null && nodes.length === 0 && (
          <Text dimColor>{FILE} has no bullets yet. Run /feature-tree scan.</Text>
        )}
        {nodes.length > 0 &&
          chart(title, nodes, e.props.bodyColumns).rows.map(segs => (
            <Text mono>
              {segs.map(s => (
                <Text {...(s.color ? { color: s.color } : {})} dimColor={s.dim}>
                  {s.text}
                </Text>
              ))}
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
