/**
 * Ansible Content Designer - Guidance Service
 * 
 * Loads and manages AI guidance from ansible-creator add ai output.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ProjectGuidance } from '../types/designer';

/**
 * Default conventions when no guidance files exist
 */
const DEFAULT_CONVENTIONS = `
# Ansible Content Conventions

## General Guidelines
- Use YAML files with .yml extension
- Use 2-space indentation
- Include meaningful task names
- Use fully qualified collection names (FQCNs)
- Follow idempotency principles
- Add appropriate error handling

## Naming Conventions
- Variables: snake_case (e.g., server_port)
- Roles: snake_case (e.g., configure_nginx)
- Playbooks: descriptive names (e.g., deploy_application.yml)
- Tags: lowercase with hyphens (e.g., setup-database)

## Best Practices
- Use ansible-lint for validation
- Include molecule tests for roles
- Document all variables
- Use handlers for service restarts
- Prefer modules over shell/command when possible
`;

/**
 * GuidanceService - Manages AI guidance for content generation
 */
export class GuidanceService {
    private _workspaceRoot: string;
    private _guidanceDir: string;
    private _guidance: ProjectGuidance | undefined;

    constructor(workspaceRoot: string) {
        this._workspaceRoot = workspaceRoot;
        this._guidanceDir = path.join(workspaceRoot, 'design', 'guidance');
    }

    /**
     * Check if guidance directory exists
     */
    public hasGuidance(): boolean {
        return fs.existsSync(this._guidanceDir);
    }

    /**
     * Load all guidance files
     */
    public async load(): Promise<ProjectGuidance> {
        if (this._guidance) {
            return this._guidance;
        }

        this._guidance = {
            conventions: await this._loadConventions(),
            structure: await this._loadStructure(),
            patterns: await this._loadPatterns(),
            examples: await this._loadExamples()
        };

        return this._guidance;
    }

    /**
     * Get guidance (load if needed)
     */
    public async getGuidance(): Promise<ProjectGuidance> {
        return this._guidance || this.load();
    }

    /**
     * Refresh guidance from disk
     */
    public async refresh(): Promise<ProjectGuidance> {
        this._guidance = undefined;
        return this.load();
    }

    /**
     * Load conventions markdown
     */
    private async _loadConventions(): Promise<string> {
        const conventionsPath = path.join(this._guidanceDir, 'CONVENTIONS.md');
        
        if (fs.existsSync(conventionsPath)) {
            return fs.readFileSync(conventionsPath, 'utf-8');
        }
        
        return DEFAULT_CONVENTIONS;
    }

    /**
     * Load structure YAML
     */
    private async _loadStructure(): Promise<Record<string, unknown>> {
        const structurePath = path.join(this._guidanceDir, 'structure.yaml');
        
        if (fs.existsSync(structurePath)) {
            try {
                const content = fs.readFileSync(structurePath, 'utf-8');
                // Simple YAML parsing (for basic structures)
                return this._parseSimpleYaml(content);
            } catch {
                return {};
            }
        }
        
        return {};
    }

    /**
     * Load patterns YAML
     */
    private async _loadPatterns(): Promise<Record<string, unknown>> {
        const patternsPath = path.join(this._guidanceDir, 'patterns.yaml');
        
        if (fs.existsSync(patternsPath)) {
            try {
                const content = fs.readFileSync(patternsPath, 'utf-8');
                return this._parseSimpleYaml(content);
            } catch {
                return {};
            }
        }
        
        return {};
    }

    /**
     * Load example files
     */
    private async _loadExamples(): Promise<Map<string, string>> {
        const examples = new Map<string, string>();
        const examplesDir = path.join(this._guidanceDir, 'examples');
        
        if (!fs.existsSync(examplesDir)) {
            return examples;
        }

        try {
            const files = fs.readdirSync(examplesDir);
            for (const file of files) {
                const filePath = path.join(examplesDir, file);
                if (fs.statSync(filePath).isFile()) {
                    examples.set(file, fs.readFileSync(filePath, 'utf-8'));
                }
            }
        } catch {
            // Ignore errors
        }

        return examples;
    }

    /**
     * Simple YAML parser for basic key-value structures
     */
    private _parseSimpleYaml(content: string): Record<string, unknown> {
        const result: Record<string, unknown> = {};
        const lines = content.split('\n');
        let currentKey = '';
        let currentValue: string[] = [];
        let inMultiline = false;

        for (const line of lines) {
            // Skip comments and empty lines at top level
            if (line.trim().startsWith('#') || line.trim() === '') {
                continue;
            }

            // Check for key: value
            const match = line.match(/^(\w+):\s*(.*)$/);
            if (match && !inMultiline) {
                // Save previous key if exists
                if (currentKey && currentValue.length > 0) {
                    result[currentKey] = currentValue.join('\n').trim();
                }

                currentKey = match[1];
                const value = match[2];

                if (value === '|' || value === '>') {
                    inMultiline = true;
                    currentValue = [];
                } else if (value) {
                    result[currentKey] = value;
                    currentKey = '';
                } else {
                    currentValue = [];
                }
            } else if (inMultiline && line.startsWith('  ')) {
                currentValue.push(line.substring(2));
            } else if (inMultiline && !line.startsWith(' ')) {
                // End of multiline
                if (currentKey) {
                    result[currentKey] = currentValue.join('\n').trim();
                }
                inMultiline = false;
                currentKey = '';
                currentValue = [];
            }
        }

        // Handle last key
        if (currentKey && currentValue.length > 0) {
            result[currentKey] = currentValue.join('\n').trim();
        }

        return result;
    }

    // ========================================================================
    // Prompt Formatting
    // ========================================================================

    /**
     * Format guidance for LLM prompt injection
     */
    public async formatForPrompt(): Promise<string> {
        const guidance = await this.getGuidance();
        const sections: string[] = [];

        // Add conventions
        if (guidance.conventions) {
            sections.push('## Project Conventions\n');
            sections.push(guidance.conventions);
            sections.push('');
        }

        // Add structure
        if (Object.keys(guidance.structure).length > 0) {
            sections.push('## Project Structure\n');
            sections.push('```yaml');
            sections.push(this._formatAsYaml(guidance.structure));
            sections.push('```\n');
        }

        // Add patterns
        if (Object.keys(guidance.patterns).length > 0) {
            sections.push('## Recommended Patterns\n');
            sections.push('```yaml');
            sections.push(this._formatAsYaml(guidance.patterns));
            sections.push('```\n');
        }

        // Add examples summary
        if (guidance.examples.size > 0) {
            sections.push('## Available Examples\n');
            for (const [name] of guidance.examples) {
                sections.push(`- ${name}`);
            }
            sections.push('');
        }

        return sections.join('\n');
    }

    /**
     * Get a specific example
     */
    public async getExample(name: string): Promise<string | undefined> {
        const guidance = await this.getGuidance();
        return guidance.examples.get(name);
    }

    /**
     * Format object as YAML-like string
     */
    private _formatAsYaml(obj: Record<string, unknown>, indent: number = 0): string {
        const lines: string[] = [];
        const prefix = '  '.repeat(indent);

        for (const [key, value] of Object.entries(obj)) {
            if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
                lines.push(`${prefix}${key}:`);
                lines.push(this._formatAsYaml(value as Record<string, unknown>, indent + 1));
            } else if (Array.isArray(value)) {
                lines.push(`${prefix}${key}:`);
                for (const item of value) {
                    lines.push(`${prefix}  - ${item}`);
                }
            } else {
                lines.push(`${prefix}${key}: ${value}`);
            }
        }

        return lines.join('\n');
    }

    // ========================================================================
    // Guidance Management
    // ========================================================================

    /**
     * Initialize guidance directory with defaults
     */
    public async initializeGuidance(): Promise<void> {
        if (!fs.existsSync(this._guidanceDir)) {
            fs.mkdirSync(this._guidanceDir, { recursive: true });
        }

        // Write default conventions
        const conventionsPath = path.join(this._guidanceDir, 'CONVENTIONS.md');
        if (!fs.existsSync(conventionsPath)) {
            fs.writeFileSync(conventionsPath, DEFAULT_CONVENTIONS.trim());
        }

        // Create examples directory
        const examplesDir = path.join(this._guidanceDir, 'examples');
        if (!fs.existsSync(examplesDir)) {
            fs.mkdirSync(examplesDir);
        }
    }

    /**
     * Update conventions
     */
    public async updateConventions(content: string): Promise<void> {
        if (!fs.existsSync(this._guidanceDir)) {
            fs.mkdirSync(this._guidanceDir, { recursive: true });
        }

        const conventionsPath = path.join(this._guidanceDir, 'CONVENTIONS.md');
        fs.writeFileSync(conventionsPath, content);
        
        // Refresh cache
        await this.refresh();
    }

    /**
     * Add an example file
     */
    public async addExample(name: string, content: string): Promise<void> {
        const examplesDir = path.join(this._guidanceDir, 'examples');
        if (!fs.existsSync(examplesDir)) {
            fs.mkdirSync(examplesDir, { recursive: true });
        }

        const examplePath = path.join(examplesDir, name);
        fs.writeFileSync(examplePath, content);
        
        // Refresh cache
        await this.refresh();
    }
}
