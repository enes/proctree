import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { ProcNode, ProcSnapshot } from '../types'
import { SAMPLE_SCRIPT, buildSnapshot, formatCores, formatKb, shortCommand } from './tree'

const PANE = 'proctree'
const TITLE = 'Process tree'
const MAX_FAILURES = 3
// The keys answer only while the pane holds the keyboard.
const FOCUS_HINT = 'ctrl+x tab: use keys'

const snapshot = atom({ plugin: 'proctree', key: 'snapshot' } as const, null)
const peakRssKb = atom({ plugin: 'proctree', key: 'peakRssKb' } as const, 0)
const isPaused = atom({ plugin: 'proctree', key: 'isPaused' } as const, false)
const showFullCommand = atom({ plugin: 'proctree', key: 'showFullCommand' } as const, false)

let isSampling = false
let failures = 0

type Key = { key: string; hotkey: string; label: string; onPress: () => unknown }

// How many rows a wrapping row of items two columns apart takes at a width.
function linesFor(items: string[], columns: number): number {
  let lines = 1
  let used = 0
  for (const item of items) {
    const next = used === 0 ? item.length : used + 2 + item.length
    if (next > columns && used > 0) {
      lines += 1
      used = item.length
    } else {
      used = next
    }
  }
  return lines
}

function failure(error: string, takenAt: number): ProcSnapshot {
  return { rootPid: 0, takenAt, nodes: [], totalRssKb: 0, totalCpu: 0, cores: null, error }
}

async function takeSnapshot($: EngineInterface): Promise<ProcSnapshot> {
  const takenAt = await $.clock.now()
  try {
    const { exitCode, stdout, stderr } = await $.process.run(['sh', '-c', SAMPLE_SCRIPT], {
      env: { LC_ALL: 'C' },
      timeoutMs: 5000,
    })
    if (exitCode === 0) return buildSnapshot(stdout, takenAt)
    return failure(`ps exited with code ${exitCode}: ${stderr.trim()}`, takenAt)
  } catch (error) {
    return failure(`could not run sh and ps (proctree needs macOS or Linux): ${String(error)}`, takenAt)
  }
}

// After MAX_FAILURES failed samples in a row (Windows, a missing ps) it stops
// trying until the person runs /proctree again.
async function sample($: EngineInterface, showStatus: boolean) {
  if (isSampling || failures >= MAX_FAILURES) return
  isSampling = true
  try {
    const taken = await takeSnapshot($)
    failures = taken.error === null ? 0 : failures + 1
    await update($, snapshot, () => taken)

    if (taken.error !== null) {
      if (failures >= MAX_FAILURES) {
        $.ui.status(undefined)
        $.ui.toast(`proctree stopped sampling: ${taken.error}`)
      }
      return
    }

    await update($, peakRssKb, peak => Math.max(peak, taken.totalRssKb))
    $.ui.status(
      showStatus ? `claude ${formatKb(taken.totalRssKb)} · ${taken.nodes.length} procs` : undefined,
    )
  } finally {
    isSampling = false
  }
}

async function retry($: EngineInterface, showStatus: boolean) {
  failures = 0
  await sample($, showStatus)
}

// With the status line off there is nobody to sample for while the pane is shut.
async function tick($: EngineInterface, showStatus: boolean) {
  if (await read($, isPaused)) return
  if (!showStatus) {
    const panes = await $.ui.panes()
    if (!panes.some(pane => pane.id === PANE && pane.isShown)) return
  }
  await sample($, showStatus)
}

export const register: Register = (on, options) => {
  const seconds = Math.min(60, Math.max(1, Number(options.intervalSeconds ?? 2) || 2))
  const showStatus = options.showStatus !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'proctree',
      description: 'Show the process tree, RAM and CPU of this Claude Code session',
    })
    if (showStatus) void sample($, showStatus)
    $.clock.every(seconds * 1000, () => {
      void tick($, showStatus)
    })

    return next(e)
  })

  on('command.run', { command: 'proctree' }, async $ => {
    await retry($, showStatus)
    await $.ui.open({ id: PANE, title: TITLE, focus: true })
    const snap = await read($, snapshot)

    return {
      text:
        snap && snap.error === null
          ? `${snap.nodes.length} processes, ${formatKb(snap.totalRssKb)} RAM.`
          : 'Pane opened.',
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const peak = await read($, peakRssKb)
    const paused = await read($, isPaused)
    const full = await read($, showFullCommand)

    const keys: Key[] = [
      {
        key: 'pause',
        hotkey: 'p',
        label: paused ? 'resume' : 'pause',
        onPress: () => update($, isPaused, value => !value),
      },
      {
        key: 'full',
        hotkey: 'f',
        label: full ? 'short commands' : 'full commands',
        onPress: () => update($, showFullCommand, value => !value),
      },
      {
        key: 'peak',
        hotkey: 'z',
        label: 'reset peak',
        onPress: async () => {
          const current = await read($, snapshot)
          await update($, peakRssKb, () => current?.totalRssKb ?? 0)
        },
      },
    ]
    const footer = (
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        {keys.map(k => (
          <Button key={k.key} plain dimColor hotkey={k.hotkey} label={k.label} onPress={k.onPress} />
        ))}
        <Button
          key="close"
          plain
          dimColor
          hotkey="c"
          role="dismiss"
          label="close"
          onPress={() => $.ui.close({ id: PANE })}
        />
        {!e.props.isFocused && <Text dimColor>{FOCUS_HINT}</Text>}
      </Box>
    )

    // On the terminal the footer sits on the pane's last rows and the tree
    // gets what is left; elsewhere the content flows and the footer follows.
    const bodyRows = e.props.scroll.bodyRows
    const isPinned = e.surface === 'terminal' && bodyRows > 0
    const footerRows = linesFor(
      [
        ...keys.map(k => `${k.hotkey}: ${k.label}`),
        'c: close',
        ...(e.props.isFocused ? [] : [FOCUS_HINT]),
      ],
      e.props.bodyColumns,
    )
    const frame = (...body: RenderElement[]) =>
      isPinned ? (
        <Box flexDirection="column" height={bodyRows}>
          <Box flexDirection="column" flexGrow={1} overflow="hidden">
            {body}
          </Box>
          {footer}
        </Box>
      ) : (
        <Box flexDirection="column">
          {body}
          <Box marginTop={1}>{footer}</Box>
        </Box>
      )

    if (!snap) {
      return frame(<Text dimColor>Sampling…</Text>)
    }

    if (snap.error !== null) {
      return frame(
        <Text color="red">{snap.error}</Text>,
        <Text dimColor>Run /proctree to try again.</Text>,
      )
    }

    const row = (node: ProcNode) => {
      const mb = node.rssKb / 1024
      const memColor = mb >= 1024 ? 'red' : mb >= 300 ? 'yellow' : undefined
      const isRoot = node.pid === snap.rootPid
      const command = full ? node.command : shortCommand(node.command)

      return (
        <Box key={`p${node.pid}`} flexDirection="row">
          <Box width={8} flexShrink={0}>
            <Text bold={isRoot}>{String(node.pid)}</Text>
          </Box>
          <Box width={11} flexShrink={0} justifyContent="flex-end" paddingRight={1}>
            <Text color={memColor} bold={isRoot}>{formatKb(node.rssKb)}</Text>
          </Box>
          <Box width={7} flexShrink={0} justifyContent="flex-end" paddingRight={1}>
            <Text dimColor={node.cpu < 1}>{node.cpu.toFixed(1)}%</Text>
          </Box>
          <Box width={12} flexShrink={0}>
            <Text dimColor>{node.etime}</Text>
          </Box>
          <Box flexGrow={1} flexShrink={1}>
            <Text wrap="truncate-end" bold={isRoot}>
              <Text dimColor>{node.prefix}</Text>
              {command}
            </Text>
          </Box>
        </Box>
      )
    }

    const count = snap.nodes.length
    // Summary, blank line and column headings take three rows above the tree.
    const room = isPinned ? Math.max(0, bodyRows - 3 - footerRows) : count
    const shown = count > room ? snap.nodes.slice(0, Math.max(0, room - 1)) : snap.nodes
    const hidden = count - shown.length

    return frame(
      <Text>
        <Text bold>{`${count} ${count === 1 ? 'process' : 'processes'}`}</Text>
        {`  ·  RAM ${formatKb(snap.totalRssKb)}  ·  peak ${formatKb(peak)}  ·  CPU ${snap.totalCpu.toFixed(1)}%${formatCores(snap.totalCpu, snap.cores)}`}
        <Text dimColor>{paused ? '  ·  paused' : `  ·  every ${seconds}s`}</Text>
      </Text>,
      <Box flexDirection="row" marginTop={1}>
        <Box width={8} flexShrink={0}>
          <Text dimColor>PID</Text>
        </Box>
        <Box width={11} flexShrink={0} justifyContent="flex-end" paddingRight={1}>
          <Text dimColor>RSS</Text>
        </Box>
        <Box width={7} flexShrink={0} justifyContent="flex-end" paddingRight={1}>
          <Text dimColor>CPU</Text>
        </Box>
        <Box width={12} flexShrink={0}>
          <Text dimColor>TIME</Text>
        </Box>
        <Box flexGrow={1}>
          <Text dimColor>COMMAND</Text>
        </Box>
      </Box>,
      ...shown.map(row),
      ...(hidden > 0 ? [<Text dimColor>{`… ${hidden} more`}</Text>] : []),
    )
  })
}
