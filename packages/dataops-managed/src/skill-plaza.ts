/** Skills users share with each other, reached through the DataOps API. */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-skill'

/** One plaza entry as the browser reads it. */
export interface PlazaSkill {
  /** Plaza entry id, used to install or stop sharing it. */
  id: number
  name: string
  description?: string
  instruction: string
  tags: string[]
  /** Whether the current user shared this entry. */
  sharedByMe: boolean
  updatedAt: string
}

/** A skill the local workspace holds, offered by name for sharing. */
export interface LocalSkillCandidate {
  name: string
  description?: string
  instruction: string
}

/** What installing one entry did. */
export interface PlazaInstallResult {
  installed: boolean
  skillKey: string | null
  keptLocal: boolean
}

/** Configuration the plaza reads from the profile. */
export interface PlazaConfig {
  /** DataOps browser/API origin reachable from the DSH Host. */
  baseUrl: string
  /** DSH credential reference holding the current DataOps access JWT. */
  credentialRef: string
}

/** Narrow an unknown value to a plain object. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/**
 * Read the skills this workspace holds.
 *
 * The official skill registry is the reader, so the list is the same one the skill center
 * shows and includes every source. It is read-only here; sharing a copy of one is what the
 * plaza does with it.
 * @param ctx - DSH Host context carrying the skill registry.
 * @returns Each skill's name, description, and body.
 */
export async function readLocalSkills(ctx: Context): Promise<LocalSkillCandidate[]> {
  const snapshot = await ctx.skills.snapshot({})
  const candidates: LocalSkillCandidate[] = []
  for (const summary of snapshot.skills) {
    const definition = await ctx.skills.get(summary.name, {})
    if (definition === undefined) continue
    candidates.push({
      name: definition.name,
      description: definition.description === '' ? undefined : definition.description,
      instruction: definition.content,
    })
  }
  return candidates
}

/**
 * The skill plaza, as this workspace sees it.
 *
 * Every call carries the workspace's own DataOps JWT, so DataOps decides who may read and
 * share. The plaza copy lives in DataOps rather than here: a reader installs it into their own
 * workspace and keeps working after the author edits or stops sharing.
 */
export class SkillPlaza {
  constructor(private readonly ctx: Context, private readonly config: PlazaConfig) {}

  /** The DataOps API origin this workspace reports to. */
  private apiBase(): string {
    return new URL(this.config.baseUrl).origin
  }

  /**
   * Read the DataOps JWT this workspace is currently authorized with.
   * @returns The token, or undefined when the workspace has no session yet.
   */
  private async token(): Promise<string | undefined> {
    const resolved = await this.ctx.credentials.resolve(credentialRef(this.config.credentialRef))
    return resolved?.value
  }

  /**
   * Call one DataOps endpoint with this workspace's identity.
   * @param path - API path below the origin.
   * @param init - Method, body, and any extra headers.
   * @returns The parsed JSON body, or undefined when the workspace is not authorized.
   */
  private async call(path: string, init: RequestInit = {}): Promise<unknown> {
    const token = await this.token()
    if (token === undefined) return undefined
    const response = await fetch(new URL(path, this.apiBase()), {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...init.headers,
      },
    })
    if (response.status === 401) return undefined
    if (!response.ok) throw new Error(`Skill plaza request failed with HTTP ${String(response.status)}`)
    return response.status === 204 ? null : await response.json()
  }

  /**
   * List plaza entries, optionally filtered.
   * @param options - Tag and text filters.
   * @returns Entries, newest first; empty when the workspace is not authorized.
   */
  async list(options: { tag?: string; query?: string } = {}): Promise<PlazaSkill[]> {
    const params = new URLSearchParams()
    if (options.tag !== undefined && options.tag !== '') params.set('tag', options.tag)
    if (options.query !== undefined && options.query !== '') params.set('q', options.query)
    const suffix = params.size === 0 ? '' : `?${params.toString()}`
    const body = await this.call(`/api/ai/skill-plaza/skills${suffix}`)
    if (!Array.isArray(body)) return []
    return body.flatMap((row) => this.toPlazaSkill(row))
  }

  /**
   * Every tag in use, so the browser offers existing labels.
   * @returns Distinct tags.
   */
  async tags(): Promise<string[]> {
    const body = await this.call('/api/ai/skill-plaza/tags')
    if (!Array.isArray(body)) return []
    return body.filter((tag): tag is string => typeof tag === 'string')
  }

  /**
   * Publish one skill to the plaza.
   * @param input - Skill content and its tags.
   * @returns The stored entry.
   */
  async share(input: { name: string; description?: string; instruction: string; tags: string[] }): Promise<PlazaSkill | null> {
    const body = await this.call('/api/ai/skill-plaza/skills', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    return body === undefined ? null : this.toPlazaSkill(body)[0] ?? null
  }

  /**
   * Stop sharing one entry.
   * @param id - Plaza entry.
   */
  async unshare(id: number): Promise<void> {
    await this.call(`/api/ai/skill-plaza/skills/${String(id)}`, { method: 'DELETE' })
  }

  /**
   * Install one entry into this workspace.
   * @param skillId - Plaza entry.
   * @returns What happened, or null when the workspace is not authorized.
   */
  async install(skillId: number): Promise<PlazaInstallResult | null> {
    const body = await this.call('/api/ai/skill-plaza/install', {
      method: 'POST',
      body: JSON.stringify({ skillId }),
    })
    const record = body === undefined ? null : asRecord(body)
    if (record === null) return null
    return {
      installed: record.installed === true,
      skillKey: typeof record.skillKey === 'string' ? record.skillKey : null,
      keptLocal: record.keptLocal === true,
    }
  }

  /** Project one API row into the shape the browser reads. */
  private toPlazaSkill(value: unknown): PlazaSkill[] {
    const row = asRecord(value)
    if (row === null || typeof row.id !== 'number' || typeof row.name !== 'string') return []
    return [{
      id: row.id,
      name: row.name,
      description: typeof row.description === 'string' ? row.description : undefined,
      instruction: typeof row.instruction === 'string' ? row.instruction : '',
      tags: Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === 'string') : [],
      sharedByMe: row.sharedByMe === true,
      updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : '',
    }]
  }
}
