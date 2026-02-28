/**
 * MCP Tool Definitions
 * 
 * These define the tools available to AI agents via the MCP protocol.
 */

import { GET_BEST_PRACTICES_TOOL } from '../designer/mcp/designerTools';

export interface McpToolDefinition {
    name: string;
    description: string;
    inputSchema: {
        type: 'object';
        properties: Record<string, unknown>;
        required?: string[];
    };
}

export interface McpToolResult {
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
}

// === Discovery Tools ===

export const SEARCH_PLUGINS_TOOL: McpToolDefinition = {
    name: 'search_ansible_plugins',
    description: `Search for Ansible plugins by keyword.

Returns matching plugins with names, types, and short descriptions.
Use this to find the right plugin before generating tasks.

Examples:
- "copy file" → ansible.builtin.copy
- "cisco vlan" → cisco.nxos.nxos_vlans, cisco.ios.ios_vlans
- "docker container" → community.docker.docker_container
- "aws ec2" → amazon.aws.ec2_instance`,
    inputSchema: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'Search terms (e.g., "copy file", "network acl", "kubernetes pod")'
            },
            plugin_type: {
                type: 'string',
                enum: ['module', 'filter', 'lookup', 'callback', 'connection', 'inventory'],
                description: 'Optional: filter by plugin type'
            },
            collection: {
                type: 'string',
                description: 'Optional: filter by collection (e.g., "cisco.nxos", "ansible.builtin")'
            },
            limit: {
                type: 'number',
                description: 'Maximum results (default: 15, max: 50)'
            }
        },
        required: ['query']
    }
};

export const GET_PLUGIN_DOC_TOOL: McpToolDefinition = {
    name: 'get_plugin_documentation',
    description: `Get full documentation for a specific Ansible plugin.

Returns synopsis, all parameters with types/defaults/choices, examples, and return values.
Use search_ansible_plugins first if you need to find the plugin name.`,
    inputSchema: {
        type: 'object',
        properties: {
            plugin: {
                type: 'string',
                description: 'Full plugin name (e.g., "ansible.builtin.copy", "cisco.nxos.nxos_vlans")'
            },
            plugin_type: {
                type: 'string',
                enum: ['module', 'filter', 'lookup', 'callback', 'connection', 'inventory', 'become', 'cache', 'cliconf', 'httpapi', 'netconf', 'shell', 'strategy', 'test', 'vars'],
                description: 'Plugin type (default: module)'
            }
        },
        required: ['plugin']
    }
};

export const LIST_COLLECTIONS_TOOL: McpToolDefinition = {
    name: 'list_ansible_collections',
    description: 'List all installed Ansible collections with their versions.',
    inputSchema: {
        type: 'object',
        properties: {
            filter: {
                type: 'string',
                description: 'Optional: filter by namespace or name'
            }
        }
    }
};

export const INSTALL_COLLECTION_TOOL: McpToolDefinition = {
    name: 'install_ansible_collection',
    description: `Install an Ansible collection using ade (ansible-dev-tools).

Examples:
- install_ansible_collection({ name: "hetzner.hcloud" })
- install_ansible_collection({ name: "cisco.nxos" })`,
    inputSchema: {
        type: 'object',
        properties: {
            name: {
                type: 'string',
                description: 'Collection name (e.g., "hetzner.hcloud", "cisco.nxos")'
            }
        },
        required: ['name']
    }
};

export const SEARCH_AVAILABLE_COLLECTIONS_TOOL: McpToolDefinition = {
    name: 'search_available_collections',
    description: `Search for available Ansible collections by keyword across all configured sources.

Searches Ansible Galaxy (~4000+ collections) and configured GitHub organizations to find relevant collections.
Use this to discover collections for specific use cases before installing them.

Examples:
- search_available_collections({ query: "kubernetes" }) → finds k8s-related collections from all sources
- search_available_collections({ query: "cisco", source: "galaxy" }) → finds Cisco collections from Galaxy only
- search_available_collections({ query: "aap", source: "redhat-cop" }) → finds AAP collections from redhat-cop GitHub org`,
    inputSchema: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'Search terms (e.g., "kubernetes", "cisco", "aws", "vmware")'
            },
            source: {
                type: 'string',
                description: 'Optional: limit to a specific source ("galaxy" or a GitHub org name like "redhat-cop")'
            },
            limit: {
                type: 'number',
                description: 'Maximum results (default: 20, max: 100)'
            }
        },
        required: ['query']
    }
};

export const LIST_SOURCE_COLLECTIONS_TOOL: McpToolDefinition = {
    name: 'list_source_collections',
    description: `List all collections from a specific source (Galaxy or GitHub org).

Use this to get a complete list of collections from a source before summarizing.

Examples:
- list_source_collections({ source: "galaxy" }) → all Galaxy collections
- list_source_collections({ source: "redhat-cop" }) → all collections from redhat-cop GitHub org
- list_source_collections({ source: "ansible-collections" }) → all collections from ansible-collections GitHub org`,
    inputSchema: {
        type: 'object',
        properties: {
            source: {
                type: 'string',
                description: 'Source to list: "galaxy" or a GitHub org name'
            },
            limit: {
                type: 'number',
                description: 'Maximum results (default: 100, max: 500)'
            }
        },
        required: ['source']
    }
};

export const GET_COLLECTION_PLUGINS_TOOL: McpToolDefinition = {
    name: 'get_collection_plugins',
    description: `List all plugins in a specific Ansible collection.

Returns plugins grouped by type (modules, filters, lookups, etc.) with descriptions.

Examples:
- get_collection_plugins({ collection: "cisco.nxos" })
- get_collection_plugins({ collection: "ansible.builtin", plugin_type: "module" })`,
    inputSchema: {
        type: 'object',
        properties: {
            collection: {
                type: 'string',
                description: 'Collection name (e.g., "cisco.nxos", "ansible.builtin")'
            },
            plugin_type: {
                type: 'string',
                enum: ['module', 'filter', 'lookup', 'callback', 'connection', 'inventory', 'become', 'cache', 'cliconf', 'httpapi', 'netconf', 'shell', 'strategy', 'test', 'vars'],
                description: 'Optional: filter by plugin type'
            }
        },
        required: ['collection']
    }
};

// === Task Generation Tools ===

export const GENERATE_TASK_TOOL: McpToolDefinition = {
    name: 'generate_ansible_task',
    description: `Generate an Ansible task YAML for any installed plugin (one-shot).

Dynamically fetches the plugin's schema and generates properly formatted YAML.
Use this when you know the plugin and parameters needed.

Examples:
• Copy file:
  generate_ansible_task({ 
    plugin: "ansible.builtin.copy", 
    params: { src: "app.conf", dest: "/etc/app/", mode: "0644" }
  })

• Install package:
  generate_ansible_task({
    plugin: "ansible.builtin.apt",
    params: { name: "nginx", state: "present" },
    become: true
  })

• Configure network:
  generate_ansible_task({
    plugin: "cisco.nxos.nxos_vlans",
    params: { config: [{ vlan_id: 100, name: "Web" }], state: "merged" }
  })`,
    inputSchema: {
        type: 'object',
        properties: {
            plugin: {
                type: 'string',
                description: 'Full plugin name (e.g., "ansible.builtin.copy")'
            },
            plugin_type: {
                type: 'string',
                description: 'Plugin type (default: module)'
            },
            params: {
                type: 'object',
                additionalProperties: true,
                description: 'Plugin parameters as key-value pairs'
            },
            task_name: {
                type: 'string',
                description: 'Custom task name (auto-generated if not provided)'
            },
            register: {
                type: 'string',
                description: 'Variable name to store task result'
            },
            when: {
                type: 'string',
                description: 'Conditional expression (e.g., "ansible_os_family == \'Debian\'")'
            },
            loop: {
                type: 'array',
                items: { type: 'string' },
                description: 'Items to iterate over'
            },
            become: {
                type: 'boolean',
                description: 'Run with elevated privileges (sudo)'
            },
            ignore_errors: {
                type: 'boolean',
                description: 'Continue playbook on task failure'
            },
            tags: {
                type: 'array',
                items: { type: 'string' },
                description: 'Tags to apply to the task'
            }
        },
        required: ['plugin', 'params']
    }
};

export const BUILD_TASK_TOOL: McpToolDefinition = {
    name: 'build_ansible_task',
    description: `Interactively build an Ansible task with guided parameter collection.

This tool maintains conversation state and guides through:
1. Required parameters (must be provided)
2. Optional parameters (can be added)
3. Final YAML generation

**Start a new session:**
build_ansible_task({ plugin: "ansible.builtin.copy" })
→ Returns list of required/optional parameters with descriptions

**Add parameters:**
build_ansible_task({ session_id: "xxx", params: { src: "file.txt", dest: "/tmp/" }})
→ Updates state, shows what's still needed

**Generate when ready:**
build_ansible_task({ session_id: "xxx", generate: true })
→ Returns final YAML

Sessions timeout after 10 minutes of inactivity.`,
    inputSchema: {
        type: 'object',
        properties: {
            plugin: {
                type: 'string',
                description: 'Start new session: Full plugin name'
            },
            plugin_type: {
                type: 'string',
                description: 'Plugin type (default: module)'
            },
            session_id: {
                type: 'string',
                description: 'Continue existing session'
            },
            params: {
                type: 'object',
                additionalProperties: true,
                description: 'Parameters to add to the task'
            },
            task_name: {
                type: 'string',
                description: 'Custom task name'
            },
            become: {
                type: 'boolean',
                description: 'Run with elevated privileges'
            },
            register: {
                type: 'string',
                description: 'Variable to store result'
            },
            when: {
                type: 'string',
                description: 'Conditional expression'
            },
            generate: {
                type: 'boolean',
                description: 'Generate YAML with current parameters'
            },
            cancel: {
                type: 'boolean',
                description: 'Cancel the session'
            }
        }
    }
};

export const GENERATE_PLAYBOOK_TOOL: McpToolDefinition = {
    name: 'generate_ansible_playbook',
    description: `Generate a complete Ansible playbook with multiple tasks.

Provide a list of tasks and this tool generates a properly formatted playbook.`,
    inputSchema: {
        type: 'object',
        properties: {
            name: {
                type: 'string',
                description: 'Playbook name/description'
            },
            hosts: {
                type: 'string',
                description: 'Target hosts or group (e.g., "all", "webservers", "localhost")'
            },
            tasks: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        plugin: { type: 'string' },
                        params: { type: 'object', additionalProperties: true },
                        task_name: { type: 'string' },
                        become: { type: 'boolean' },
                        when: { type: 'string' },
                        register: { type: 'string' }
                    },
                    required: ['plugin', 'params']
                },
                description: 'List of tasks to include'
            },
            become: {
                type: 'boolean',
                description: 'Run all tasks with elevated privileges'
            },
            vars: {
                type: 'object',
                description: 'Playbook variables'
            },
            gather_facts: {
                type: 'boolean',
                description: 'Gather facts before running (default: true)'
            }
        },
        required: ['name', 'hosts', 'tasks']
    }
};

// === Execution Environment Tools ===

export const LIST_EE_TOOL: McpToolDefinition = {
    name: 'list_execution_environments',
    description: 'List available Ansible execution environment container images.',
    inputSchema: {
        type: 'object',
        properties: {}
    }
};

export const GET_EE_DETAILS_TOOL: McpToolDefinition = {
    name: 'get_ee_details',
    description: `Get COMPLETE detailed information about an Ansible execution environment.

This tool returns ALL information about the EE - no additional container inspection is needed:
• Container base OS and Ansible version
• ALL installed Ansible collections with versions
• ALL installed Python packages with versions  
• ALL system packages (if available)

Use the ee_name exactly as returned by list_execution_environments.`,
    inputSchema: {
        type: 'object',
        properties: {
            ee_name: {
                type: 'string',
                description: 'Execution environment image name (e.g., "quay.io/ansible/creator-ee:latest")'
            }
        },
        required: ['ee_name']
    }
};

// === Dev Tools ===

export const LIST_DEV_TOOLS_TOOL: McpToolDefinition = {
    name: 'list_ansible_dev_tools',
    description: 'List installed ansible-dev-tools packages and their versions.',
    inputSchema: {
        type: 'object',
        properties: {}
    }
};

// === Creator ===

export const GET_CREATOR_SCHEMA_TOOL: McpToolDefinition = {
    name: 'get_ansible_creator_schema',
    description: 'Get the full ansible-creator command schema showing all available scaffolding commands and their parameters. Use this to understand what content types can be created (collections, playbooks, plugins, etc.) and what options are available for each.',
    inputSchema: {
        type: 'object',
        properties: {}
    }
};

// === Content Designer ===

export const QUERY_DESIGN_DB_TOOL: McpToolDefinition = {
    name: 'query_design_db',
    description: `Execute a read-only SQL query against the Content Designer database.

This tool provides AI agents with access to project requirements, design decisions,
implementation plans, and build status. Use it to understand the current state of
the Ansible content project and make informed suggestions.

**Security**: Only SELECT queries are allowed. INSERT/UPDATE/DELETE are blocked.

**Available Tables**:
- project: Project metadata (name, namespace, type, phase)
- requirements: User requirements with constrained IDs (REQ-001)
- requirement_artifacts: Artifact types per requirement
- requirement_tags: Tags for requirements
- design_decisions: Assessment Q&A for each requirement
- project_decisions: Project-wide decisions
- plan_items: Implementation plan items (ITEM-001)
- build_steps: Build progress substeps
- artifacts: Generated files
- phase_progress: Workflow progress for each phase
- sign_offs: Phase approvals
- drift_assessments: Compliance checks
- drift_findings: Individual drift issues
- history: Audit log of all actions

**Example Queries**:
- Get all requirements: SELECT * FROM requirements
- Get pending questions: SELECT * FROM design_decisions WHERE answer IS NULL
- Get plan items for a requirement: SELECT * FROM plan_items WHERE requirement_id = 'REQ-001'
- Get build progress: SELECT * FROM phase_progress
- Get recent history: SELECT * FROM history ORDER BY timestamp DESC LIMIT 10`,
    inputSchema: {
        type: 'object',
        required: ['query'],
        properties: {
            query: {
                type: 'string',
                description: 'SQL SELECT query to execute. Only SELECT statements are allowed.'
            },
            limit: {
                type: 'number',
                description: 'Maximum number of rows to return (default: 100, max: 1000)'
            }
        }
    }
};

// === Content Designer Tools ===

export const GET_REQUIREMENTS_TOOL: McpToolDefinition = {
    name: 'get_project_requirements',
    description: `Get requirements and operational guidance from the Content Designer project.

Returns TWO types of items:
1. **User Requirements (REQ-XXX)**: What the user wants to build. Generate questions/content for these.
2. **System Guidance (SYS-XXX)**: Operational instructions for YOU (the agent). Follow these as workflow guidance, do NOT generate questions for them.

The SYS-* entries are ordered as a workflow (SYS-001, SYS-002, etc.) - follow them in sequence.

Use include_system: true to get both types. Read SYS-* for your instructions, work on REQ-* as the actual requirements.`,
    inputSchema: {
        type: 'object',
        properties: {
            include_system: {
                type: 'boolean',
                description: 'Include system guidance (SYS-XXX). Set to true to get your operational instructions. Default: false'
            },
            status_filter: {
                type: 'string',
                description: 'Filter by status (draft, assessed, planned, building, complete)'
            }
        }
    }
};

export const GET_DESIGN_DECISIONS_TOOL: McpToolDefinition = {
    name: 'get_design_decisions',
    description: `Get design decisions (assessment Q&A) from the Content Designer project.

Returns answered and unanswered questions from the assessment phase, grouped by requirement.
Use this to understand what decisions have been made about architecture, security, dependencies, etc.`,
    inputSchema: {
        type: 'object',
        properties: {
            requirement_id: {
                type: 'string',
                description: 'Filter by specific requirement ID (e.g., REQ-001)'
            },
            stage: {
                type: 'string',
                description: 'Filter by assessment stage: "dependencies" or "content"',
                enum: ['dependencies', 'content']
            },
            answered_only: {
                type: 'boolean',
                description: 'Only return answered questions. Default: false'
            }
        }
    }
};

// === Collection of all static tools ===

export const STATIC_TOOLS: McpToolDefinition[] = [
    // Discovery
    SEARCH_PLUGINS_TOOL,
    GET_PLUGIN_DOC_TOOL,
    LIST_COLLECTIONS_TOOL,
    INSTALL_COLLECTION_TOOL,
    SEARCH_AVAILABLE_COLLECTIONS_TOOL,
    LIST_SOURCE_COLLECTIONS_TOOL,
    GET_COLLECTION_PLUGINS_TOOL,
    
    // Task generation
    GENERATE_TASK_TOOL,
    BUILD_TASK_TOOL,
    GENERATE_PLAYBOOK_TOOL,
    
    // Execution environments
    LIST_EE_TOOL,
    GET_EE_DETAILS_TOOL,
    
    // Dev tools
    LIST_DEV_TOOLS_TOOL,
    
    // Creator
    GET_CREATOR_SCHEMA_TOOL,
    
    // Content Designer
    QUERY_DESIGN_DB_TOOL,
    GET_REQUIREMENTS_TOOL,
    GET_DESIGN_DECISIONS_TOOL,
    GET_BEST_PRACTICES_TOOL as unknown as McpToolDefinition,
];
