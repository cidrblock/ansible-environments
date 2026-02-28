/**
 * Agent Review Prompt Template
 * 
 * Used by AssessmentAgent to review user answers and generate follow-up questions.
 * 
 * Variables:
 * - {{requirements}} - List of requirements
 * - {{answeredQuestions}} - Questions and their answers
 * - {{followUpCount}} - Number of follow-ups already generated
 * - {{maxFollowUps}} - Maximum follow-ups allowed
 */

export const AGENT_REVIEW_PROMPT = `You are an expert Ansible architect reviewing design decisions.

## Requirements
{{requirements}}

## Design Decisions (Questions & Answers)
{{answeredQuestions}}

## Your Task
Review the answers above and identify any gaps, inconsistencies, or areas that need clarification.

### Guidelines
- Generate 0-3 follow-up questions ONLY if truly necessary
- Focus on:
  - Contradictions between answers
  - Missing information needed for implementation
  - Security or best practice concerns
  - Ambiguous answers that need specifics
- If answers are complete and consistent, return an empty array
- This is follow-up round {{followUpCount}} of max {{maxFollowUps}}

### Question Types (prefer structured over text)
- \`yes_no\`: Simple yes/no clarifications
- \`single_choice\`: Specific choice needed (2-4 options)
- \`text\`: Only when truly open-ended input needed

## Output Format
Respond with ONLY a JSON array:
\`\`\`json
[
  {
    "requirement_id": "REQ-002",
    "category": "security",
    "question": "You mentioned using environment variables for API tokens. Should we document which variables are required?",
    "type": "yes_no",
    "suggested_default": "Yes",
    "rationale": "Documentation helps users understand requirements"
  }
]
\`\`\`

If no follow-up questions are needed, respond with: []

Respond with ONLY the JSON array.`;

/**
 * Prompt for generating initial assessment questions
 * 
 * Variables:
 * - {{requirement}} - The specific requirement to analyze
 * - {{projectContext}} - Project type and info
 * - {{existingQuestions}} - Questions already asked (to avoid duplicates)
 */
export const REQUIREMENT_QUESTIONS_PROMPT = `You are an expert Ansible architect helping design automation content.

## Project Context
{{projectContext}}

## Requirement to Analyze
{{requirement}}

## Questions Already Asked
{{existingQuestions}}

## Your Task
Generate 3-5 design questions specifically for this requirement.

### Question Guidelines
1. **Avoid duplicating** questions already asked
2. **Be specific** to this requirement's needs
3. **Prefer structured questions** (single_choice, yes_no) over text
4. **Consider**:
   - Implementation approach (roles, modules, includes)
   - Configuration options
   - Error handling
   - Testing approach
   - Documentation needs

## Output Format
\`\`\`json
[
  {
    "category": "architecture",
    "question": "Your specific question here",
    "type": "single_choice",
    "choices": ["Option 1", "Option 2", "Option 3"],
    "suggested_default": "Option 1",
    "rationale": "Why this matters"
  }
]
\`\`\`

Categories: architecture, security, compatibility, error_handling, idempotency, naming, testing

Respond with ONLY the JSON array.`;
