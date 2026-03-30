import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetPluginDocumentation = vi.fn();

vi.mock('@ansible/core', () => ({
    CollectionsService: {
        getInstance: () => ({
            getPluginDocumentation: mockGetPluginDocumentation,
        }),
    },
}));

import { TaskGenerator } from '../src/taskGenerator';

function copyPluginDoc() {
    return {
        doc: {
            short_description: 'Copy files to remote locations',
            description: 'The copy module copies a file on the local machine to remote hosts.',
            options: {
                src: { required: true, type: 'str', description: 'Path to local file' },
                dest: { required: true, type: 'str', description: 'Destination path' },
                mode: { required: false, type: 'str', description: 'File mode' },
            },
        },
    };
}

describe('TaskGenerator', () => {
    let generator: TaskGenerator;

    beforeEach(() => {
        vi.clearAllMocks();
        generator = new TaskGenerator();
        mockGetPluginDocumentation.mockResolvedValue(copyPluginDoc());
    });

    it('generate produces YAML with task name, module key, and params', async () => {
        const { yaml } = await generator.generate({
            plugin: 'ansible.builtin.copy',
            params: { src: '/tmp/a', dest: '/tmp/b' },
        });

        expect(yaml).toMatch(/^- name: /m);
        expect(yaml).toContain('ansible.builtin.copy:');
        expect(yaml).toContain('src:');
        expect(yaml).toContain('dest:');
    });

    it('generate warns when required plugin params are missing', async () => {
        const { yaml, warnings } = await generator.generate({
            plugin: 'ansible.builtin.copy',
            params: { src: '/only-src' },
        });

        expect(yaml).toBeTruthy();
        expect(warnings.some(w => w.includes('Missing required parameter: dest'))).toBe(true);
    });

    it('generate includes become, when, register, loop, ignore_errors, and tags when set', async () => {
        const { yaml } = await generator.generate({
            plugin: 'ansible.builtin.copy',
            params: { src: 'x', dest: 'y' },
            become: true,
            when: "ansible_os_family == 'Debian'",
            register: 'copy_out',
            loop: ['a', 'b'],
            ignore_errors: true,
            tags: ['app', 'config'],
        });

        expect(yaml).toContain('register: copy_out');
        expect(yaml).toContain("when: ansible_os_family == 'Debian'");
        expect(yaml).toContain('loop:');
        expect(yaml).toContain('- a');
        expect(yaml).toContain('- b');
        expect(yaml).toContain('become: true');
        expect(yaml).toContain('ignore_errors: true');
        expect(yaml).toMatch(/tags:\s*\[/);
        expect(yaml).toContain('app');
        expect(yaml).toContain('config');
    });

    it('generate uses custom task_name when provided', async () => {
        const { yaml } = await generator.generate({
            plugin: 'ansible.builtin.copy',
            params: { src: 's', dest: 'd' },
            task_name: 'Deploy configuration file',
        });

        expect(yaml).toMatch(/^- name: Deploy configuration file$/m);
    });

    it('generatePlaybook wraps tasks in a play structure', async () => {
        const { yaml } = await generator.generatePlaybook({
            name: 'Configure web servers',
            hosts: 'webservers',
            tasks: [
                {
                    plugin: 'ansible.builtin.copy',
                    params: { src: 'a', dest: 'b' },
                },
            ],
        });

        expect(yaml.startsWith('---\n')).toBe(true);
        expect(yaml).toMatch(/^- name: Configure web servers$/m);
        expect(yaml).toMatch(/^\s{2}hosts: webservers$/m);
        expect(yaml).toMatch(/^\s{2}tasks:$/m);
        expect(yaml).toContain('  - name:');
        expect(yaml).toContain('    ansible.builtin.copy:');
    });

    it('generatePlaybook includes play-level become, vars, and gather_facts: false', async () => {
        const { yaml } = await generator.generatePlaybook({
            name: 'App deploy',
            hosts: 'all',
            become: true,
            gather_facts: false,
            vars: { app_version: '1.2.3', feature_enabled: true },
            tasks: [
                { plugin: 'ansible.builtin.copy', params: { src: '1', dest: '2' } },
            ],
        });

        expect(yaml).toMatch(/^\s{2}gather_facts: false$/m);
        expect(yaml).toMatch(/^\s{2}become: true$/m);
        expect(yaml).toMatch(/^\s{2}vars:$/m);
        expect(yaml).toMatch(/^\s{4}app_version: 1\.2\.3$/m);
        expect(yaml).toMatch(/^\s{4}feature_enabled: true$/m);
    });

    it('generatePlaybook passes task-level become, when, and register into each task', async () => {
        const { yaml } = await generator.generatePlaybook({
            name: 'Multi',
            hosts: 'localhost',
            tasks: [
                {
                    plugin: 'ansible.builtin.copy',
                    params: { src: 'x', dest: 'y' },
                    become: true,
                    when: 'inventory_hostname == "localhost"',
                    register: 'r1',
                },
            ],
        });

        expect(yaml).toContain('register: r1');
        expect(yaml).toContain('when:');
        expect(yaml).toContain('become: true');
    });

    it('throws when plugin documentation is missing', async () => {
        mockGetPluginDocumentation.mockResolvedValue(null);

        await expect(
            generator.generate({
                plugin: 'missing.collection.nope',
                params: {},
            }),
        ).rejects.toThrow(/Plugin not found/);
    });
});
