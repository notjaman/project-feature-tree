export type Status = 'done' | 'pending' | 'cancelled'

// one pane row, newest first
export type Row = { file: string; title: string; module: string; ts: number; status: Status; gone: boolean }

// what the store keeps per plan file, so a row outlives its deleted file
export type Snap = {
  title: string
  project: string
  // folder the plan was made in; absent on rows stored before it was kept
  cwd?: string
  ts: number
  auto: Status
  mtimeMs: number
  gone?: boolean
  label?: string
  labelMtime?: number
  // a transcript still logs a submit of this plan
  seen?: boolean
  // the model's done-or-not verdict, and what it was given (answer time and commits since)
  checkKey?: string
  checkDone?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'plan-tracker': { rows: Row[] | null; scanning: boolean }
  }
}
