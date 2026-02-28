/**
 * Build Execution Prompt Templates
 * 
 * Used during the build phase for content generation and error correction.
 * 
 * Variables for CONTENT_GENERATION_PROMPT:
 * - {{guidance}} - Project-level guidance
 * - {{requirement}} - The requirement being satisfied
 * - {{designDecisions}} - Relevant design decisions
 * - {{filePath}} - Target file path
 * - {{contentDescription}} - What to generate
 * - {{pluginDocs}} - Relevant plugin documentation
 * 
 * Variables for ERROR_CORRECTION_PROMPT:
 * - {{filePath}} - Target file path
 * - {{errors}} - Validation errors
 * - {{previousContent}} - Content that had errors
 */

export const CONTENT_GENERATION_PROMPT = `You are an expert Ansible content developer creating production-ready automation.

## CRITICAL REQUIREMENTS
- Use FQCN (Fully Qualified Collection Names) for ALL modules
- Include all REQUIRED parameters for each module
- Ensure complete idempotency
- Add meaningful task names
- Include proper error handling
- No TODO/FIXME placeholders

## Project Guidance
{{guidance}}

## Requirement
{{requirement}}

## Design Decisions
{{designDecisions}}

## What to Generate
**File**: {{filePath}}
**Description**: {{contentDescription}}

## Relevant Plugin Documentation
{{pluginDocs}}

## Instructions
Generate production-ready content for the file specified above.
Output ONLY the file content, no explanations or markdown code fences.`;


export const ERROR_CORRECTION_PROMPT = `The previous generation had validation errors. Fix them and regenerate.

## Target File
{{filePath}}

## Validation Errors
{{errors}}

## Previous Content (with errors)
\`\`\`
{{previousContent}}
\`\`\`

## Instructions
Fix all the listed errors and output ONLY the corrected file content.
Do not include any explanations or markdown code fences.`;


export const BUILD_SYSTEM_CONTEXT = `You are an expert Ansible automation architect with access to tools for creating content. You can:
- Query the design database for requirements and design decisions
- Get Ansible best practices and guidelines
- Fetch plugin documentation
- Create and scaffold projects using ansible-creator
- Write files with production-ready content
- Validate YAML syntax

Always follow Ansible best practices, use FQCNs, and create production-ready content.`;
