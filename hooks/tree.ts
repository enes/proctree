import type { ProcNode, ProcSnapshot } from '../types'

type Row = Omit<ProcNode, 'prefix'>

// `sh -c` prints "<its parent> <itself> <cores>", then execs ps in its own
// place, so the ps row carries the sampler's pid and can be left out of the
// tree. `-A -ww -o` with these keywords and `getconf _NPROCESSORS_ONLN` read
// the same on macOS and Linux (procps); a getconf that fails leaves no count.
export const SAMPLE_SCRIPT =
  'echo "$PPID $$ $(getconf _NPROCESSORS_ONLN 2>/dev/null)"; ' +
  'exec ps -A -ww -o pid=,ppid=,rss=,pcpu=,etime=,args='

const ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.,]+)\s+(\S+)\s+(.*)$/

export function parsePs(stdout: string): {
  parentPid: number
  selfPid: number
  cores: number | null
  rows: Map<number, Row>
} {
  const [head = '', ...lines] = stdout.split('\n')
  const [parentPid = 0, selfPid = 0, count] = head.trim().split(/\s+/).map(Number)
  const cores = count !== undefined && count > 0 ? count : null
  const rows = new Map<number, Row>()

  for (const line of lines) {
    const m = ROW.exec(line)
    if (!m) continue
    const pid = Number(m[1])
    rows.set(pid, {
      pid,
      ppid: Number(m[2]),
      rssKb: Number(m[3]),
      cpu: Number((m[4] ?? '0').replace(',', '.')),
      etime: m[5] ?? '',
      command: m[6] ?? '',
    })
  }

  return { parentPid, selfPid, cores, rows }
}

function executable(command: string): string {
  const first = command.split(' ')[0] ?? command
  return first.slice(first.lastIndexOf('/') + 1)
}

// Claude Code as the native binary (argv[0] `claude`) or as the npm package
// run by node. Case-sensitive, so the desktop app (`Claude`) never matches.
export function isClaudeCode(command: string): boolean {
  return executable(command) === 'claude' || command.includes('@anthropic-ai/claude-code')
}

// The session is the nearest ancestor of the sampler that is Claude Code;
// the sampler's own parent when none is.
export function findRoot(rows: Map<number, Row>, parentPid: number): number {
  let pid = parentPid
  for (let hops = 0; hops < 4; hops++) {
    const row = rows.get(pid)
    if (!row) break
    if (isClaudeCode(row.command)) return pid
    pid = row.ppid
  }
  return parentPid
}

export function shortCommand(command: string): string {
  const [first = '', ...rest] = command.split(' ')
  if (!first.startsWith('/')) return command
  return [executable(first), ...rest].join(' ')
}

export function buildSnapshot(stdout: string, takenAt: number): ProcSnapshot {
  const { parentPid, selfPid, cores, rows } = parsePs(stdout)
  const rootPid = findRoot(rows, parentPid)
  const root = rows.get(rootPid)

  if (!root) {
    return {
      rootPid,
      takenAt,
      nodes: [],
      totalRssKb: 0,
      totalCpu: 0,
      cores,
      error: `Claude Code process (pid ${rootPid}) not found in ps output`,
    }
  }

  const children = new Map<number, Row[]>()
  for (const row of rows.values()) {
    if (row.pid === selfPid || row.pid === row.ppid) continue
    const list = children.get(row.ppid) ?? []
    list.push(row)
    children.set(row.ppid, list)
  }

  const nodes: ProcNode[] = []
  const walk = (row: Row, prefix: string, indent: string) => {
    nodes.push({ ...row, prefix })
    const kids = (children.get(row.pid) ?? []).sort((a, b) => a.pid - b.pid)
    kids.forEach((kid, i) => {
      const isLast = i === kids.length - 1
      walk(kid, indent + (isLast ? '└─ ' : '├─ '), indent + (isLast ? '   ' : '│  '))
    })
  }
  walk(root, '', '')

  return {
    rootPid,
    takenAt,
    nodes,
    totalRssKb: nodes.reduce((sum, n) => sum + n.rssKb, 0),
    totalCpu: nodes.reduce((sum, n) => sum + n.cpu, 0),
    cores,
    error: null,
  }
}

export function formatKb(kb: number): string {
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(2)} GB`
  if (kb >= 1024) return `${(kb / 1024).toFixed(1)} MB`
  return `${kb} KB`
}

// ps counts one busy core as 100%, so the total reads against the core count.
export function formatCores(totalCpu: number, cores: number | null): string {
  if (cores === null) return ''
  return ` (${(totalCpu / 100).toFixed(1)} of ${cores} ${cores === 1 ? 'core' : 'cores'})`
}
