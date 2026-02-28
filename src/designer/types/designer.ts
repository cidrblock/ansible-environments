/**
 * Ansible Content Designer - Type Definitions
 * 
 * All TypeScript interfaces for the Content Designer module.
 * These types mirror the database schema defined in schema.sql.
 */

// ============================================================================
// Enums
// ============================================================================

export type Phase = 'intake' | 'assessment' | 'planning' | 'building' | 'complete';

export type PhaseStatus = 'locked' | 'available' | 'in_progress' | 'blocked' | 'complete';

export type RequirementStatus = 'draft' | 'assessed' | 'planned' | 'building' | 'complete';

export type PlanItemStatus = 'proposed' | 'needs_clarification' | 'revised' | 'approved' | 'rejected' | 'in_progress' | 'complete' | 'failed';

export type PlanItemHistoryType = 'proposed' | 'comment' | 'revised' | 'approved' | 'rejected';

export type BuildStepStatus = 'pending' | 'in_progress' | 'complete' | 'failed' | 'skipped';

export type DriftStatus = 'compliant' | 'drifted' | 'partial';

export type DriftResolution = 'pending' | 'spec_updated' | 'regenerated' | 'flagged' | 'dismissed';

export type ProjectType = 'playbook_collection' | 'collection' | 'execution_environment';

export type QuestionCategory = 
    | 'architecture' 
    | 'security' 
    | 'compatibility' 
    | 'error_handling' 
    | 'idempotency' 
    | 'naming' 
    | 'testing'
    | 'dependencies';  // For collection identification during dependency assessment

export type QuestionType = 'text' | 'single_choice' | 'multi_choice' | 'yes_no' | 'confirm';

export type QuestionPriority = 'required' | 'recommended' | 'optional';

export type ArtifactType = 
    | 'playbook' 
    | 'role' 
    | 'module' 
    | 'module_utils' 
    | 'filter_plugin' 
    | 'lookup_plugin' 
    | 'inventory_plugin' 
    | 'template' 
    | 'vars_file' 
    | 'test' 
    | 'ee_definition';

// Plan item action types (agent-proposed steps)
export type PlanItemActionType = 'scaffold' | 'generate' | 'install' | 'configure';

// ============================================================================
// Database Row Types
// ============================================================================

export type AssessmentStage = 'dependencies' | 'content';

export interface Project {
    id: number;
    name: string;
    namespace: string;
    type: ProjectType;
    description?: string;
    phase: Phase;
    assessment_stage: AssessmentStage;
    created_at: string;
    updated_at: string;
}

/**
 * Collection identified during dependency assessment
 */
export interface IdentifiedCollection {
    id: number;
    requirement_id?: string;
    collection_fqcn: string;
    reason?: string;
    confirmed: boolean;
    installed: boolean;
    installed_at?: string;
}

export interface Requirement {
    id: string;  // REQ-001 format
    description: string;
    status: RequirementStatus;
    created_at: string;
    created_by?: string;
    updated_at: string;
}

export interface RequirementTag {
    requirement_id: string;
    tag: string;
}

export interface DesignDecision {
    id: number;
    requirement_id: string;
    question_id: string;
    category: QuestionCategory;
    question: string;
    question_type?: QuestionType;
    choices?: string;  // JSON array of choices
    suggested_default?: string;
    answer?: string;
    rationale?: string;
    used_default: boolean;
    answered_by?: string;
    answered_at?: string;
    previous_answer?: string;
    changed_at?: string;
    change_reason?: string;
    stage: AssessmentStage;  // 'dependencies' or 'content'
}

export interface ProjectDecision {
    id: number;
    category: string;
    key: string;
    value: string;  // JSON for complex values
    rationale?: string;
    decided_by?: string;
    decided_at: string;
}

export interface PlanItem {
    id: string;  // ITEM-001 format or COLL-* for collection installs
    requirement_id: string;
    type: PlanItemActionType;  // scaffold, generate, install, configure
    name: string;
    description?: string;  // JSON with action details
    collection?: string;
    collection_rationale?: string;
    status: PlanItemStatus;
    sequence?: number;
    created_at: string;
}

export interface PlanItemHistory {
    id: number;
    plan_item_id: string;
    version: number;
    entry_type: PlanItemHistoryType;
    content: string;
    by: 'agent' | 'user';
    created_at: string;
}

export interface BuildStep {
    id: string;
    plan_item_id: string;
    description: string;
    status: BuildStepStatus;
    output?: string;
    artifact_path?: string;
    started_at?: string;
    completed_at?: string;
}

export interface Artifact {
    id: number;
    plan_item_id?: string;
    path: string;
    content_hash?: string;
    stale: boolean;
    stale_reason?: string;
    stale_since?: string;
    generated_at: string;
}

export interface PhaseProgress {
    phase: Phase;
    status: PhaseStatus;
    started_at?: string;
    completed_at?: string;
    total_items: number;
    completed_items: number;
    pending_items: number;
    blocker_count: number;
    blocker_summary?: string;  // JSON array
}

export interface SignOff {
    id: number;
    phase: Phase;
    signed_off_at: string;
    signed_off_by: string;
    notes?: string;
    revoked_at?: string;
    revoked_by?: string;
    revoke_reason?: string;
}

export interface DriftAssessment {
    id: number;
    assessed_at: string;
    assessed_by?: string;
    total_requirements: number;
    compliant: number;
    drifted: number;
    overall_compliance: number;
    summary?: string;
    report: string;  // JSON
}

export interface DriftFinding {
    id: number;
    assessment_id: number;
    requirement_id: string;
    status: DriftStatus;
    expected?: string;
    found?: string;
    additions?: string;  // JSON array
    removals?: string;   // JSON array
    resolution: DriftResolution;
    resolution_note?: string;
    resolved_at?: string;
    resolved_by?: string;
}

export interface HistoryEntry {
    id: number;
    timestamp: string;
    action: string;
    entity_type: string;
    entity_id?: string;
    actor?: string;
    details?: string;  // JSON
}

// ============================================================================
// Service Types
// ============================================================================

export interface QueryResult {
    success: boolean;
    rowCount?: number;
    columns?: string[];
    rows?: Record<string, unknown>[];
    truncated?: boolean;
    error?: string;
    hint?: string;
}

export interface ProjectProgress {
    currentPhase: Phase;
    phases: PhaseProgressWithSignOff[];
    overallProgress: number;  // 0-100
    canProceed: boolean;
    nextAction: string;
}

export interface PhaseProgressWithSignOff extends PhaseProgress {
    blockers: string[];
    signedOff: boolean;
    signedOffAt?: string;
    signedOffBy?: string;
}

export interface InvalidationResult {
    invalidated: Phase[];
    artifactsMarkedStale: boolean;
}

// ============================================================================
// Agent Types
// ============================================================================

export interface AssessmentQuestion {
    id: string;
    requirement_ref: string;
    category: QuestionCategory;
    question: string;
    type: QuestionType;
    choices?: string[];
    suggested_default?: string;
    rationale: string;
    priority: QuestionPriority;
}

export interface AssessmentResponse {
    questions: AssessmentQuestion[];
    assessment_complete: boolean;
    summary: string;
}

export interface PlanItemSuggestion {
    description: string;
    type: ArtifactType;
    name: string;
    collection?: string;
    collection_rationale?: string;
    requirement_refs: string[];
    depends_on?: string[];
}

export interface PlanResponse {
    items: PlanItemSuggestion[];
    collections_to_install: string[];
    summary: string;
}

export interface DriftFindingDetail {
    decision: string;
    expected: string;
    found: string;
    compliant: boolean;
}

export interface DriftReportItem {
    requirement_id: string;
    status: DriftStatus;
    summary: string;
    details: DriftFindingDetail[];
    additions: string[];
    removals: string[];
    recommendations: string[];
}

export interface DriftResponse {
    findings: DriftReportItem[];
    overall_compliance: number;
    summary: string;
}

// ============================================================================
// Enriched Types (for UI display)
// ============================================================================

export interface EnrichedRequirement extends Requirement {
    tags: string[];
    decisions: DesignDecision[];
    planItems?: PlanItem[];
}

export interface EnrichedPlanItem extends PlanItem {
    requirement: Requirement;
    buildSteps: BuildStep[];
    artifacts: Artifact[];
}

// ============================================================================
// Guidance Types
// ============================================================================

export interface ProjectGuidance {
    conventions: string;
    structure: Record<string, unknown>;
    patterns: Record<string, unknown>;
    examples: Map<string, string>;
}
