export type ProcNode = {
  pid: number
  ppid: number
  rssKb: number
  cpu: number
  etime: string
  command: string
  /** Box-drawing prefix that places the row in the tree ('' for the root). */
  prefix: string
}

export type ProcSnapshot = {
  rootPid: number
  takenAt: number
  nodes: ProcNode[]
  totalRssKb: number
  /** Sum of the tree's %cpu, where one busy core is 100. */
  totalCpu: number
  /** Cores online on the machine; null when getconf gave none. */
  cores: number | null
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    proctree: {
      snapshot: ProcSnapshot | null
      peakRssKb: number
      isPaused: boolean
      showFullCommand: boolean
    }
  }
}
