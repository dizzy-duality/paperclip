// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillSource } from '@paperclipai/shared';
import { AssignSourceSkillsDialog } from './AssignSourceSkillsDialog';
import { agentsApi } from '@/api/agents';
import { companySkillsApi } from '@/api/companySkills';

vi.mock('@/api/agents', () => ({ agentsApi: { list: vi.fn(), skills: vi.fn(), syncSkills: vi.fn() } }));
vi.mock('@/api/companySkills', () => ({ companySkillsApi: { list: vi.fn() } }));

const entry = (id: string, skillId: string | null) => ({ id, sourceId: 's1', path: `skills/${id}`, name: id, description: null, skillId, selection: 'selected' as const, present: true, error: null });
const source = { id: 's1', fullName: 'acme/team-skills', entries: [entry('a', 'skill-a'), entry('b', 'skill-b'), entry('c', null)] } as unknown as SkillSource;

let root: Root;
let host: HTMLDivElement;
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
function byText(text: string) { return [...document.querySelectorAll<HTMLElement>('button, [role="checkbox"]')].find(el => el.textContent === text || el.getAttribute('aria-label') === text); }

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.mocked(agentsApi.list).mockResolvedValue([
    { id: 'ag1', name: 'Builder', status: 'idle' }, { id: 'ag2', name: 'Reviewer', status: 'active' }, { id: 'ag3', name: 'Retired', status: 'terminated' },
  ] as never);
  vi.mocked(companySkillsApi.list).mockResolvedValue([{ id: 'skill-a', key: 'github/1/aaa/a' }, { id: 'skill-b', key: 'github/1/bbb/b' }, { id: 'other', key: 'local/x/other' }] as never);
  // Builder already has skill a (pinned): re-sending it would drop the pin.
  vi.mocked(agentsApi.skills).mockImplementation(async (id: string) => ({ desiredSkills: id === 'ag1' ? ['github/1/aaa/a'] : [] }) as never);
  vi.mocked(agentsApi.syncSkills).mockImplementation(async (id: string) => {
    if (id === 'ag2') throw new Error('Permission denied');
    return {} as never;
  });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.clearAllMocks(); });

describe('AssignSourceSkillsDialog', () => {
  it("adds the repository's installed skills each chosen agent lacks and names the agents it could not update", async () => {
    const onClose = vi.fn();
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={client}><AssignSourceSkillsDialog companyId="c1" source={source} onClose={onClose} /></QueryClientProvider>));
    await flush(); await flush();

    expect(byText('Retired')).toBeUndefined();
    await act(async () => { byText('Builder')!.click(); });
    await act(async () => { byText('Reviewer')!.click(); });
    await act(async () => { byText('Assign to 2 agents')!.click(); });
    await flush(); await flush();

    expect(vi.mocked(agentsApi.syncSkills).mock.calls).toEqual([
      ['ag1', ['github/1/bbb/b'], 'add', 'c1'],
      ['ag2', ['github/1/aaa/a', 'github/1/bbb/b'], 'add', 'c1'],
    ]);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Reviewer: Permission denied');
    expect(onClose).not.toHaveBeenCalled();
  });
});
