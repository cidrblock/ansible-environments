/**
 * Ansible Content Designer - Prompt Templates
 * 
 * Centralized prompt templates for all AI/LLM interactions.
 * Templates use {{variable}} syntax for runtime substitution.
 * 
 * Benefits:
 * - Easy to review and modify prompts without changing code
 * - Consistent prompt structure across the extension
 * - Potential for user customization in the future
 */

export { DEPENDENCY_ASSESSMENT_PROMPT } from './dependencyAssessment';
export { CONTENT_ASSESSMENT_PROMPT } from './contentAssessment';
export { BUILD_PLANNING_PROMPT } from './buildPlanning';
export { AGENT_REVIEW_PROMPT } from './agentReview';
export { CONTENT_GENERATION_PROMPT, ERROR_CORRECTION_PROMPT, BUILD_SYSTEM_CONTEXT } from './buildExecution';

/**
 * Simple template substitution
 * Replaces {{key}} with values from the context object
 */
export function renderTemplate(template: string, context: Record<string, string | number | boolean | undefined>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
        const value = context[key];
        if (value === undefined || value === null) {
            return match; // Keep original if no value
        }
        return String(value);
    });
}

/**
 * Render template with array/list support
 * Handles {{#items}}...{{/items}} blocks
 */
export function renderTemplateWithLists(
    template: string, 
    context: Record<string, string | number | boolean | string[] | undefined>
): string {
    // First handle list blocks like {{#items}}...{{/items}}
    let result = template.replace(
        /\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
        (match, key, content) => {
            const items = context[key];
            if (!Array.isArray(items)) {
                return '';
            }
            return items.map(item => content.replace(/\{\{item\}\}/g, String(item))).join('');
        }
    );

    // Then handle simple substitutions
    result = result.replace(/\{\{(\w+)\}\}/g, (match, key) => {
        const value = context[key];
        if (value === undefined || value === null) {
            return match;
        }
        if (Array.isArray(value)) {
            return value.join('\n');
        }
        return String(value);
    });

    return result;
}
