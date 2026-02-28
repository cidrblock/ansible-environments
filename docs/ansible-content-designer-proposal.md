# Ansible Content Designer - Design Proposal

## Executive Summary

A Spec-Driven Development (SDD) approach to Ansible content creation that guides users through a structured, multi-phase workflow—from requirements to fully generated Ansible playbooks, roles, and collections. The Content Designer operates entirely through VS Code webviews (no chat interaction required) with an AI agent orchestrating the work behind the scenes.

**Key Differentiators:**
- **Project-type aligned** - Scaffolds only what `ansible-creator` supports (playbook+collection, standalone collection, execution environment)
- **Structured data** - SQLite database as source of truth with schema enforcement
- **AI guidance integration** - Leverages `ansible-creator add ai` patterns throughout
- **SCM-friendly** - Database + human-readable exports designed for version control
- **Resumable** - Any user can pick up the project years later

---

## Goals

1. **Guided Content Creation** - Transform user requirements into production-ready Ansible content
2. **Collaborative Refinement** - Multi-round Q&A between agent and user for clarity
3. **Resumable Sessions** - Persist state for long-running or interrupted workflows
4. **Best Practices Enforcement** - Leverage ansible-creator patterns and curated collection recommendations
5. **Full Visibility** - Real-time progress tracking through dedicated UI
6. **Future AAP Integration** - Design data can be exposed to Ansible Automation Platform

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         Webview UI                              │
│   Tree View (sidebar)  │  Main Panel (context-sensitive forms) │
└──────────────────────────────┬──────────────────────────────────┘
                               │ postMessage
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Extension Host                             │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  Orchestrator                                           │    │
│  │  - Handles button clicks from webview                   │    │
│  │  - Constructs prompts with session context              │    │
│  │  - Invokes LLM via vscode.lm API                        │    │
│  │  - Validates responses with Zod schemas                 │    │
│  │  - Pushes updates back to webview                       │    │
│  └─────────────────────────────────────────────────────────┘    │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  Service Layer                                          │    │
│  │  - Schema validation (Zod + SQL constraints)            │    │
│  │  - Database operations (better-sqlite3)                 │    │
│  │  - Export generation (YAML/Markdown)                    │    │
│  │  - Guidance context loading                             │    │
│  └─────────────────────────────────────────────────────────┘    │
└──────────────────────────────┬──────────────────────────────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
      ┌───────────┐    ┌───────────┐    ┌───────────┐
      │  LLM API  │    │MCP Server │    │  design/  │
      │ (Copilot) │    │  (tools)  │    │ design.db │
      └───────────┘    └───────────┘    └───────────┘
```

### The AI Playbook Paradigm

The Content Designer is built around the **AI Playbook** paradigm: we provide the agent with everything it needs to succeed, and it autonomously determines what to build and how to build it.

**What we provide:**
- Requirements and design decisions (from user)
- Best practices and guidance (from `ansible-creator add ai`)
- Available MCP tools with their schemas (from extension)
- Human feedback loop (approve/comment/revise)

**What the agent does:**
1. Analyzes requirements and context
2. Creates its own execution plan using available tools
3. Executes that plan autonomously
4. Self-corrects when errors occur
5. Reports progress to the human

### Agent Execution Flow

```
Human provides requirements
         ↓
   [Intake Phase]
         ↓
Human answers assessment questions
         ↓
   [Assessment Phase]
         ↓
Agent creates execution plan using available tools
         ↓
Human reviews/approves plan
         ↓
   [Planning Phase]
         ↓
Agent executes plan autonomously:
  1. Tool call → Result
  2. If error → Agent self-corrects
  3. Repeat until complete
         ↓
   [Building Phase]
         ↓
Human reviews generated content
         ↓
   [Complete]
```

### Tools Available to the Agent

| Tool | Purpose |
|------|---------|
| `write_file` | Create playbooks, roles, templates, vars files |
| `ac_init_*` | Scaffold projects/roles via ansible-creator |
| `ac_add_*` | Add resources via ansible-creator |
| `search_collections` | Find relevant Ansible collections |
| `get_plugin_docs` | Get module/plugin documentation |
| `validate_yaml` | Run ansible-lint for validation |
| `install_collection` | Install collections from Galaxy |

The agent plans which tools to use and in what order based on the requirements and context.

### Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| State Storage | SQLite (`design.db`) | Schema enforcement, relational integrity, fast queries, small file size |
| Storage Location | `design/` directory | SCM-friendly, visible (not hidden), adjacent to content |
| UI | VS Code Webviews | No chat interaction needed, guided workflow |
| Schema Source of Truth | Database (SQL) | Zod/JSON schemas generated from DB, no sync issues |
| Agent Data Access | `query_design_db` MCP tool | Agent queries what it needs vs. large context dumps |
| Human-readable Export | Generated YAML in `design/export/` | Code review friendly, disaster recovery |
| Tool Integration | Embedded in existing MCP server | Faster iteration, direct access to collection tools |
| Agent Communication | Programmatic via extension | User interacts only with webview, extension orchestrates LLM calls |

---

## Directory Structure

```
myproject/
├── design/                          # Content Designer metadata
│   ├── design.db                    # SQLite: Source of Truth (in SCM)
│   ├── schema.sql                   # Schema reference
│   │
│   ├── guidance/                    # AI guidance (from ansible-creator add ai)
│   │   ├── CONVENTIONS.md           # Human/AI readable rules
│   │   ├── structure.yaml           # Project structure schema
│   │   ├── patterns.yaml            # Code patterns to follow
│   │   └── examples/                # Reference implementations
│   │
│   └── export/                      # Human-readable views (generated)
│       ├── README.md                # Project overview
│       ├── project.yaml             # Project metadata
│       ├── decisions.yaml           # Project-wide decisions
│       ├── requirements/
│       │   ├── index.yaml           # Requirements manifest
│       │   ├── REQ-001.yaml         # Exported requirement with decisions
│       │   └── ...
│       ├── plan/
│       │   └── items.yaml           # All plan items
│       └── history/
│           └── audit.yaml           # Recent history
│
├── playbooks/                       # Generated content
├── collections/
│   └── ansible_collections/
│       └── myorg/
│           └── myproject/           # Adjacent collection
└── ...
```

---

## Workflow Phases

### Phase 0: Project Initialization

User selects project type aligned with `ansible-creator` capabilities:

```
┌─────────────────────────────────────────────────────────────────┐
│  ANSIBLE CONTENT DESIGNER - NEW PROJECT                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  What are you building?                                         │
│                                                                 │
│  ○ Playbook Project with Adjacent Collection                    │
│    A playbook project with its own collection for               │
│    custom roles, modules, and plugins                           │
│    → ansible-creator init playbook --collection                 │
│                                                                 │
│  ○ Standalone Collection                                        │
│    A reusable collection with roles, modules,                   │
│    plugins, and documentation                                   │
│    → ansible-creator init collection                            │
│                                                                 │
│  ○ Execution Environment                                        │
│    A container image definition with specific                   │
│    collections, Python packages, and system deps                │
│    → ansible-creator init ee                                    │
│                                                                 │
│  Project name: [my_automation_project_________]                 │
│  Namespace:    [myorg_______] (for collection FQCN)            │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Actions:**
- Scaffold project with `ansible-creator`
- Generate AI guidance with `ansible-creator add ai`
- Initialize `design/design.db`

---

### Phase 1: Requirements Intake

User provides requirements in simplified, constrained format (no freeform "As a..." stories):

```
┌─────────────────────────────────────────────────────────────────┐
│  ADD REQUIREMENT                           Project: my_project  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  I need automation that...                                      │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ deploys and configures nginx web servers with SSL       │   │
│  │ termination, virtual hosts, and load balancing          │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  This will likely require:  (suggestions, editable)            │
│  ☑ A playbook                                                  │
│  ☑ A role in the adjacent collection                           │
│  ☐ Custom module(s)                                            │
│  ☐ Custom filter plugin(s)                                     │
│  ☐ Templates                                                   │
│                                                                 │
│  Priority: [High ▼]    Tags: [web] [nginx] [+]                 │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Artifact options are constrained by project type:**
- Playbook+Collection: playbook, role, module, plugin, template, vars_file
- Standalone Collection: role, module, module_utils, filter_plugin, lookup_plugin, inventory_plugin, test
- Execution Environment: ee_definition (single artifact with dependencies)

**Actions:**
- `[Add Requirement]` - Validated insert to database
- `[Assess →]` - Triggers agent review, moves to Phase 2

---

### Phase 2: Assessment

Agent reviews requirements and asks clarifying questions. **Iterative loop until requirements are clear.**

```
┌─────────────────────────────────────────────────────────────────┐
│  ASSESSMENT - Clarifying Questions              Round 1 of ?   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ━━━━ 🔒 SECURITY (2 questions) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                                 │
│  Q-001: How should SSL certificates be managed?                 │
│  Related to: REQ-001 (nginx deployment)                         │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ ○ Let's Encrypt with automatic renewal ⭐ Suggested     │   │
│  │ ○ Pre-existing certificates from control node           │   │
│  │ ○ Certificates from HashiCorp Vault                     │   │
│  │ ○ Self-signed for internal/development                  │   │
│  └─────────────────────────────────────────────────────────┘   │
│  ℹ️ Certificate management affects security posture and         │
│     operational overhead...                                     │
│                                                                 │
│  ━━━━ 🏗️ ARCHITECTURE (1 question) ━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                                 │
│  Q-002: Monolithic or modular nginx configuration?              │
│  ○ Monolithic template  ○ Modular includes ⭐ Suggested        │
│                                                                 │
│  ──────────────────────────────────────────────────────────────│
│  [Use All Suggested Defaults]                                   │
│                        [Save & Continue →]                      │
└─────────────────────────────────────────────────────────────────┘
```

**Question Categories:**
- `architecture` - Structural decisions
- `security` - Security considerations
- `compatibility` - OS, versions, dependencies
- `error_handling` - Failure behavior
- `idempotency` - Re-run behavior
- `naming` - Conventions
- `testing` - Validation approach

**Question Types:**
- `text` - Free-form answer
- `single_choice` - Radio buttons
- `multi_choice` - Checkboxes
- `yes_no` - Boolean
- `confirm` - Suggested value confirmation

**Iterative Loop:**
1. Agent analyzes requirements, generates questions
2. User answers (or accepts defaults)
3. Agent reviews answers, may ask follow-ups
4. Repeat until `assessment_complete: true`

**Answers are merged back into requirements as `design_decisions`.**

---

### Phase 3: Implementation Plan

Agent generates detailed implementation plan. User reviews and approves.

```
┌─────────────────────────────────────────────────────────────────┐
│  IMPLEMENTATION PLAN                                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Based on your requirements and design decisions:               │
│                                                                 │
│  📦 COLLECTIONS TO USE                                          │
│  ├── community.general (installed)                              │
│  │   └── Rationale: certbot modules for Let's Encrypt          │
│  └── ansible.posix (needs install)                              │
│      └── Rationale: firewalld management                        │
│                                                                 │
│  📋 PLAN ITEMS                                                  │
│  ├── ✅ ITEM-001: nginx role                                    │
│  │   └── Implements: REQ-001                                    │
│  ├── ✅ ITEM-002: deploy_webservers.yml playbook               │
│  │   └── Implements: REQ-001                                    │
│  ├── 🔄 ITEM-003: SSL certificate handling                      │
│  │   └── Implements: REQ-001 (security decision)               │
│  └── ⏳ ITEM-004: molecule tests                                │
│      └── Testing for: ITEM-001                                  │
│                                                                 │
│  [Regenerate Plan]  [Request Changes]  [Approve Plan ✓]        │
└─────────────────────────────────────────────────────────────────┘
```

**Agent Activities:**
- Searches collections via `search_available_collections`
- Retrieves plugin docs via `get_plugin_documentation`
- Maps requirements + decisions to concrete artifacts
- Identifies dependencies between items

**Actions:**
- `[Regenerate]` - Request changes, agent revises
- `[Approve Plan ✓]` - Locks plan, moves to Phase 4

---

### Phase 4: Build Execution

**Goal:** Generate world-class, enterprise-grade Ansible content that follows industry best practices, leveraging all available MCP tools, Galaxy collections, and plugin documentation.

The build phase is an **iterative expert system** that:
1. Uses `ansible-creator` for proper project scaffolding
2. Researches appropriate collections and plugins via MCP tools
3. Generates production-quality content with rich context
4. Validates and iterates until requirements are met (max 5 iterations)

```
┌─────────────────────────────────────────────────────────────────┐
│  BUILD ORCHESTRATOR - ITERATIVE GENERATION ENGINE               │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  1. SCAFFOLD                                              │   │
│  │     └─ Run create_ansible_projects MCP tool               │   │
│  │        (ansible-creator init playbook/collection)         │   │
│  └──────────────────────────────────────────────────────────┘   │
│                          ↓                                      │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  2. FOR EACH PLAN ITEM (Iterative Loop):                  │   │
│  │                                                           │   │
│  │     a. RESEARCH                                           │   │
│  │        ├─ search_available_collections (find relevant)    │   │
│  │        ├─ get_collection_plugins (list what's available)  │   │
│  │        ├─ get_plugin_documentation (understand params)    │   │
│  │        └─ Load design/guidance/* (project conventions)    │   │
│  │                                                           │   │
│  │     b. GENERATE                                           │   │
│  │        Build context-rich prompt with:                    │   │
│  │        ├─ Requirement + assessment answers                │   │
│  │        ├─ Actual plugin documentation (not guessed)       │   │
│  │        ├─ Best practices from guidance files              │   │
│  │        ├─ Examples from existing project content          │   │
│  │        └─ Project structure context                       │   │
│  │                                                           │   │
│  │     c. VALIDATE                                           │   │
│  │        ├─ Write content to file                           │   │
│  │        ├─ Run ansible-lint                                │   │
│  │        ├─ Check YAML syntax                               │   │
│  │        └─ Verify module parameters match docs             │   │
│  │                                                           │   │
│  │     d. ITERATE (max 5 rounds per item)                    │   │
│  │        IF validation fails:                               │   │
│  │        ├─ Feed lint errors back to LLM                    │   │
│  │        ├─ Include plugin docs for correct usage           │   │
│  │        └─ Regenerate with corrections                     │   │
│  │        ELSE: Mark complete, move to next item             │   │
│  └──────────────────────────────────────────────────────────┘   │
│                          ↓                                      │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  3. FINALIZE                                              │   │
│  │     ├─ Run full project ansible-lint                      │   │
│  │     ├─ Generate/update requirements.yml with collections  │   │
│  │     ├─ Install missing collections                        │   │
│  │     ├─ Run ansible-creator add ai --refresh               │   │
│  │     └─ Export final design artifacts                      │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**MCP Tools Used During Build:**

| Tool | Purpose |
|------|---------|
| `create_ansible_projects` | Scaffold playbook/collection with ansible-creator |
| `search_available_collections` | Find relevant collections for each task |
| `get_collection_plugins` | List available modules, filters, lookups |
| `get_plugin_documentation` | Get exact parameter specs for module usage |
| `install_ansible_collection` | Install dependencies as needed |
| `ansible_lint` | Validate generated content |
| `get_ansible_creator_schema` | Understand available scaffolding options |

**Enterprise-Grade Quality Standards:**

1. **Correct Module Usage** - Parameters match official documentation
2. **Proper Error Handling** - Block/rescue patterns where appropriate
3. **Idempotency** - All tasks are safe to re-run
4. **Security** - No plaintext secrets, proper file permissions
5. **Documentation** - Role README, inline comments, variable descriptions
6. **Testing** - Molecule test scaffolding included

**UI Progress Display:**

```
┌─────────────────────────────────────────────────────────────────┐
│  BUILD PROGRESS                                           5/8   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ✅ ITEM-001: nginx role                                        │
│     ├── ✅ Scaffolded role structure (ansible-creator)          │
│     ├── ✅ Researched: nginx_core, community.general            │
│     ├── ✅ Generated tasks/main.yml (iteration 1/5)             │
│     ├── ✅ Validated with ansible-lint                          │
│     └── ✅ Generated handlers, defaults, README                 │
│                                                                 │
│  🔄 ITEM-002: deploy_webservers.yml                             │
│     ├── ✅ Generated playbook structure                         │
│     ├── ⚠️ Iteration 2/5 - Fixing: "ansible.builtin.copy        │
│     │       missing 'mode' parameter"                           │
│     └── 🔄 Regenerating with corrections...                     │
│                                                                 │
│  ⏳ ITEM-003: SSL certificate handling                          │
│  ⏳ ITEM-004: molecule tests                                    │
│                                                                 │
│  ──────────────────────────────────────────────────────────────│
│  [Pause]  [View Logs]  [Open Artifact]                         │
└─────────────────────────────────────────────────────────────────┘
```

**Actions:**
- `[Pause]` - Halt execution, resume later
- `[View Logs]` - See detailed LLM interactions and lint output
- `[Open Artifact]` - Open generated file in editor

---

### Phase 5: Drift Assessment (On-Demand)

After content is generated (and potentially modified manually over time), users can trigger an **agent-based assessment** to verify content still matches the original specifications.

```
┌─────────────────────────────────────────────────────────────────┐
│  DRIFT ASSESSMENT REPORT                                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Last assessed: 2026-03-15 by jane@example.com                 │
│  Overall compliance: 85%                                        │
│                                                                 │
│  ✓ REQ-001: nginx deployment - COMPLIANT                       │
│    ├── SSL termination: ✓ implemented as specified             │
│    ├── Load balancing: ✓ implemented as specified              │
│    └── Modular config: ✓ uses sites-available pattern          │
│                                                                 │
│  ⚠ REQ-002: database setup - DRIFTED                           │
│    ├── Replication: ✗ REMOVED (was in design decisions)        │
│    ├── Backup config: + ADDED (not in original spec)           │
│    └── [Review Finding]                                         │
│                                                                 │
│  ✓ REQ-003: monitoring - COMPLIANT                             │
│                                                                 │
│  [Export Report]  [Assess Again]                               │
└─────────────────────────────────────────────────────────────────┘
```

**What the agent checks:**
- Does each artifact still implement its requirement?
- Are all design decisions reflected in the code?
- Has functionality been added that wasn't specified?
- Has specified functionality been removed?

**Resolution workflow for drift findings:**

```
┌─────────────────────────────────────────────────────────────────┐
│  DRIFT FINDING: REQ-002 - Database replication                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Decision: "Database replication enabled"                       │
│  Expected: PostgreSQL streaming replication configured          │
│  Found: Single-node configuration, no replication              │
│                                                                 │
│  Resolution options:                                            │
│  ○ Update spec - Replication no longer required                │
│  ○ Regenerate - Restore replication (agent rebuilds)           │
│  ○ Flag for review - Add to backlog                            │
│  ○ Dismiss - Intentional change, acknowledge                   │
│                                                                 │
│  Note: [Optional explanation_______________________]            │
│                                           [Apply Resolution]    │
└─────────────────────────────────────────────────────────────────┘
```

**Benefits over hash-based detection:**
- Understands semantic changes, not just file modifications
- Low false positives (ignores formatting, comments)
- Provides actionable recommendations
- Creates audit trail of acknowledged changes

---

## AI Guidance Integration

The `ansible-creator add ai` guidance is injected into **every agent interaction**:

```typescript
class ContentDesignerOrchestrator {
  private guidance: ProjectGuidance;

  async loadGuidance(): Promise<void> {
    this.guidance = {
      conventions: await fs.readFile('design/guidance/CONVENTIONS.md', 'utf-8'),
      structure: yaml.load(await fs.readFile('design/guidance/structure.yaml', 'utf-8')),
      patterns: yaml.load(await fs.readFile('design/guidance/patterns.yaml', 'utf-8')),
      examples: await this.loadExamples('design/guidance/examples/')
    };
  }

  async callAgent(taskPrompt: string, schema: z.ZodSchema): Promise<unknown> {
    const fullPrompt = `
## Project Conventions (MUST FOLLOW)
${this.guidance.conventions}

## Project Structure
\`\`\`yaml
${yaml.dump(this.guidance.structure)}
\`\`\`

## Code Patterns
\`\`\`yaml
${yaml.dump(this.guidance.patterns)}
\`\`\`

---

## Current Task
${taskPrompt}
`;
    
    return this.callLLMWithSchema(fullPrompt, schema);
  }
}
```

**Guidance is refreshed after builds** to capture new patterns from generated content.

---

## Agent Response Validation

All agent responses are validated with Zod schemas **generated from the database schema** - single source of truth:

```typescript
// Schemas are generated from SQLite, not hardcoded
class SchemaGenerator {
  generateTableSchema(tableName: string): z.ZodObject<any> {
    const columns = this.db.prepare(`PRAGMA table_info(${tableName})`).all();
    const tableSQL = this.getTableSQL(tableName);
    const checkConstraints = this.parseCheckConstraints(tableSQL);
    
    const shape: Record<string, ZodTypeAny> = {};
    for (const col of columns) {
      shape[col.name] = this.columnToZod(col, checkConstraints);
    }
    return z.object(shape);
  }
  
  // SQL CHECK constraints → Zod validators
  // CHECK (status IN ('draft', 'assessed')) → z.enum(['draft', 'assessed'])
  // CHECK (id GLOB 'REQ-[0-9][0-9][0-9]') → z.string().regex(/^REQ-\d{3}$/)
  // CHECK (length(description) >= 20) → z.string().min(20)
}
```

**Benefits:**
- Database schema is the single source of truth
- No sync issues between SQL constraints and Zod schemas
- MCP tool descriptions include live schema
- TypeScript types can be generated for development

```typescript
async function callLLMWithSchema<T>(
  prompt: string,
  schema: z.ZodSchema<T>,
  maxRetries = 3
): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const response = await vscodeLanguageModelCall(prompt);
    
    try {
      const json = JSON.parse(extractJson(response));
      return schema.parse(json);  // Throws ZodError if invalid
    } catch (error) {
      if (attempt === maxRetries) {
        throw new Error(`Schema validation failed after ${maxRetries} attempts`);
      }
      // Add error feedback for retry
      prompt += `\n\nValidation errors:\n${error.message}\nPlease fix.`;
    }
  }
}
```

---

## Agent Data Access: Query Tool

Instead of passing large context windows to the agent, provide a **read-only SQL query tool**. The agent fetches what it needs, when it needs it.

### MCP Tool: `query_design_db`

```typescript
const QUERY_DESIGN_DB_TOOL = {
  name: 'query_design_db',
  description: `
    Execute a read-only SQL query against the Content Designer database.
    Use this to fetch requirements, design decisions, plan items, and project state.
    
    Example queries:
    - "SELECT * FROM requirements WHERE status = 'draft'"
    - "SELECT * FROM design_decisions WHERE requirement_id = 'REQ-001'"
    - "SELECT * FROM project_decisions WHERE category = 'compatibility'"
  `,
  inputSchema: {
    type: 'object',
    required: ['query'],
    properties: {
      query: { type: 'string', description: 'SQL SELECT query (read-only)' },
      limit: { type: 'number', default: 100, maximum: 1000 }
    }
  }
};
```

### Safety Guarantees

```typescript
executeReadonlyQuery(sql: string, limit: number): QueryResult {
  // 1. Validate SELECT only
  if (!sql.trim().toLowerCase().startsWith('select')) {
    throw new Error('Only SELECT queries are allowed');
  }
  
  // 2. Block dangerous keywords
  const forbidden = ['insert', 'update', 'delete', 'drop', 'alter', 'create'];
  // ...
  
  // 3. Use read-only database connection
  // 4. Enforce result size limits
  // 5. Timeout long queries
  // 6. Audit log all queries
}
```

### Agent Workflow (Query-Based)

Instead of dumping all context upfront:

```
# OLD: Huge context window
[ALL requirements, ALL decisions, ALL guidance...]
Now generate assessment questions.

# NEW: Agent queries what it needs
You have access to query_design_db. Your task: Generate assessment questions.

Agent: [Calls query_design_db]
       "SELECT * FROM project"
       → Understands project type

Agent: [Calls query_design_db]  
       "SELECT * FROM requirements WHERE status = 'draft'"
       → Gets draft requirements

Agent: [Calls query_design_db]
       "SELECT * FROM project_decisions WHERE category = 'compatibility'"
       → Checks existing decisions to avoid redundant questions
       
Agent: Now generates targeted questions...
```

### MCP Resources: Schema Access

```typescript
const resources = [
  { uri: 'designer://schema/sql', name: 'SQL Schema' },
  { uri: 'designer://schema/json', name: 'JSON Schema (for validation)' },
  { uri: 'designer://schema/examples', name: 'Example Queries' }
];
```

### Benefits

| Aspect | Context Dump | Query Tool |
|--------|--------------|------------|
| Token usage | High | Low (fetch as needed) |
| Flexibility | Fixed | Agent explores data |
| Relevance | Includes unused data | Agent fetches what matters |
| Complex queries | Manual filtering | SQL handles it |

---

## Database Schema

```sql
-- design/schema.sql

-- Project metadata (singleton)
CREATE TABLE project (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    name TEXT NOT NULL,
    namespace TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('playbook_collection', 'collection', 'execution_environment')),
    description TEXT,
    phase TEXT NOT NULL DEFAULT 'intake' CHECK (phase IN ('intake', 'assessment', 'planning', 'building', 'complete')),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Requirements (constrained format)
CREATE TABLE requirements (
    id TEXT PRIMARY KEY CHECK (id GLOB 'REQ-[0-9][0-9][0-9]'),
    description TEXT NOT NULL CHECK (length(description) >= 20),
    status TEXT NOT NULL DEFAULT 'draft' 
        CHECK (status IN ('draft', 'assessed', 'planned', 'building', 'complete')),
    priority TEXT NOT NULL DEFAULT 'medium'
        CHECK (priority IN ('low', 'medium', 'high', 'critical')),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by TEXT,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Implied artifacts per requirement (constrained by project type)
CREATE TABLE requirement_artifacts (
    requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
    artifact_type TEXT NOT NULL 
        CHECK (artifact_type IN ('playbook', 'role', 'module', 'module_utils', 'filter_plugin', 'lookup_plugin', 'inventory_plugin', 'template', 'vars_file', 'test', 'ee_definition')),
    PRIMARY KEY (requirement_id, artifact_type)
);

-- Tags
CREATE TABLE requirement_tags (
    requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
    tag TEXT NOT NULL CHECK (length(tag) >= 2),
    PRIMARY KEY (requirement_id, tag)
);

-- Design decisions (assessment answers merged into requirements)
CREATE TABLE design_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
    category TEXT NOT NULL 
        CHECK (category IN ('architecture', 'security', 'compatibility', 'error_handling', 'idempotency', 'naming', 'testing')),
    question_id TEXT NOT NULL,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    rationale TEXT,
    used_default BOOLEAN DEFAULT FALSE,
    answered_by TEXT,
    answered_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Project-wide decisions (apply to all requirements)
CREATE TABLE project_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,  -- JSON for complex values
    rationale TEXT,
    UNIQUE (category, key)
);

-- Plan items
CREATE TABLE plan_items (
    id TEXT PRIMARY KEY CHECK (id GLOB 'ITEM-[0-9][0-9][0-9]'),
    requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
    type TEXT NOT NULL 
        CHECK (type IN ('playbook', 'role', 'module', 'module_utils', 'filter_plugin', 'lookup_plugin', 'template', 'vars_file', 'test')),
    name TEXT NOT NULL,
    description TEXT,
    collection TEXT,              -- Recommended collection
    collection_rationale TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'in_progress', 'complete', 'failed')),
    sequence INTEGER,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Build substeps (progress tracking)
CREATE TABLE build_steps (
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
CREATE TABLE artifacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_item_id TEXT REFERENCES plan_items(id) ON DELETE CASCADE,
    path TEXT NOT NULL UNIQUE,
    content_hash TEXT,  -- For detecting manual edits
    generated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- History/audit log
CREATE TABLE history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    action TEXT NOT NULL,  -- 'create', 'update', 'delete', 'build', 'export'
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    actor TEXT,
    details TEXT  -- JSON
);

-- Contributors
CREATE TABLE contributors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE,
    added_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Drift assessments
CREATE TABLE drift_assessments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    assessed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    assessed_by TEXT,
    total_requirements INTEGER,
    compliant INTEGER,
    drifted INTEGER,
    overall_compliance INTEGER,  -- Percentage 0-100
    summary TEXT,
    report TEXT NOT NULL  -- Full JSON report
);

-- Individual drift findings
CREATE TABLE drift_findings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    assessment_id INTEGER REFERENCES drift_assessments(id) ON DELETE CASCADE,
    requirement_id TEXT REFERENCES requirements(id),
    status TEXT NOT NULL CHECK (status IN ('compliant', 'drifted', 'partial')),
    expected TEXT,
    found TEXT,
    additions TEXT,  -- JSON array of added features
    removals TEXT,   -- JSON array of removed features
    resolution TEXT CHECK (resolution IN ('pending', 'spec_updated', 'regenerated', 'flagged', 'dismissed')),
    resolution_note TEXT,
    resolved_at DATETIME,
    resolved_by TEXT
);

-- AAP integration (future)
CREATE TABLE aap_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    aap_resource_type TEXT NOT NULL,
    aap_resource_id INTEGER NOT NULL,
    aap_instance_url TEXT NOT NULL,
    linked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (entity_type, entity_id, aap_resource_type, aap_instance_url)
);

-- Indexes
CREATE INDEX idx_requirements_status ON requirements(status);
CREATE INDEX idx_design_decisions_req ON design_decisions(requirement_id);
CREATE INDEX idx_plan_items_req ON plan_items(requirement_id);
CREATE INDEX idx_build_steps_item ON build_steps(plan_item_id);
CREATE INDEX idx_history_timestamp ON history(timestamp);

-- Triggers for updated_at
CREATE TRIGGER update_requirements_timestamp 
    AFTER UPDATE ON requirements
BEGIN
    UPDATE requirements SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

CREATE TRIGGER update_project_timestamp
    AFTER UPDATE ON project
BEGIN
    UPDATE project SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;
```

**File Location:** `design/design.db`

**Size Estimate:** < 1MB even for large projects (metadata only, not content)

---

## Export Layer (Human-Readable)

Generated from database on every write:

```yaml
# design/export/requirements/REQ-001.yaml
# Auto-generated from design.db - DO NOT EDIT DIRECTLY

id: REQ-001
title: Nginx Web Server Deployment
status: complete
priority: high

description: |
  Deploy and configure nginx web servers with SSL termination,
  virtual hosts for staging and production, and load balancing.

implied_artifacts:
  - playbook
  - role
  - template

tags:
  - web
  - nginx
  - ssl

design_decisions:
  architecture:
    - question: "Configuration style?"
      answer: "Modular includes (sites-available pattern)"
      rationale: "Easier to manage multiple virtual hosts"
      
  security:
    - question: "SSL certificate management?"
      answer: "Let's Encrypt with automatic renewal"
      rationale: "Free, automated, well-supported"

planned_items:
  - ITEM-001  # nginx role
  - ITEM-002  # deploy_webservers.yml

artifacts:
  - roles/nginx/
  - playbooks/deploy_webservers.yml

metadata:
  created_at: 2026-01-20T10:35:00Z
  created_by: jane@example.com
  updated_at: 2026-01-22T16:00:00Z
```

---

## Resumability

When a new user opens an existing project:

```
┌─────────────────────────────────────────────────────────────────┐
│  ANSIBLE CONTENT DESIGNER                                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  📂 Found existing project: my_automation_project               │
│                                                                 │
│  Type: Playbook with Adjacent Collection                        │
│  Phase: Complete                                                │
│  Requirements: 8 (all complete)                                 │
│  Last activity: 2026-03-15 by john@example.com                 │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 📋 View Existing Requirements                           │   │
│  │ ➕ Add New Requirement                                   │   │
│  │ 📊 View Project Summary                                  │   │
│  │ 🔧 Modify Project Decisions                              │   │
│  │ 🔄 Assess Drift (last: 5 days ago)                      │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ℹ️ Project conventions will apply to new requirements.         │
│     See design/export/decisions.yaml for details.              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Sidebar tree view:**

```
📁 Content Designer
├── 📋 Requirements [8]
│   ├── ✅ REQ-001: nginx deployment
│   ├── ✅ REQ-002: database setup
│   └── ...
├── 🔍 Assessment [complete]
├── 📝 Plan [12 items - all complete]
├── 🔨 Build [complete]
└── 🔄 Drift [last: 5 days ago]
    └── ⚠ 1 finding needs review
```

**New requirements inherit:**
- Project-wide decisions (OS targets, conventions, etc.)
- AI guidance patterns
- Existing collection preferences

---

## Offline Mode

When LLM is unavailable:

```
┌─────────────────────────────────────────────────────────────────┐
│  ⚠️ OFFLINE MODE                                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  AI features are unavailable. You can still:                    │
│                                                                 │
│  ✓ View existing requirements and decisions                     │
│  ✓ Add new requirements (assessment deferred)                   │
│  ✓ View generated artifacts                                     │
│  ✓ Export to YAML                                               │
│                                                                 │
│  ✗ Assessment questions (requires AI)                           │
│  ✗ Plan generation (requires AI)                                │
│  ✗ Content generation (requires AI)                             │
│                                                                 │
│  Requirements added offline will be queued for assessment       │
│  when AI becomes available.                                     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Future: AAP Integration

Design data can be synced to Ansible Automation Platform:

```typescript
interface AAPIntegration {
  // Sync requirements as project documentation
  syncRequirementsToProject(projectId: number): Promise<void>;
  
  // Link playbooks to job templates
  linkPlaybookToJobTemplate(playbookPath: string, templateId: number): Promise<void>;
  
  // Traceability: requirement → playbook → job template → execution
  getExecutionHistory(requirementId: string): Promise<ExecutionRecord[]>;
  
  // Push EE definition to Automation Hub
  publishExecutionEnvironment(eeId: string): Promise<void>;
}
```

---

## Implementation Phases

### Phase 1: Foundation (Weeks 1-4)
- [ ] Database schema + service layer
- [ ] Project initialization flow
- [ ] Requirements intake UI
- [ ] Basic tree view

### Phase 2: Assessment (Weeks 5-8)
- [ ] Agent prompt construction with guidance
- [ ] Zod schema validation
- [ ] Q&A UI with categories
- [ ] Design decisions merge-back

### Phase 3: Planning (Weeks 9-12)
- [ ] Collection search integration
- [ ] Plan generation with rationale
- [ ] Plan approval workflow
- [ ] Dependency tracking

### Phase 4: Build (Weeks 13-16)
- [ ] ansible-creator integration
- [ ] Content generation with guidance
- [ ] Progress tracking with substeps
- [ ] Artifact linking

### Phase 5: Polish (Weeks 17-20)
- [ ] Export layer refinement
- [ ] Offline mode
- [ ] Resumability testing
- [ ] Documentation

---

## Design Decisions (Resolved)

| Question | Decision | Rationale |
|----------|----------|-----------|
| SOT storage | SQLite (`design.db`) | Schema enforcement, small file, SCM-friendly |
| Directory location | `design/` (visible) | Not hidden, adjacent to content |
| User story format | Constrained "I need automation that..." | Aligned with ansible-creator capabilities |
| Schema source of truth | Database (SQL constraints) | Zod/JSON schemas generated programmatically |
| Agent data access | Read-only SQL query tool | Efficient token usage, agent fetches what it needs |
| Agent validation | Zod schemas (generated from DB) | Single source of truth, no sync issues |
| AI guidance | `ansible-creator add ai` in `design/guidance/` | Injected into every prompt |
| Spec-by-example | Plugin examples from ansible-doc | Few-shot prompting built into existing tooling |
| Drift detection | Agent-based semantic assessment | Understands intent, not just file changes |
| Human export | Generated YAML in `design/export/` | Code review, disaster recovery |
| MCP tools | Hidden from user | Orchestrator-only, prevents direct invocation |
| Future integration | AAP sync tables in schema | Design data can be exposed to Automation Platform |

---

## Related Tools

The Content Designer leverages existing extension capabilities:

- `search_available_collections` - Find relevant collections
- `list_source_collections` - Get all collections from a source
- `get_plugin_documentation` - Understand module parameters
- `install_ansible_collection` - Install required collections
- `generate_ansible_playbook` - Create playbook YAML
- `generate_ansible_task` - Create individual tasks
- `get_ansible_creator_schema` - Scaffold roles/collections

---

## References

- [VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview)
- [VS Code Language Model API](https://code.visualstudio.com/api/extension-guides/language-model)
- [Ansible Creator Documentation](https://ansible.readthedocs.io/projects/creator/)
- [Zod Schema Validation](https://zod.dev/)
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
