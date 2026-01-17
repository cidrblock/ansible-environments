#!/usr/bin/env node
/**
 * Ansible Environments MCP Server
 * 
 * Standalone MCP server that exposes Ansible tools for AI agents.
 * Can be used with Cursor, VS Code Copilot, or any MCP-compatible client.
 * 
 * Usage:
 *   node out/mcp/server.js
 *   
 * Or via npx (when published):
 *   npx @ansible/environments-mcp
 * 
 * Configuration for Cursor (.cursor/mcp.json):
 * {
 *   "mcpServers": {
 *     "ansible-environments": {
 *       "command": "node",
 *       "args": ["/path/to/extension/out/mcp/server.js"]
 *     }
 *   }
 * }
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { STATIC_TOOLS, McpToolDefinition } from './tools';
import { McpToolHandler } from './handlers';

// Initialize the server
const server = new Server(
    {
        name: 'ansible-environments',
        version: '1.0.0',
    },
    {
        capabilities: {
            tools: {},
        },
    }
);

// Tool handler instance
const handler = new McpToolHandler();

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Ensure handler is initialized
    await handler.initialize();
    
    // Combine static tools with dynamic creator tools
    const creatorTools = handler.getCreatorTools();
    const allTools: McpToolDefinition[] = [
        ...STATIC_TOOLS,
        ...creatorTools.getTools(),
    ];
    
    return {
        tools: allTools.map(tool => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
        })),
    };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    
    // Ensure handler is initialized
    await handler.initialize();
    
    const result = await handler.handleTool(name, args || {});
    
    return {
        content: result.content,
        isError: result.isError,
    };
});

// Error handling
server.onerror = (error) => {
    console.error('[MCP Server Error]', error);
};

// Graceful shutdown
process.on('SIGINT', async () => {
    console.error('[MCP Server] Shutting down...');
    await server.close();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.error('[MCP Server] Shutting down...');
    await server.close();
    process.exit(0);
});

// Start the server
async function main() {
    console.error('[MCP Server] Starting Ansible Environments MCP server...');
    
    try {
        // Initialize handler (loads collections, creator schema, etc.)
        await handler.initialize();
        console.error('[MCP Server] Handler initialized');
        
        // Connect via stdio
        const transport = new StdioServerTransport();
        await server.connect(transport);
        
        console.error('[MCP Server] Connected and ready');
    } catch (error) {
        console.error('[MCP Server] Failed to start:', error);
        process.exit(1);
    }
}

main();
