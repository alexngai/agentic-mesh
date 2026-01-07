// JSONLBridge - Bridge between golden JSONL files and CRDT state
// Implements: i-8mw6

import * as fs from 'fs/promises'
import * as path from 'path'
import type {
  SpecCRDT,
  IssueCRDT,
  RelationshipCRDT,
  FeedbackCRDT,
  SpecJSONL,
  IssueJSONL,
} from './types'
import { EntityMapper } from './mapper'

export interface SudocodeState {
  specs: SpecCRDT[]
  issues: IssueCRDT[]
  relationships: RelationshipCRDT[]
  feedback: FeedbackCRDT[]
}

export class JSONLBridge {
  private projectPath: string
  private mapper: EntityMapper
  private lastHashes: Map<string, string> = new Map()

  constructor(projectPath: string) {
    this.projectPath = projectPath
    this.mapper = new EntityMapper()
  }

  // ==========================================================================
  // Load from JSONL
  // ==========================================================================

  async loadFromJSONL(): Promise<SudocodeState> {
    const specs: SpecCRDT[] = []
    const issues: IssueCRDT[] = []
    const relationships: RelationshipCRDT[] = []
    const feedback: FeedbackCRDT[] = []

    // Build UUID lookup maps
    const specUuids = new Map<string, string>()
    const issueUuids = new Map<string, string>()

    // Load specs
    const specsData = await this.readJSONLFile<SpecJSONL>('specs.jsonl')
    for (const spec of specsData) {
      specs.push(this.mapper.specToCRDT(spec))
      specUuids.set(spec.id, spec.uuid)

      // Extract relationships from spec
      for (const rel of spec.relationships || []) {
        // Will fill in UUIDs after loading all entities
        relationships.push({
          from_id: rel.from,
          from_uuid: '', // Will be filled later
          from_type: rel.from_type,
          to_id: rel.to,
          to_uuid: '', // Will be filled later
          to_type: rel.to_type,
          relationship_type: rel.type,
          created_at: spec.created_at,
        })
      }
    }

    // Load issues
    const issuesData = await this.readJSONLFile<IssueJSONL>('issues.jsonl')
    for (const issue of issuesData) {
      issues.push(this.mapper.issueToCRDT(issue))
      issueUuids.set(issue.id, issue.uuid)

      // Extract relationships from issue
      for (const rel of issue.relationships || []) {
        relationships.push({
          from_id: rel.from,
          from_uuid: '',
          from_type: rel.from_type,
          to_id: rel.to,
          to_uuid: '',
          to_type: rel.to_type,
          relationship_type: rel.type,
          created_at: issue.created_at,
        })
      }

      // Extract feedback from issue
      for (const fb of issue.feedback || []) {
        const toUuid = issue.uuid
        const fromUuid = fb.from_id
          ? issueUuids.get(fb.from_id) || specUuids.get(fb.from_id)
          : undefined
        feedback.push(this.mapper.feedbackToCRDT(fb, toUuid, fromUuid))
      }
    }

    // Fill in UUIDs for relationships
    for (const rel of relationships) {
      rel.from_uuid =
        rel.from_type === 'spec'
          ? specUuids.get(rel.from_id) || ''
          : issueUuids.get(rel.from_id) || ''
      rel.to_uuid =
        rel.to_type === 'spec'
          ? specUuids.get(rel.to_id) || ''
          : issueUuids.get(rel.to_id) || ''
    }

    // Deduplicate relationships (same relationship may appear in both entities)
    const uniqueRelationships = this.deduplicateRelationships(relationships)

    // Store hashes for change detection
    await this.updateHashes()

    return {
      specs,
      issues,
      relationships: uniqueRelationships,
      feedback,
    }
  }

  // ==========================================================================
  // Save to JSONL
  // ==========================================================================

  async saveToJSONL(state: SudocodeState): Promise<void> {
    // Build lookup maps
    const specMap = new Map(state.specs.map((s) => [s.id, s]))
    const issueMap = new Map(state.issues.map((i) => [i.id, i]))

    // Group relationships by entity
    const specRelationships = new Map<string, RelationshipCRDT[]>()
    const issueRelationships = new Map<string, RelationshipCRDT[]>()

    for (const rel of state.relationships) {
      // Add to "from" entity
      if (rel.from_type === 'spec') {
        const existing = specRelationships.get(rel.from_id) || []
        existing.push(rel)
        specRelationships.set(rel.from_id, existing)
      } else {
        const existing = issueRelationships.get(rel.from_id) || []
        existing.push(rel)
        issueRelationships.set(rel.from_id, existing)
      }
    }

    // Group feedback by target issue
    const issueFeedback = new Map<string, FeedbackCRDT[]>()
    for (const fb of state.feedback) {
      // Feedback is stored on the target issue (if target is an issue)
      if (fb.to_id.startsWith('i-')) {
        const existing = issueFeedback.get(fb.to_id) || []
        existing.push(fb)
        issueFeedback.set(fb.to_id, existing)
      }
    }

    // Build JSONL specs
    const specsJsonl: SpecJSONL[] = state.specs.map((spec) => {
      const rels = specRelationships.get(spec.id) || []
      return this.mapper.specToJSONL(
        spec,
        rels.map((r) => this.mapper.relationshipToJSONL(r)),
        [] // Tags not synced via mesh for now
      )
    })

    // Build JSONL issues
    const issuesJsonl: IssueJSONL[] = state.issues.map((issue) => {
      const rels = issueRelationships.get(issue.id) || []
      const fbs = issueFeedback.get(issue.id) || []
      return this.mapper.issueToJSONL(
        issue,
        rels.map((r) => this.mapper.relationshipToJSONL(r)),
        [], // Tags not synced via mesh for now
        fbs.map((f) => this.mapper.feedbackToJSONL(f))
      )
    })

    // Sort by created_at for merge-friendly ordering
    specsJsonl.sort((a, b) => a.created_at.localeCompare(b.created_at))
    issuesJsonl.sort((a, b) => a.created_at.localeCompare(b.created_at))

    // Write files atomically
    await this.writeJSONLFile('specs.jsonl', specsJsonl)
    await this.writeJSONLFile('issues.jsonl', issuesJsonl)

    // Update hashes
    await this.updateHashes()
  }

  // ==========================================================================
  // Change Detection
  // ==========================================================================

  async hasJSONLChanged(): Promise<boolean> {
    const files = ['specs.jsonl', 'issues.jsonl']

    for (const file of files) {
      const filePath = path.join(this.projectPath, file)
      try {
        const content = await fs.readFile(filePath, 'utf-8')
        const hash = this.hashString(content)
        const lastHash = this.lastHashes.get(file)

        if (lastHash && lastHash !== hash) {
          return true
        }
      } catch {
        // File doesn't exist, that's fine
      }
    }

    return false
  }

  private async updateHashes(): Promise<void> {
    const files = ['specs.jsonl', 'issues.jsonl']

    for (const file of files) {
      const filePath = path.join(this.projectPath, file)
      try {
        const content = await fs.readFile(filePath, 'utf-8')
        this.lastHashes.set(file, this.hashString(content))
      } catch {
        this.lastHashes.delete(file)
      }
    }
  }

  private hashString(str: string): string {
    // Simple hash for change detection
    let hash = 0
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i)
      hash = (hash << 5) - hash + char
      hash = hash & hash // Convert to 32-bit integer
    }
    return hash.toString(16)
  }

  // ==========================================================================
  // Internal: File Operations
  // ==========================================================================

  private async readJSONLFile<T>(filename: string): Promise<T[]> {
    const filePath = path.join(this.projectPath, filename)

    try {
      const content = await fs.readFile(filePath, 'utf-8')
      const lines = content.split('\n').filter((line) => line.trim())
      return lines.map((line) => JSON.parse(line) as T)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return []
      }
      throw err
    }
  }

  private async writeJSONLFile<T>(filename: string, data: T[]): Promise<void> {
    const filePath = path.join(this.projectPath, filename)
    const tempPath = filePath + '.tmp'

    // Write to temp file
    const content = data.map((item) => JSON.stringify(item)).join('\n') + '\n'
    await fs.writeFile(tempPath, content, 'utf-8')

    // Atomic rename
    await fs.rename(tempPath, filePath)

    // Set mtime to newest updated_at for proper git behavior
    const newestUpdate = data.reduce((max, item: unknown) => {
      const updated = (item as { updated_at?: string }).updated_at
      return updated && updated > max ? updated : max
    }, '')

    if (newestUpdate) {
      const mtime = new Date(newestUpdate)
      await fs.utimes(filePath, mtime, mtime)
    }
  }

  private deduplicateRelationships(relationships: RelationshipCRDT[]): RelationshipCRDT[] {
    const seen = new Set<string>()
    const unique: RelationshipCRDT[] = []

    for (const rel of relationships) {
      const key = `${rel.from_id}:${rel.to_id}:${rel.relationship_type}`
      if (!seen.has(key)) {
        seen.add(key)
        unique.push(rel)
      }
    }

    return unique
  }
}
