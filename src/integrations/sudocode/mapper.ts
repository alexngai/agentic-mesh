// EntityMapper - Bidirectional mapping between sudocode entities and CRDT
// Implements: i-8cq0

import type {
  SpecCRDT,
  IssueCRDT,
  RelationshipCRDT,
  FeedbackCRDT,
  SpecJSONL,
  IssueJSONL,
  RelationshipJSONL,
  FeedbackJSONL,
  FeedbackAnchorCRDT,
} from './types'

export class EntityMapper {
  // ==========================================================================
  // Spec Mapping
  // ==========================================================================

  specToCRDT(spec: SpecJSONL): SpecCRDT {
    return {
      id: spec.id,
      uuid: spec.uuid,
      title: spec.title,
      content: spec.content,
      priority: spec.priority,
      archived: spec.archived ?? false,
      created_at: spec.created_at,
      updated_at: spec.updated_at,
      parent_id: spec.parent_id,
      parent_uuid: spec.parent_uuid,
    }
  }

  specToJSONL(
    crdt: SpecCRDT,
    relationships: RelationshipJSONL[],
    tags: string[]
  ): SpecJSONL {
    return {
      id: crdt.id,
      uuid: crdt.uuid,
      title: crdt.title,
      file_path: this.generateSpecFilePath(crdt.id, crdt.title),
      content: crdt.content,
      priority: crdt.priority,
      archived: crdt.archived || undefined,
      archived_at: undefined, // Would need to track separately
      created_at: crdt.created_at,
      updated_at: crdt.updated_at,
      parent_id: crdt.parent_id,
      parent_uuid: crdt.parent_uuid,
      relationships,
      tags,
    }
  }

  private generateSpecFilePath(id: string, title: string): string {
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 50)
    return `specs/${id}_${slug}.md`
  }

  // ==========================================================================
  // Issue Mapping
  // ==========================================================================

  issueToCRDT(issue: IssueJSONL): IssueCRDT {
    return {
      id: issue.id,
      uuid: issue.uuid,
      title: issue.title,
      status: issue.status,
      content: issue.content,
      priority: issue.priority,
      assignee: issue.assignee,
      archived: issue.archived ?? false,
      created_at: issue.created_at,
      updated_at: issue.updated_at,
      closed_at: issue.closed_at,
      parent_id: issue.parent_id,
      parent_uuid: issue.parent_uuid,
    }
  }

  issueToJSONL(
    crdt: IssueCRDT,
    relationships: RelationshipJSONL[],
    tags: string[],
    feedback?: FeedbackJSONL[]
  ): IssueJSONL {
    return {
      id: crdt.id,
      uuid: crdt.uuid,
      title: crdt.title,
      status: crdt.status,
      content: crdt.content,
      priority: crdt.priority,
      assignee: crdt.assignee,
      archived: crdt.archived || undefined,
      archived_at: undefined,
      created_at: crdt.created_at,
      updated_at: crdt.updated_at,
      closed_at: crdt.closed_at,
      parent_id: crdt.parent_id,
      parent_uuid: crdt.parent_uuid,
      relationships,
      tags,
      feedback,
    }
  }

  // ==========================================================================
  // Relationship Mapping
  // ==========================================================================

  relationshipToCRDT(
    rel: RelationshipJSONL,
    fromUuid: string,
    toUuid: string,
    createdAt: string
  ): RelationshipCRDT {
    return {
      from_id: rel.from,
      from_uuid: fromUuid,
      from_type: rel.from_type,
      to_id: rel.to,
      to_uuid: toUuid,
      to_type: rel.to_type,
      relationship_type: rel.type,
      created_at: createdAt,
    }
  }

  relationshipToJSONL(crdt: RelationshipCRDT): RelationshipJSONL {
    return {
      from: crdt.from_id,
      from_type: crdt.from_type,
      to: crdt.to_id,
      to_type: crdt.to_type,
      type: crdt.relationship_type,
    }
  }

  // ==========================================================================
  // Feedback Mapping
  // ==========================================================================

  feedbackToCRDT(fb: FeedbackJSONL, toUuid: string, fromUuid?: string): FeedbackCRDT {
    return {
      id: fb.id,
      from_id: fb.from_id,
      from_uuid: fromUuid,
      to_id: fb.to_id,
      to_uuid: toUuid,
      feedback_type: fb.feedback_type,
      content: fb.content,
      agent: fb.agent,
      anchor: fb.anchor as FeedbackAnchorCRDT | undefined,
      dismissed: fb.dismissed ?? false,
      created_at: fb.created_at,
      updated_at: fb.updated_at,
    }
  }

  feedbackToJSONL(crdt: FeedbackCRDT): FeedbackJSONL {
    return {
      id: crdt.id,
      from_id: crdt.from_id,
      to_id: crdt.to_id,
      feedback_type: crdt.feedback_type,
      content: crdt.content,
      agent: crdt.agent,
      anchor: crdt.anchor,
      dismissed: crdt.dismissed || undefined,
      created_at: crdt.created_at,
      updated_at: crdt.updated_at,
    }
  }
}
