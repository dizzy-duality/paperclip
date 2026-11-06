import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { StatusIcon } from "./StatusIcon";

const STATUSES = ["backlog", "todo", "in_progress", "in_review", "done", "cancelled", "blocked"];

function statusLabel(status: string) {
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Changes the status or the assigned agent of every selected task. Each task
 * is updated with its own PATCH, so the server applies the same rules as a
 * single change; tasks it refuses stay selected and are listed with the reason.
 */
export function IssuesBulkBar({ companyId, selected, shownCount, agents, onSelectAllShown, onClear, onSettled }: {
  companyId: string;
  selected: Issue[];
  shownCount: number;
  agents?: Array<{ id: string; name: string; status?: string }>;
  onSelectAllShown: () => void;
  onClear: () => void;
  /** Called with the ids that were updated, so the caller can deselect them. */
  onSettled: (updatedIds: string[]) => void;
}) {
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [failures, setFailures] = useState<Array<{ label: string; message: string }>>([]);
  const [open, setOpen] = useState<"status" | "assignee" | null>(null);
  const assignable = (agents ?? []).filter((agent) => agent.status !== "terminated");

  async function apply(data: Record<string, unknown>) {
    setOpen(null);
    setFailures([]);
    const targets = selected;
    const updated: string[] = [];
    const failed: Array<{ label: string; message: string }> = [];
    setProgress({ done: 0, total: targets.length });
    for (const issue of targets) {
      try {
        await issuesApi.update(issue.id, data);
        updated.push(issue.id);
      } catch (error) {
        failed.push({ label: issue.identifier ?? issue.title, message: error instanceof Error ? error.message : String(error) });
      }
      setProgress({ done: updated.length + failed.length, total: targets.length });
    }
    setProgress(null);
    setFailures(failed);
    await queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
    onSettled(updated);
  }

  const busy = progress !== null;
  const count = selected.length;
  return (
    <div role="region" aria-label="Selected tasks" className="sticky top-0 z-20 mb-2 rounded-lg border border-border bg-background p-2 text-sm shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Checkbox
          checked={count === shownCount ? true : "indeterminate"}
          onCheckedChange={(value) => (value === true ? onSelectAllShown() : onClear())}
          disabled={busy}
          aria-label={`Select all ${shownCount} shown tasks`}
        />
        <span className="font-medium">{count} selected</span>
        <Popover open={open === "status"} onOpenChange={(next) => setOpen(next ? "status" : null)}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" disabled={busy}>Set status</Button>
          </PopoverTrigger>
          <PopoverContent className="w-44 p-1" align="start">
            {STATUSES.map((status) => (
              <Button
                key={status}
                variant="ghost"
                size="sm"
                className="w-full justify-start gap-2 text-xs"
                onClick={() => {
                  if (status === "cancelled" && !window.confirm(`Cancel ${count} ${count === 1 ? "task" : "tasks"}?`)) return;
                  void apply({ status });
                }}
              >
                <StatusIcon status={status} size="lg" />
                {statusLabel(status)}
              </Button>
            ))}
          </PopoverContent>
        </Popover>
        {agents && (
          <Popover open={open === "assignee"} onOpenChange={(next) => setOpen(next ? "assignee" : null)}>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" disabled={busy}>Assign to</Button>
            </PopoverTrigger>
            <PopoverContent className="max-h-72 w-56 overflow-y-auto p-1" align="start">
              <Button variant="ghost" size="sm" className="w-full justify-start text-xs"
                onClick={() => void apply({ assigneeAgentId: null, assigneeUserId: null })}>
                No assignee
              </Button>
              {assignable.map((agent) => (
                <Button key={agent.id} variant="ghost" size="sm" className="w-full justify-start truncate text-xs"
                  onClick={() => void apply({ assigneeAgentId: agent.id, assigneeUserId: null })}>
                  {agent.name}
                </Button>
              ))}
            </PopoverContent>
          </Popover>
        )}
        <Button variant="ghost" size="sm" onClick={onClear} disabled={busy}>Clear</Button>
        {progress && <span role="status" className="text-muted-foreground">Updating {progress.done}/{progress.total}…</span>}
      </div>
      {failures.length > 0 && (
        <div role="alert" className="mt-2 text-destructive">
          <p>Not changed (still selected):</p>
          <ul className="ml-4 list-disc">{failures.map((failure) => <li key={failure.label}>{failure.label}: {failure.message}</li>)}</ul>
        </div>
      )}
    </div>
  );
}
