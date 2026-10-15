import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SkillSource } from '@paperclipai/shared';
import { agentsApi } from '@/api/agents';
import { companySkillsApi } from '@/api/companySkills';
import { queryKeys } from '@/lib/queryKeys';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/**
 * Adds every installed skill of one repository to the chosen agents in one go.
 * Uses the per-agent sync in "add" mode, so an agent keeps its other skills and
 * concurrent edits to its skill set are not overwritten.
 */
export function AssignSourceSkillsDialog({ companyId, source, onClose }: {
  companyId: string; source: SkillSource; onClose: () => void;
}) {
  const client = useQueryClient();
  const skillIds = source.entries.flatMap(entry => entry.skillId ? [entry.skillId] : []);
  const agents = useQuery({ queryKey: queryKeys.agents.list(companyId), queryFn: () => agentsApi.list(companyId) });
  const skills = useQuery({ queryKey: queryKeys.companySkills.list(companyId), queryFn: () => companySkillsApi.list(companyId) });
  const assignable = (agents.data ?? []).filter(agent => agent.status !== 'terminated');
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [failures, setFailures] = useState<Array<{ name: string; message: string }>>([]);
  const assign = useMutation({
    mutationFn: async () => {
      const keyById = new Map((skills.data ?? []).map(skill => [skill.id, skill.key]));
      const keys = skillIds.flatMap(id => keyById.has(id) ? [keyById.get(id)!] : []);
      const failed: Array<{ name: string; message: string }> = [];
      for (const agent of assignable.filter(candidate => chosen.has(candidate.id))) {
        try {
          await agentsApi.syncSkills(agent.id, keys, 'add', companyId);
        } catch (error) {
          failed.push({ name: agent.name, message: error instanceof Error ? error.message : String(error) });
        }
        await client.invalidateQueries({ queryKey: queryKeys.agents.skills(agent.id) });
      }
      return failed;
    },
    onSuccess: async failed => {
      await client.invalidateQueries({ queryKey: queryKeys.companySkills.list(companyId) });
      if (failed.length === 0) onClose(); else setFailures(failed);
    },
  });
  const toggle = (id: string, on: boolean) => setChosen(previous => {
    const next = new Set(previous);
    if (on) next.add(id); else next.delete(id);
    return next;
  });
  const ready = agents.isSuccess && skills.isSuccess;
  return <Dialog open onOpenChange={open => { if (!open && !assign.isPending) onClose(); }}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Assign skills to agents</DialogTitle>
        <DialogDescription>
          Adds all {skillIds.length} {skillIds.length === 1 ? 'skill' : 'skills'} from {source.fullName} to the agents you choose. Their other skills stay as they are.
        </DialogDescription>
      </DialogHeader>
      {(agents.error || skills.error) && <p role="alert" className="text-sm text-destructive">{(agents.error ?? skills.error)!.message}</p>}
      {!ready && !agents.error && !skills.error && <p role="status" className="text-sm text-muted-foreground">Loading agents…</p>}
      {ready && assignable.length === 0 && <p className="text-sm text-muted-foreground">This company has no agents yet.</p>}
      {ready && assignable.length > 0 && <ul className="max-h-72 overflow-y-auto" aria-label="Agents">
        {assignable.map(agent => <li key={agent.id}>
          <label className="flex items-center gap-2 py-1.5 text-sm">
            <Checkbox checked={chosen.has(agent.id)} onCheckedChange={value => toggle(agent.id, value === true)} aria-label={agent.name} />
            <span className="truncate">{agent.name}</span>
          </label>
        </li>)}
      </ul>}
      {failures.length > 0 && <div role="alert" className="text-sm text-destructive">
        <p>Not assigned to:</p>
        <ul className="ml-4 list-disc">{failures.map(failure => <li key={failure.name}>{failure.name}: {failure.message}</li>)}</ul>
      </div>}
      {assign.error && <p role="alert" className="text-sm text-destructive">{assign.error.message}</p>}
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={assign.isPending}>Cancel</Button>
        <Button onClick={() => { setFailures([]); assign.mutate(); }} disabled={!ready || chosen.size === 0 || skillIds.length === 0 || assign.isPending}>
          {assign.isPending ? 'Assigning…' : `Assign to ${chosen.size} ${chosen.size === 1 ? 'agent' : 'agents'}`}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
