/**
 * Ansible Content Designer - Assessment Agent (Content Stage)
 * 
 * Orchestrates LLM calls to generate assessment questions for requirements.
 * In the two-phase assessment flow, this is the CONTENT stage (phase 2).
 * 
 * Uses VS Code's native tool calling API to fetch plugin documentation
 * and generate informed questions with real parameter options.
 */

import * as vscode from 'vscode';
import type { 
    EnrichedRequirement,
    AssessmentQuestion,
    AssessmentResponse,
    QuestionCategory,
    QuestionType,
    QuestionPriority,
    IdentifiedCollection
} from '../types/designer';
import { DesignerDatabase } from '../database/DesignerDatabase';
import { GuidanceService } from '../services/GuidanceService';
import { CollectionsService } from '@ansible/core';
import { getAgentToolService, AgentToolService } from '../services/AgentToolService';

/**
 * Question categories with descriptions
 */
const CATEGORY_PROMPTS: Record<QuestionCategory, string> = {
    architecture: 'How should the automation be structured and organized?',
    security: 'What security considerations apply?',
    compatibility: 'What systems, versions, or environments must be supported?',
    error_handling: 'How should errors and failures be handled?',
    idempotency: 'How can we ensure the automation is safe to run multiple times?',
    naming: 'What naming conventions should be followed?',
    testing: 'How should the automation be tested?',
    dependencies: 'What collections and modules are needed?'
};

/**
 * Tools the agent can use for content assessment
 */
const CONTENT_ASSESSMENT_TOOLS = [
    'get_project_requirements',     // Fetch requirements from Content Designer
    'get_design_decisions',         // Get existing design decisions (from dependency phase)
    'get_ansible_best_practices',   // Get Ansible best practices
    'get_ansible_creator_schema',   // Understand project types and scaffolding options
    'list_ansible_collections',     // List installed collections
    'get_collection_plugins',       // List plugins in a collection
    'get_plugin_documentation',     // Get detailed plugin docs with parameters
    'search_ansible_plugins'        // Search installed plugin index
];

/**
 * AssessmentAgent - Generates design questions from requirements
 * 
 * Uses VS Code's native tool calling API for reliable plugin documentation retrieval.
 */
export class AssessmentAgent {
    private _db: DesignerDatabase;
    private _guidanceService: GuidanceService;
    private _collectionsService: CollectionsService;
    private _workspaceRoot: string;
    private _logService: import('../services/AgentLogService').AgentLogService;
    private _toolService: AgentToolService;
    private _maxIterations = 10;

    constructor(db: DesignerDatabase, workspaceRoot: string) {
        this._db = db;
        this._workspaceRoot = workspaceRoot;
        this._guidanceService = new GuidanceService(workspaceRoot);
        this._collectionsService = CollectionsService.getInstance();
        this._toolService = getAgentToolService();
        
        // Initialize logging
        const { getAgentLogService } = require('../services/AgentLogService');
        this._logService = getAgentLogService(workspaceRoot);
    }

    /**
     * Generate assessment questions for requirements
     * 
     * @param requirements - Requirements to assess
     * @returns Assessment questions grouped by requirement
     */
    public async generateQuestions(requirements: EnrichedRequirement[]): Promise<AssessmentResponse> {
        // Start logging
        this._logService.startPhase('content_assessment');
        this._logService.startInteraction('Generating content assessment questions');
        this._logService.log('info', `Processing ${requirements.length} requirements`);
        
        // Try to use VS Code's Language Model API
        const questions = await this._generateWithLLM(requirements);
        
        if (questions.length > 0) {
            // Store questions in database
            this._storeQuestions(questions);
            
            this._logService.log('info', `AI generated ${questions.length} questions`);
            this._logService.completeInteraction(true);
            this._logService.completePhase(`Generated ${questions.length} content assessment questions`);
            
            vscode.window.showInformationMessage(`AI generated ${questions.length} tailored questions for your requirements.`);
            
            return {
                questions,
                assessment_complete: false,
                summary: `AI generated ${questions.length} tailored questions across ${requirements.length} requirement(s).`
            };
        }

        // Fallback to rule-based generation
        this._logService.log('info', 'Falling back to rule-based question generation');
        const fallbackQuestions = this._generateFallbackQuestions(requirements);
        this._storeQuestions(fallbackQuestions);
        
        this._logService.log('info', `Generated ${fallbackQuestions.length} fallback questions`);
        this._logService.completeInteraction(true);
        this._logService.completePhase(`Generated ${fallbackQuestions.length} fallback questions`);

        return {
            questions: fallbackQuestions,
            assessment_complete: false,
            summary: `Generated ${fallbackQuestions.length} standard questions. Enable GitHub Copilot for AI-tailored questions.`
        };
    }

    /**
     * Generate questions using VS Code's Language Model API with native tool calling
     * 
     * The agent can use tools to fetch plugin documentation and understand
     * what parameters are available, then generate informed questions.
     */
    private async _generateWithLLM(requirements: EnrichedRequirement[]): Promise<AssessmentQuestion[]> {
        try {
            // Ensure tools are initialized
            await this._toolService.initialize();

            // Check if language model API is available
            if (!vscode.lm || !vscode.lm.selectChatModels) {
                console.log('AssessmentAgent: Language Model API not available');
                return [];
            }

            // Select best available model
            const model = await this._selectModel();
            if (!model) {
                vscode.window.showWarningMessage('No AI model available. Using standard questions. Enable an LLM extension for AI-generated questions.');
                return [];
            }
            
            console.log(`AssessmentAgent: Using model ${model.name || model.id}`);
            this._logService.log('info', `Using model: ${model.name || model.id}`);

            // Get tools for content assessment
            const tools = this._toolService.getToolsByName(CONTENT_ASSESSMENT_TOOLS);
            this._logService.log('info', `Loaded ${tools.length} tools for content assessment`);

            // Build the agentic prompt
            const prompt = await this._buildAgenticPrompt(requirements);
            this._logService.logPrompt('CONTENT_ASSESSMENT_AGENTIC_PROMPT', prompt, model.id);

            // Build conversation history
            const messages: vscode.LanguageModelChatMessage[] = [
                vscode.LanguageModelChatMessage.User(prompt)
            ];

            let iterations = 0;

            while (iterations < this._maxIterations) {
                iterations++;
                // Only log to file, not console - tool calls provide the useful info
                this._logService.log('debug', `Tool iteration ${iterations}/${this._maxIterations}`);

                // Send request WITH tools - native tool calling!
                const response = await model.sendRequest(messages, {
                    tools,
                    toolMode: vscode.LanguageModelChatToolMode.Auto
                });

                // Process the stream - may contain text AND tool calls
                const textParts: string[] = [];
                const toolCalls: vscode.LanguageModelToolCallPart[] = [];

                for await (const part of response.stream) {
                    if (part instanceof vscode.LanguageModelTextPart) {
                        textParts.push(part.value);
                    } else if (part instanceof vscode.LanguageModelToolCallPart) {
                        toolCalls.push(part);
                        this._logService.log('tool_call', `Tool call requested: ${part.name}`, {
                            callId: part.callId,
                            input: part.input
                        });
                    }
                }

                const fullText = textParts.join('');
                this._logService.logResponse(fullText);

                // If no tool calls, check if we have a final answer with questions
                if (toolCalls.length === 0) {
                    const questions = this._parseResponse(fullText, requirements);
                    if (questions.length > 0) {
                        this._logService.logParsed(questions, `Parsed ${questions.length} questions from final answer`);
                        return questions;
                    }

                    // No questions and no tool calls - we're done
                    this._logService.log('info', 'No tool calls and no questions found, ending');
                    return [];
                }

                // Execute each tool call using our AgentToolService
                for (const toolCall of toolCalls) {
                    this._logService.log('info', `Executing tool: ${toolCall.name}`);

                    let resultText: string;
                    try {
                        // Use our AgentToolService to execute the tool
                        resultText = await this._toolService.callTool(
                            toolCall.name,
                            toolCall.input as Record<string, unknown>
                        );

                        this._logService.log('tool_result', `Tool ${toolCall.name} completed`, {
                            result_preview: resultText.substring(0, 500)
                        });

                    } catch (error) {
                        this._logService.logError(`Tool ${toolCall.name} failed: ${error}`);
                        resultText = `Error: ${error instanceof Error ? error.message : String(error)}`;
                    }

                    // Add tool call and result to conversation for next iteration
                    messages.push(
                        vscode.LanguageModelChatMessage.Assistant([
                            new vscode.LanguageModelToolCallPart(toolCall.callId, toolCall.name, toolCall.input)
                        ])
                    );
                    messages.push(
                        vscode.LanguageModelChatMessage.User([
                            new vscode.LanguageModelToolResultPart(toolCall.callId, [
                                new vscode.LanguageModelTextPart(resultText)
                            ])
                        ])
                    );
                }
            }

            this._logService.log('info', `Max iterations (${this._maxIterations}) reached`);
            return [];

        } catch (error) {
            console.error('AssessmentAgent: LLM error:', error);
            this._logService.logError('LLM error', error);
            return [];
        }
    }

    /**
     * Build MINIMAL agentic prompt for content assessment
     * 
     * All detailed instructions are stored as SYS requirements in the database.
     * The agent retrieves them via get_project_requirements(include_system: true).
     */
    private async _buildAgenticPrompt(_requirements: EnrichedRequirement[]): Promise<string> {
        // Import the minimal prompt template
        const { CONTENT_ASSESSMENT_PROMPT } = await import('../prompts/contentAssessment');
        return CONTENT_ASSESSMENT_PROMPT;
    }


    /**
     * Parse LLM response into questions
     */
    private _parseResponse(response: string, requirements: EnrichedRequirement[]): AssessmentQuestion[] {
        try {
            // Extract JSON from response
            const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/) || 
                             response.match(/\{[\s\S]*"questions"[\s\S]*\}/);
            
            if (!jsonMatch) {
                console.log('AssessmentAgent: No JSON found in response');
                return [];
            }

            const jsonStr = jsonMatch[1] || jsonMatch[0];
            const parsed = JSON.parse(jsonStr);

            if (!parsed.questions || !Array.isArray(parsed.questions)) {
                return [];
            }

            // Validate and normalize questions
            const validReqIds = new Set(requirements.map(r => r.id));
            const questions: AssessmentQuestion[] = [];

            for (const q of parsed.questions) {
                if (!q.id || !q.requirement_ref || !q.question) {
                    continue;
                }

                if (!validReqIds.has(q.requirement_ref)) {
                    continue;
                }

                questions.push({
                    id: q.id,
                    requirement_ref: q.requirement_ref,
                    category: this._normalizeCategory(q.category),
                    question: q.question,
                    type: this._normalizeType(q.type),
                    choices: Array.isArray(q.choices) ? q.choices : undefined,
                    suggested_default: q.suggested_default,
                    rationale: q.rationale || '',
                    priority: this._normalizePriority(q.priority)
                });
            }

            return questions;

        } catch (error) {
            console.error('AssessmentAgent: Parse error:', error);
            return [];
        }
    }

    /**
     * Normalize category value
     */
    private _normalizeCategory(category: string): QuestionCategory {
        const valid: QuestionCategory[] = [
            'architecture', 'security', 'compatibility', 
            'error_handling', 'idempotency', 'naming', 'testing'
        ];
        const normalized = category?.toLowerCase().replace(/\s+/g, '_') as QuestionCategory;
        return valid.includes(normalized) ? normalized : 'architecture';
    }

    /**
     * Normalize question type
     */
    private _normalizeType(type: string): QuestionType {
        const valid: QuestionType[] = ['text', 'single_choice', 'multi_choice', 'yes_no', 'confirm'];
        const normalized = type?.toLowerCase().replace(/\s+/g, '_') as QuestionType;
        return valid.includes(normalized) ? normalized : 'text';
    }

    /**
     * Normalize priority
     */
    private _normalizePriority(priority: string): QuestionPriority {
        const valid: QuestionPriority[] = ['required', 'recommended', 'optional'];
        const normalized = priority?.toLowerCase() as QuestionPriority;
        return valid.includes(normalized) ? normalized : 'recommended';
    }

    /**
     * Generate fallback questions when LLM is unavailable
     * 
     * Questions are divided into:
     * - Project-level questions (asked once, apply to all requirements)
     * - Requirement-specific questions (asked per-requirement)
     */
    private _generateFallbackQuestions(requirements: EnrichedRequirement[]): AssessmentQuestion[] {
        const questions: AssessmentQuestion[] = [];
        let questionNum = 1;

        // Use first requirement as anchor for project-level questions
        const projectReqId = requirements[0]?.id || 'REQ-001';

        // ================================================================
        // PROJECT-LEVEL QUESTIONS (asked once)
        // ================================================================

        // Global error handling strategy
        questions.push({
            id: `Q-${String(questionNum++).padStart(3, '0')}`,
            requirement_ref: projectReqId,
            category: 'error_handling',
            question: '[Project-wide] How should failures be handled across all automation?',
            type: 'single_choice',
            choices: [
                'Stop immediately on any failure',
                'Continue and report failures at end',
                'Attempt rollback on failure',
                'Depends on task criticality (per-task block/rescue)'
            ],
            suggested_default: 'Depends on task criticality (per-task block/rescue)',
            rationale: 'Defines the global error handling strategy. Individual tasks can override.',
            priority: 'required'
        });

        // Global testing strategy
        questions.push({
            id: `Q-${String(questionNum++).padStart(3, '0')}`,
            requirement_ref: projectReqId,
            category: 'testing',
            question: '[Project-wide] What testing approach should be used?',
            type: 'multi_choice',
            choices: [
                'Molecule integration tests',
                'Ansible-lint validation', 
                'Manual testing in staging',
                'Unit tests for custom plugins',
                'CI/CD pipeline integration'
            ],
            suggested_default: 'Molecule integration tests',
            rationale: 'Determines how all automation will be validated.',
            priority: 'required'
        });

        // Naming conventions
        questions.push({
            id: `Q-${String(questionNum++).padStart(3, '0')}`,
            requirement_ref: projectReqId,
            category: 'naming',
            question: '[Project-wide] What naming convention should be used for roles, variables, and tasks?',
            type: 'single_choice',
            choices: [
                'snake_case (role_name, var_name)',
                'kebab-case (role-name, var-name)',
                'Follow existing project conventions',
                'No specific convention'
            ],
            suggested_default: 'snake_case (role_name, var_name)',
            rationale: 'Consistent naming improves readability and maintainability.',
            priority: 'recommended'
        });

        // Security baseline
        questions.push({
            id: `Q-${String(questionNum++).padStart(3, '0')}`,
            requirement_ref: projectReqId,
            category: 'security',
            question: '[Project-wide] How should sensitive data (passwords, keys) be handled?',
            type: 'single_choice',
            choices: [
                'Ansible Vault for encryption',
                'External secrets manager (HashiCorp Vault, AWS Secrets Manager)',
                'Environment variables',
                'No sensitive data expected'
            ],
            suggested_default: 'Ansible Vault for encryption',
            rationale: 'Determines how secrets are managed across all automation.',
            priority: 'required'
        });

        // ================================================================
        // REQUIREMENT-SPECIFIC QUESTIONS
        // ================================================================

        for (const req of requirements) {
            // Architecture - specific to each requirement
            questions.push({
                id: `Q-${String(questionNum++).padStart(3, '0')}`,
                requirement_ref: req.id,
                category: 'architecture',
                question: `How should "${this._truncate(req.description, 60)}" be structured?`,
                type: 'single_choice',
                choices: [
                    'Tasks in main playbook',
                    'Dedicated role',
                    'Multiple roles with dependencies',
                    'Existing collection/role (specify below)'
                ],
                rationale: 'Determines the structural approach for this specific requirement.',
                priority: 'required'
            });

            // Compatibility - specific to each requirement
            questions.push({
                id: `Q-${String(questionNum++).padStart(3, '0')}`,
                requirement_ref: req.id,
                category: 'compatibility',
                question: `What target platforms must "${this._truncate(req.description, 40)}" support?`,
                type: 'multi_choice',
                choices: [
                    'RHEL 8',
                    'RHEL 9',
                    'Ubuntu 22.04 LTS',
                    'Ubuntu 24.04 LTS',
                    'Debian 11/12',
                    'Amazon Linux 2023',
                    'Windows Server 2019+',
                    'Other (specify in notes)'
                ],
                suggested_default: 'RHEL 9',
                rationale: 'Identifies OS/platform requirements. Affects module selection and testing.',
                priority: 'recommended'
            });

            // Privilege escalation
            questions.push({
                id: `Q-${String(questionNum++).padStart(3, '0')}`,
                requirement_ref: req.id,
                category: 'security',
                question: `Does "${this._truncate(req.description, 40)}" require privilege escalation (become/sudo)?`,
                type: 'single_choice',
                choices: [
                    'Yes, always (become: true at play level)',
                    'Yes, for specific tasks only',
                    'No, runs as unprivileged user',
                    'Depends on target system'
                ],
                suggested_default: 'Yes, for specific tasks only',
                rationale: 'Determines security posture and become configuration.',
                priority: 'required'
            });

            // Idempotency concerns - only if likely non-idempotent
            const hasNonIdempotentKeywords = /delete|remove|create|generate|random|uuid/i.test(req.description);
            if (hasNonIdempotentKeywords) {
                questions.push({
                    id: `Q-${String(questionNum++).padStart(3, '0')}`,
                    requirement_ref: req.id,
                    category: 'idempotency',
                    question: `This requirement may involve non-idempotent operations. How should repeated runs be handled?`,
                    type: 'single_choice',
                    choices: [
                        'Skip if already completed (register + when)',
                        'Always run with creates/removes guards',
                        'Use check mode to verify state first',
                        'Accept non-idempotent behavior (document it)'
                    ],
                    suggested_default: 'Skip if already completed (register + when)',
                    rationale: 'Ensures safe re-runs for operations that may have side effects.',
                    priority: 'required'
                });
            }

            // Check mode support
            questions.push({
                id: `Q-${String(questionNum++).padStart(3, '0')}`,
                requirement_ref: req.id,
                category: 'testing',
                question: `Should "${this._truncate(req.description, 40)}" support check mode (--check)?`,
                type: 'yes_no',
                suggested_default: 'Yes',
                rationale: 'Check mode allows dry-run testing without making changes.',
                priority: 'recommended'
            });
        }

        return questions;
    }

    /**
     * Select the best available language model
     * 
     * Uses the configured preferred model, or falls back to Claude Opus, Claude, or any available model.
     */
    private async _selectModel(): Promise<vscode.LanguageModelChat | undefined> {
        if (!vscode.lm || !vscode.lm.selectChatModels) {
            console.log('AssessmentAgent: Language Model API not available');
            return undefined;
        }

        const models = await vscode.lm.selectChatModels({});
        
        if (models.length === 0) {
            console.log('AssessmentAgent: No language models available');
            return undefined;
        }

        // Log available models for debugging
        console.log('AssessmentAgent: Available models:', models.map(m => m.id).join(', '));

        // Check for configured preferred model
        const config = vscode.workspace.getConfiguration('ansibleEnvironments');
        const preferredModelId = config.get<string>('preferredLlmModel', '');
        
        if (preferredModelId) {
            const preferred = models.find(m => 
                m.id.toLowerCase().includes(preferredModelId.toLowerCase()) ||
                m.id === preferredModelId
            );
            if (preferred) {
                console.log(`AssessmentAgent: Using configured preferred model: ${preferred.id}`);
                return preferred;
            }
            console.log(`AssessmentAgent: Configured model '${preferredModelId}' not found, using fallback`);
        }

        // Fallback: Prefer Claude Opus 4.5, then any Claude, then any model
        let model = models.find(m => 
            m.id.toLowerCase().includes('claude') && 
            (m.id.toLowerCase().includes('opus') || m.id.toLowerCase().includes('4.5'))
        );
        
        if (!model) {
            model = models.find(m => m.id.toLowerCase().includes('claude'));
        }
        
        if (!model) {
            model = models[0]; // Fall back to first available
        }
        
        return model;
    }


    /**
     * Truncate text for display
     */
    private _truncate(text: string, maxLen: number): string {
        if (text.length <= maxLen) return text;
        return text.substring(0, maxLen - 3) + '...';
    }

    /**
     * Store questions in database
     */
    private _storeQuestions(questions: AssessmentQuestion[]): void {
        for (const q of questions) {
            // Check if question already exists
            const existing = this._db.get<{ id: number }>(`
                SELECT id FROM design_decisions 
                WHERE requirement_id = ? AND question_id = ?
            `, q.requirement_ref, q.id);

            if (existing) {
                continue; // Don't overwrite existing questions
            }

            // Serialize choices as JSON if present
            const choicesJson = q.choices ? JSON.stringify(q.choices) : null;

            this._db.run(`
                INSERT INTO design_decisions 
                (requirement_id, question_id, category, question, question_type, choices, suggested_default, rationale, stage)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'content')
            `, q.requirement_ref, q.id, q.category, q.question, q.type, choicesJson, q.suggested_default, q.rationale);
        }
    }

    /**
     * Get pending questions (unanswered)
     */
    public getPendingQuestions(): AssessmentQuestion[] {
        const rows = this._db.all<{
            question_id: string;
            requirement_id: string;
            category: QuestionCategory;
            question: string;
            rationale: string;
        }>(`
            SELECT question_id, requirement_id, category, question, rationale
            FROM design_decisions
            WHERE answer IS NULL
            ORDER BY requirement_id, question_id
        `);

        return rows.map(r => ({
            id: r.question_id,
            requirement_ref: r.requirement_id,
            category: r.category,
            question: r.question,
            type: 'text' as QuestionType,
            rationale: r.rationale,
            priority: 'recommended' as QuestionPriority
        }));
    }

    /**
     * Save an answer
     */
    public saveAnswer(
        requirementId: string, 
        questionId: string, 
        answer: string,
        usedDefault: boolean = false,
        answeredBy?: string
    ): void {
        this._db.run(`
            UPDATE design_decisions 
            SET answer = ?,
                used_default = ?,
                answered_by = ?,
                answered_at = CURRENT_TIMESTAMP
            WHERE requirement_id = ? AND question_id = ?
        `, answer, usedDefault, answeredBy, requirementId, questionId);

        this._db.logHistory('question_answered', 'design_decision', questionId, answeredBy, {
            requirement_id: requirementId,
            answer: answer.substring(0, 100),
            used_default: usedDefault
        });
    }

    /**
     * Review answered questions and generate follow-up clarifying questions
     * 
     * @returns Array of new follow-up questions (0-3)
     */
    public async reviewAnswersForFollowUp(): Promise<AssessmentQuestion[]> {
        // Get all answered questions with their answers
        const answeredQuestions = this._db.all<{
            requirement_id: string;
            question_id: string;
            category: string;
            question: string;
            answer: string;
        }>(`
            SELECT requirement_id, question_id, category, question, answer
            FROM design_decisions
            WHERE answer IS NOT NULL
            ORDER BY requirement_id, question_id
        `);

        if (answeredQuestions.length === 0) {
            return [];
        }

        try {
            const followUpQuestions = await this._generateFollowUpWithLLM(answeredQuestions);
            
            if (followUpQuestions.length > 0) {
                this._storeQuestions(followUpQuestions);
            }
            
            return followUpQuestions;
        } catch (error) {
            console.error('AssessmentAgent: Error generating follow-up questions:', error);
            return [];
        }
    }

    /**
     * Use LLM to generate follow-up questions based on answers
     */
    private async _generateFollowUpWithLLM(
        answeredQuestions: Array<{ requirement_id: string; question_id: string; category: string; question: string; answer: string }>
    ): Promise<AssessmentQuestion[]> {
        const model = await this._selectModel();
        if (!model) {
            console.log('AssessmentAgent: No language models available for follow-up');
            return [];
        }
        
        console.log(`AssessmentAgent: Using model for follow-up: ${model.name || model.id}`);

        // Build context from answered questions
        const qaContext = answeredQuestions.map(q => 
            `[${q.requirement_id}] ${q.category}: Q: ${q.question}\nA: ${q.answer}`
        ).join('\n\n');

        const prompt = `You are reviewing assessment answers for an Ansible automation project.

Based on the following questions and answers, identify 0-3 areas that need clarification.
Only ask follow-up questions if there are genuine gaps, ambiguities, or contradictions.
Do NOT ask questions just to fill space - if the answers are clear, return an empty list.

Current Q&A:
${qaContext}

If follow-up is needed, respond with a JSON array of questions:
[
  {
    "requirement_id": "REQ-001",
    "category": "architecture",
    "question": "[Follow-up] Your specific clarifying question here?",
    "rationale": "Why this clarification matters"
  }
]

If no follow-up is needed, respond with: []

Categories: architecture, security, compatibility, error_handling, idempotency, naming, testing

Respond with ONLY the JSON array, no other text.`;

        try {
            const messages = [
                vscode.LanguageModelChatMessage.User(prompt)
            ];

            const response = await model.sendRequest(messages, {});

            let responseText = '';
            for await (const chunk of response.text) {
                responseText += chunk;
            }

            // Extract JSON from response
            const jsonMatch = responseText.match(/\[[\s\S]*\]/);
            if (!jsonMatch) {
                return [];
            }

            const parsed = JSON.parse(jsonMatch[0]);
            if (!Array.isArray(parsed) || parsed.length === 0) {
                return [];
            }

            // Get next question ID
            const maxId = this._db.get<{ max_num: number }>(`
                SELECT COALESCE(MAX(CAST(SUBSTR(question_id, 3) AS INTEGER)), 0) as max_num
                FROM design_decisions
            `)?.max_num || 0;

            // Convert to AssessmentQuestion format
            return parsed.slice(0, 3).map((item: {
                requirement_id: string;
                category: string;
                question: string;
                rationale?: string;
            }, idx: number) => ({
                id: `Q-${String(maxId + idx + 1).padStart(3, '0')}`,
                requirement_ref: item.requirement_id || answeredQuestions[0].requirement_id,
                category: (item.category || 'architecture') as QuestionCategory,
                question: item.question,
                type: 'text' as const,
                rationale: item.rationale || 'Follow-up clarification based on your previous answers',
                priority: 'required' as const
            }));

        } catch (error) {
            console.error('AssessmentAgent: LLM follow-up error:', error);
            return [];
        }
    }

    /**
     * Check if assessment is complete
     */
    public isAssessmentComplete(): boolean {
        const pending = this._db.get<{ count: number }>(`
            SELECT COUNT(*) as count FROM design_decisions WHERE answer IS NULL
        `);
        return (pending?.count || 0) === 0;
    }
}
