export type Recs = { tree: string; text: string }

declare module 'claude-code' {
  interface PluginState {
    'project-feature-tree': { tree: string | null; busy: boolean; scanning: string | null }
  }
}
