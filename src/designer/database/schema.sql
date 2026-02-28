-- ============================================================================
-- Ansible Content Designer - Database Schema
-- ============================================================================
-- 
-- This schema defines the SQLite database structure for the Content Designer.
-- It is the single source of truth - Zod schemas are generated from this.
--
-- Reference: docs/ansible-content-designer-proposal.md
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ============================================================================
-- Project Metadata
-- ============================================================================

-- Project configuration (singleton - one row)
CREATE TABLE IF NOT EXISTS project (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    name TEXT NOT NULL,
    namespace TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('playbook_collection', 'collection', 'execution_environment')),
    description TEXT,
    phase TEXT NOT NULL DEFAULT 'intake' CHECK (phase IN ('intake', 'assessment', 'planning', 'building', 'complete')),
    -- Two-phase assessment: 'dependencies' (identify/install collections) then 'content' (detailed questions using plugin docs)
    assessment_stage TEXT DEFAULT 'dependencies' CHECK (assessment_stage IN ('dependencies', 'content')),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- Requirements (User Stories)
-- ============================================================================

-- Requirements (user stories)
-- Simplified: no priority (agent builds all), no implied artifacts (agent decides)
CREATE TABLE IF NOT EXISTS requirements (
    id TEXT PRIMARY KEY CHECK (id GLOB 'REQ-[0-9][0-9][0-9]' OR id GLOB 'SYS-[0-9][0-9][0-9]'),
    description TEXT NOT NULL CHECK (length(description) >= 20),
    status TEXT NOT NULL DEFAULT 'draft' 
        CHECK (status IN ('draft', 'assessed', 'planned', 'building', 'complete')),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by TEXT,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Tags for requirements
CREATE TABLE IF NOT EXISTS requirement_tags (
    requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
    tag TEXT NOT NULL CHECK (length(tag) >= 2),
    PRIMARY KEY (requirement_id, tag)
);

-- ============================================================================
-- Design Decisions (Assessment Q&A)
-- ============================================================================

-- Assessment Q&A decisions (linked to requirements)
-- Two-phase: 'dependencies' questions identify collections, 'content' questions use plugin docs
CREATE TABLE IF NOT EXISTS design_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
    question_id TEXT NOT NULL,
    category TEXT NOT NULL 
        CHECK (category IN (
            'architecture', 'security', 'compatibility', 
            'error_handling', 'idempotency', 'naming', 'testing',
            'dependencies'  -- New category for collection identification
        )),
    question TEXT NOT NULL,
    question_type TEXT DEFAULT 'text' 
        CHECK (question_type IN ('text', 'single_choice', 'multi_choice', 'yes_no', 'confirm')),
    choices TEXT,  -- JSON array of choices for single_choice/multi_choice
    suggested_default TEXT,
    answer TEXT,
    rationale TEXT,
    used_default BOOLEAN DEFAULT FALSE,
    answered_by TEXT,
    answered_at DATETIME,
    previous_answer TEXT,
    changed_at DATETIME,
    change_reason TEXT,
    -- Which assessment stage this question belongs to
    stage TEXT DEFAULT 'content' CHECK (stage IN ('dependencies', 'content')),
    UNIQUE (requirement_id, question_id)
);

-- Collections identified during dependency assessment
CREATE TABLE IF NOT EXISTS identified_collections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    requirement_id TEXT REFERENCES requirements(id) ON DELETE CASCADE,
    collection_fqcn TEXT NOT NULL,  -- e.g., 'hetzner.hcloud'
    reason TEXT,                     -- Why this collection is needed
    confirmed BOOLEAN DEFAULT FALSE, -- User confirmed we should use it
    installed BOOLEAN DEFAULT FALSE, -- Collection has been installed
    installed_at DATETIME,
    UNIQUE (collection_fqcn)
);

-- Project-wide decisions (apply to all requirements)
CREATE TABLE IF NOT EXISTS project_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    rationale TEXT,
    decided_by TEXT,
    decided_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (category, key)
);

-- Decision change history (audit trail)
CREATE TABLE IF NOT EXISTS decision_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    decision_id INTEGER REFERENCES design_decisions(id) ON DELETE CASCADE,
    requirement_id TEXT REFERENCES requirements(id) ON DELETE CASCADE,
    field TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    change_reason TEXT,
    changed_by TEXT,
    changed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- Implementation Plan
-- ============================================================================

-- Plan items (agent-proposed build steps)
-- type: 'scaffold' (ansible-creator), 'generate' (LLM content), 'install' (collection), 'configure'
-- description: JSON containing action details (creator_command, creator_args, file_path, etc.)
CREATE TABLE IF NOT EXISTS plan_items (
    id TEXT PRIMARY KEY CHECK (id GLOB 'ITEM-[0-9][0-9][0-9]' OR id GLOB 'COLL-*'),
    requirement_id TEXT REFERENCES requirements(id) ON DELETE CASCADE,
    type TEXT NOT NULL 
        CHECK (type IN ('scaffold', 'generate', 'install', 'configure')),
    name TEXT NOT NULL,
    description TEXT,  -- JSON with action details
    collection TEXT,
    collection_rationale TEXT,
    status TEXT NOT NULL DEFAULT 'proposed'
        CHECK (status IN ('proposed', 'needs_clarification', 'revised', 'approved', 'rejected', 'in_progress', 'complete', 'failed')),
    sequence INTEGER,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Plan item conversation history (tracks proposed → comment → revised → approved flow)
CREATE TABLE IF NOT EXISTS plan_item_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_item_id TEXT NOT NULL REFERENCES plan_items(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    entry_type TEXT NOT NULL 
        CHECK (entry_type IN ('proposed', 'comment', 'revised', 'approved', 'rejected')),
    content TEXT NOT NULL,
    by TEXT NOT NULL CHECK (by IN ('agent', 'user')),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- Build Execution
-- ============================================================================

-- Build substeps (progress tracking)
CREATE TABLE IF NOT EXISTS build_steps (
    id TEXT PRIMARY KEY,
    plan_item_id TEXT NOT NULL REFERENCES plan_items(id) ON DELETE CASCADE,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'in_progress', 'complete', 'failed', 'skipped')),
    output TEXT,
    artifact_path TEXT,
    started_at DATETIME,
    completed_at DATETIME
);

-- Generated artifacts
CREATE TABLE IF NOT EXISTS artifacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_item_id TEXT REFERENCES plan_items(id) ON DELETE CASCADE,
    path TEXT NOT NULL UNIQUE,
    content_hash TEXT,
    stale BOOLEAN DEFAULT FALSE,
    stale_reason TEXT,
    stale_since DATETIME,
    generated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- Workflow Progress & Governance
-- ============================================================================

-- Phase progress tracking (one row per phase)
CREATE TABLE IF NOT EXISTS phase_progress (
    phase TEXT PRIMARY KEY CHECK (phase IN ('intake', 'assessment', 'planning', 'building', 'complete')),
    status TEXT NOT NULL DEFAULT 'locked' 
        CHECK (status IN ('locked', 'available', 'in_progress', 'blocked', 'complete')),
    started_at DATETIME,
    completed_at DATETIME,
    total_items INTEGER DEFAULT 0,
    completed_items INTEGER DEFAULT 0,
    pending_items INTEGER DEFAULT 0,
    blocker_count INTEGER DEFAULT 0,
    blocker_summary TEXT
);

-- Sign-offs with cascade tracking
CREATE TABLE IF NOT EXISTS sign_offs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phase TEXT NOT NULL REFERENCES phase_progress(phase),
    signed_off_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    signed_off_by TEXT NOT NULL,
    notes TEXT,
    revoked_at DATETIME,
    revoked_by TEXT,
    revoke_reason TEXT,
    trigger_change_id INTEGER REFERENCES history(id)
);

-- ============================================================================
-- Drift Assessment
-- ============================================================================

-- Drift assessments
CREATE TABLE IF NOT EXISTS drift_assessments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    assessed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    assessed_by TEXT,
    total_requirements INTEGER,
    compliant INTEGER,
    drifted INTEGER,
    overall_compliance INTEGER,
    summary TEXT,
    report TEXT NOT NULL
);

-- Individual drift findings
CREATE TABLE IF NOT EXISTS drift_findings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    assessment_id INTEGER REFERENCES drift_assessments(id) ON DELETE CASCADE,
    requirement_id TEXT REFERENCES requirements(id),
    status TEXT NOT NULL CHECK (status IN ('compliant', 'drifted', 'partial')),
    expected TEXT,
    found TEXT,
    additions TEXT,
    removals TEXT,
    resolution TEXT CHECK (resolution IN ('pending', 'spec_updated', 'regenerated', 'flagged', 'dismissed')),
    resolution_note TEXT,
    resolved_at DATETIME,
    resolved_by TEXT
);

-- ============================================================================
-- History & Audit
-- ============================================================================

-- General history/audit log
CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    actor TEXT,
    details TEXT
);

-- Contributors
CREATE TABLE IF NOT EXISTS contributors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE,
    added_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- Future: AAP Integration
-- ============================================================================

-- AAP resource links (for future integration)
CREATE TABLE IF NOT EXISTS aap_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    aap_resource_type TEXT NOT NULL,
    aap_resource_id INTEGER NOT NULL,
    aap_instance_url TEXT NOT NULL,
    linked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (entity_type, entity_id, aap_resource_type, aap_instance_url)
);

-- ============================================================================
-- Indexes
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_requirements_status ON requirements(status);
CREATE INDEX IF NOT EXISTS idx_design_decisions_req ON design_decisions(requirement_id);
CREATE INDEX IF NOT EXISTS idx_design_decisions_pending ON design_decisions(answer) WHERE answer IS NULL;
CREATE INDEX IF NOT EXISTS idx_plan_items_req ON plan_items(requirement_id);
CREATE INDEX IF NOT EXISTS idx_plan_items_status ON plan_items(status);
CREATE INDEX IF NOT EXISTS idx_build_steps_item ON build_steps(plan_item_id);
CREATE INDEX IF NOT EXISTS idx_build_steps_status ON build_steps(status);
CREATE INDEX IF NOT EXISTS idx_artifacts_stale ON artifacts(stale) WHERE stale = TRUE;
CREATE INDEX IF NOT EXISTS idx_sign_offs_phase ON sign_offs(phase, revoked_at);
CREATE INDEX IF NOT EXISTS idx_history_timestamp ON history(timestamp);
CREATE INDEX IF NOT EXISTS idx_history_entity ON history(entity_type, entity_id);

-- ============================================================================
-- Triggers
-- ============================================================================

-- Update requirements.updated_at on modification
CREATE TRIGGER IF NOT EXISTS update_requirements_timestamp 
    AFTER UPDATE ON requirements
BEGIN
    UPDATE requirements SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

-- Update project.updated_at on modification
CREATE TRIGGER IF NOT EXISTS update_project_timestamp
    AFTER UPDATE ON project
BEGIN
    UPDATE project SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

-- Log decision changes to history
CREATE TRIGGER IF NOT EXISTS log_decision_changes 
    AFTER UPDATE ON design_decisions
    WHEN OLD.answer IS NOT NULL AND OLD.answer != NEW.answer
BEGIN
    INSERT INTO decision_history (decision_id, requirement_id, field, old_value, new_value, changed_by, changed_at)
    VALUES (NEW.id, NEW.requirement_id, 'answer', OLD.answer, NEW.answer, NEW.answered_by, CURRENT_TIMESTAMP);
END;

-- ============================================================================
-- Initial Data
-- ============================================================================

-- Initialize phase progress (run once on database creation)
INSERT OR IGNORE INTO phase_progress (phase, status) VALUES
    ('intake', 'in_progress'),
    ('assessment', 'locked'),
    ('planning', 'locked'),
    ('building', 'locked'),
    ('complete', 'locked');
