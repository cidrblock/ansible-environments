/**
 * Ansible Content Designer
 * 
 * A Spec-Driven Development (SDD) approach to Ansible content creation.
 * Guides users through structured phases from requirements to generated content.
 * 
 * @module designer
 */

// Activation
export { 
    activateDesigner, 
    deactivateDesigner, 
    isDesignerActive, 
    getDesignerContext,
    type DesignerContext 
} from './activate';

// Types
export * from './types/designer';

// Database
export { DesignerDatabase, type ColumnInfo } from './database/DesignerDatabase';
export { SchemaGenerator } from './database/SchemaGenerator';

// Services
export { ProgressService } from './services/ProgressService';
export { RequirementService } from './services/RequirementService';
export { GuidanceService } from './services/GuidanceService';
export { ExportService } from './services/ExportService';
export { LlmService } from './services/LlmService';
// export { SignOffService } from './services/SignOffService';

// Orchestrators
export { AssessmentAgent } from './orchestrator/AssessmentAgent';
export { PlanningAgent } from './orchestrator/PlanningAgent';
export { BuildOrchestrator } from './orchestrator/BuildOrchestrator';
export { DriftAgent } from './orchestrator/DriftAgent';
// export { AgentOrchestrator } from './orchestrator/AgentOrchestrator';

// Views
export { DesignerTreeProvider } from './views/DesignerTreeProvider';

// Panels
export { ProjectInitPanel } from './panels/ProjectInitPanel';
export { RequirementsPanel } from './panels/RequirementsPanel';
export { AssessmentPanel } from './panels/AssessmentPanel';
export { PlanningPanel } from './panels/PlanningPanel';
export { BuildPanel } from './panels/BuildPanel';
export { DriftPanel } from './panels/DriftPanel';
// export { DesignerMainPanel } from './panels/DesignerMainPanel';

// MCP Tools (to be implemented)
// export { designerTools } from './mcp/designerTools';
