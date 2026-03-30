import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const hoisted = vi.hoisted(() => {
    const getPluginDocumentation = vi.fn();
    const collectionsInstance = {
        getPluginDocumentation,
        isLoaded: () => true,
        forceRefresh: vi.fn().mockResolvedValue(undefined),
        refresh: vi.fn().mockResolvedValue(undefined),
        listCollectionNames: vi.fn(() => []),
        getCollection: vi.fn(() => undefined),
        getCollections: vi.fn(() => new Map()),
        listPluginTypes: vi.fn(() => []),
        getPlugins: vi.fn(() => []),
        installCollection: vi.fn().mockResolvedValue('installed'),
    };
    return { getPluginDocumentation, collectionsInstance };
});

vi.mock('@ansible/core', () => ({
    CollectionsService: {
        getInstance: vi.fn(() => hoisted.collectionsInstance),
    },
    DevToolsService: {
        getInstance: vi.fn(() => ({
            isLoaded: () => true,
            refresh: vi.fn().mockResolvedValue(undefined),
            getPackages: vi.fn(() => [{ name: 'ansible-lint', version: '1.0.0' }]),
        })),
    },
    ExecutionEnvService: {
        getInstance: vi.fn(() => ({
            loadExecutionEnvironments: vi.fn().mockResolvedValue([]),
            loadDetails: vi.fn().mockResolvedValue(null),
        })),
    },
    CreatorService: {
        getInstance: vi.fn(() => ({
            isLoaded: () => true,
            refresh: vi.fn().mockResolvedValue(undefined),
            getSchema: vi.fn(() => null),
            loadSchema: vi.fn().mockResolvedValue(null),
        })),
    },
    GalaxyCollectionCache: {
        getInstance: vi.fn(() => ({
            ensureLoaded: vi.fn().mockResolvedValue(undefined),
            search: vi.fn(() => []),
            getCollections: vi.fn(() => []),
        })),
    },
    GitHubCollectionCache: {
        getInstance: vi.fn(() => ({
            loadFromDisk: vi.fn(),
            search: vi.fn(() => []),
            getCollections: vi.fn(() => []),
        })),
    },
}));

import { McpToolHandler } from '../src/handlers';

describe('McpToolHandler', () => {
    let handler: McpToolHandler;

    beforeEach(async () => {
        vi.clearAllMocks();
        hoisted.getPluginDocumentation.mockResolvedValue({
            doc: {
                short_description: 'Copy files',
                options: {
                    src: { required: true, type: 'str', description: 'src' },
                    dest: { required: true, type: 'str', description: 'dest' },
                },
            },
        });
        handler = new McpToolHandler();
        await handler.initialize();
    });

    it('returns error for unknown tool name', async () => {
        const result = await handler.handleTool('not_a_real_tool', {});

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Unknown tool');
    });

    it('routes search_ansible_plugins to the search handler', async () => {
        const result = await handler.handleTool('search_ansible_plugins', { query: 'copy' });

        expect(result.isError).toBeUndefined();
        expect(result.content[0].text).toContain('plugins');
    });

    it('routes get_plugin_documentation to the doc handler', async () => {
        const result = await handler.handleTool('get_plugin_documentation', {
            plugin: 'ansible.builtin.copy',
        });

        expect(result.isError).toBeUndefined();
        expect(result.content[0].text).toContain('ansible.builtin.copy');
        expect(hoisted.getPluginDocumentation).toHaveBeenCalledWith('ansible.builtin.copy', 'module');
    });

    it('routes generate_ansible_task through TaskGenerator', async () => {
        const result = await handler.handleTool('generate_ansible_task', {
            plugin: 'ansible.builtin.copy',
            params: { src: 'a', dest: 'b' },
        });

        expect(result.isError).toBeUndefined();
        expect(result.content[0].text).toContain('```yaml');
        expect(result.content[0].text).toContain('ansible.builtin.copy');
    });

    it('routes creator-prefixed tools to CreatorToolGenerator', async () => {
        const result = await handler.handleTool('ac_fake_command', {});

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Unknown creator tool');
    });
});
