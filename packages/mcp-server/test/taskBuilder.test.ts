import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGetPluginDocumentation = vi.fn();

vi.mock('@ansible/core', () => ({
    CollectionsService: {
        getInstance: () => ({
            getPluginDocumentation: mockGetPluginDocumentation,
        }),
    },
}));

import { TaskBuilder } from '../src/taskBuilder';

function copyPluginDoc() {
    return {
        doc: {
            short_description: 'Copy files',
            options: {
                src: { required: true, type: 'str', description: 'Source file' },
                dest: { required: true, type: 'str', description: 'Destination' },
                mode: { required: false, type: 'str', description: 'Mode', default: '0644' },
            },
        },
    };
}

describe('TaskBuilder', () => {
    let builder: TaskBuilder;

    beforeEach(() => {
        vi.clearAllMocks();
        mockGetPluginDocumentation.mockResolvedValue(copyPluginDoc());
        builder = new TaskBuilder();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('creates a session and lists missing required parameters', async () => {
        const result = await builder.build({ plugin: 'ansible.builtin.copy' });

        expect(result.status).toBe('in_progress');
        expect(result.session_id).toMatch(/^task_/);
        expect(result.plugin).toBe('ansible.builtin.copy');
        expect(result.missing_required?.sort()).toEqual(['dest', 'src']);
        expect(result.can_generate).toBe(false);
        expect(result.message).toContain('**Required parameters');
        expect(result.message).toContain('src');
        expect(result.message).toContain('dest');
        expect(result.optional_available).toContain('mode');
    });

    it('tracks collected params and updates missing required list', async () => {
        const first = await builder.build({ plugin: 'ansible.builtin.copy' });
        const sid = first.session_id!;

        const second = await builder.build({
            session_id: sid,
            params: { src: '/local/file' },
        });

        expect(second.status).toBe('in_progress');
        expect(second.missing_required).toEqual(['dest']);
        expect(second.collected).toMatchObject({ src: '/local/file' });
        expect(second.can_generate).toBe(false);
    });

    it('prompts in the message when generate is true but required params are missing', async () => {
        const first = await builder.build({ plugin: 'ansible.builtin.copy' });
        const sid = first.session_id!;

        const result = await builder.build({
            session_id: sid,
            generate: true,
        });

        expect(result.status).toBe('in_progress');
        expect(result.can_generate).toBe(false);
        expect(result.message).toContain('Cannot generate yet');
        expect(result.message).toContain('missing required');
    });

    it('generates YAML and completes when all required params are provided and generate is true', async () => {
        const first = await builder.build({ plugin: 'ansible.builtin.copy' });
        const sid = first.session_id!;

        const result = await builder.build({
            session_id: sid,
            params: { src: '/a', dest: '/b', mode: '0600' },
            task_name: 'Copy app file',
            become: true,
            register: 'copy_result',
            when: 'ansible_os_family == "Debian"',
            generate: true,
        });

        expect(result.status).toBe('complete');
        expect(result.yaml).toContain('- name: Copy app file');
        expect(result.yaml).toContain('ansible.builtin.copy:');
        expect(result.yaml).toContain('src: /a');
        expect(result.yaml).toContain('dest: /b');
        expect(result.yaml).toContain('mode:');
        expect(result.yaml).toContain('register: copy_result');
        expect(result.yaml).toContain('when:');
        expect(result.yaml).toContain('become: true');
        expect(builder.getActiveSessionCount()).toBe(0);
    });

    it('cancel clears the session', async () => {
        const first = await builder.build({ plugin: 'ansible.builtin.copy' });
        const sid = first.session_id!;
        expect(builder.getActiveSessionCount()).toBe(1);

        const cancelled = await builder.build({
            session_id: sid,
            cancel: true,
        });

        expect(cancelled.status).toBe('cancelled');
        expect(cancelled.message).toContain('cancelled');
        expect(builder.getActiveSessionCount()).toBe(0);
    });

    it('expires sessions after TTL and rejects stale session_id', async () => {
        const now = vi.spyOn(Date, 'now');
        now.mockReturnValue(1_700_000_000_000);

        const first = await builder.build({ plugin: 'ansible.builtin.copy' });
        const sid = first.session_id!;

        now.mockReturnValue(1_700_000_000_000 + 11 * 60 * 1000);

        const afterExpiry = await builder.build({
            session_id: sid,
            params: { src: 'x', dest: 'y' },
        });

        expect(afterExpiry.status).toBe('error');
        expect(afterExpiry.message).toContain('session_id');

        now.mockRestore();
    });

    it('returns error when neither plugin nor valid session_id is provided', async () => {
        const result = await builder.build({ session_id: 'task_nonexistent_xxx' });

        expect(result.status).toBe('error');
        expect(result.message).toContain('Provide either session_id');
    });
});
