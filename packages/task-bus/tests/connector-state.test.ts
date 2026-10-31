import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readConnectorState, writeConnectorState } from '../src/index.ts'

describe('task-bus connector state', () => {
  it('defaults to disabled when the state file does not exist', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'task-bus-state-'))
    try {
      const state = await readConnectorState(join(directory, 'connector-state.json'))
      expect(state.enabled).toBe(false)
      expect(state.capabilities['approval.push']).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('round-trips enabled and capability state atomically', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'task-bus-state-'))
    const path = join(directory, 'nested', 'connector-state.json')
    try {
      await writeConnectorState({
        enabled: true,
        capabilities: { 'approval.push': false },
      }, path)
      expect(await readConnectorState(path)).toEqual({
        enabled: true,
        capabilities: { 'approval.push': false },
      })
      expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ enabled: true })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
