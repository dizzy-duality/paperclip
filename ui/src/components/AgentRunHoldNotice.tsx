import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { agentsApi, type AgentRunHold } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "./ui/button";

function formatUntil(until: string, now = new Date()) {
  const at = new Date(until);
  const time = at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return at.toDateString() === now.toDateString()
    ? time
    : `${at.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}

export function describeAgentRunHold(hold: AgentRunHold, agentName: string, now = new Date()) {
  const waiting = `${hold.heldRuns} ${hold.heldRuns === 1 ? "run" : "runs"} waiting.`;
  if (hold.reason === "off_hours") return `Held: outside ${agentName}'s active hours. ${waiting}`;
  return hold.until
    ? `Held: ${agentName} is at its provider usage limit until ${formatUntil(hold.until, now)}. ${waiting}`
    : `Held: ${agentName} is at its provider usage limit. ${waiting}`;
}

/**
 * Says why an agent's runs sit queued ("Waiting to start...") and offers the
 * board a way to start one now. Renders nothing while no hold applies.
 */
export function AgentRunHoldNotice({ agentId, agentName, companyId, canResume }: {
  agentId: string;
  agentName: string;
  companyId: string;
  canResume: boolean;
}) {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: queryKeys.agents.runHold(agentId),
    queryFn: () => agentsApi.runHold(agentId, companyId),
    refetchInterval: 30_000,
  });
  const resume = useMutation({
    mutationFn: () => agentsApi.resumeRunHold(agentId, companyId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.agents.runHold(agentId) }),
  });
  const hold = data?.hold;
  if (!hold || hold.heldRuns === 0) return null;
  return (
    <div role="status" aria-label="Agent run hold" className="mx-(--sz-execution-blocker-inline) my-(--sz-execution-blocker-block) flex flex-wrap items-center justify-between execution-blocker-notice border border-border bg-muted text-foreground">
      <span>{describeAgentRunHold(hold, agentName)}</span>
      {canResume && (
        <Button variant="outline" size="sm" disabled={resume.isPending} onClick={() => resume.mutate()}>
          {resume.isPending ? "Starting…" : "Resume now"}
        </Button>
      )}
      {resume.isError && (
        <p role="alert" className="w-full text-destructive">{resume.error.message}</p>
      )}
    </div>
  );
}
