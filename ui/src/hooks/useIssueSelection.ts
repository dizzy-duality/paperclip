import { useCallback, useMemo, useState } from "react";
import type { Issue } from "@paperclipai/shared";

/**
 * Row selection for a task list that feeds IssuesBulkBar. Only shown tasks
 * count as selected, so a task that leaves the view drops out of the bulk
 * action without being forgotten if it comes back.
 */
export function useIssueSelection(shown: readonly Issue[]) {
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const selected = useMemo(() => shown.filter((issue) => selectedIds.has(issue.id)), [shown, selectedIds]);
  const setSelected = useCallback((issueId: string, on: boolean) => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (on) next.add(issueId); else next.delete(issueId);
      return next;
    });
  }, []);
  return {
    selectedIds,
    selected,
    active: selected.length > 0,
    setSelected,
    /** The selection half of IssuesBulkBar's props. */
    bulkBarProps: {
      selected,
      shownCount: shown.length,
      onSelectAllShown: () => setSelectedIds(new Set(shown.map((issue) => issue.id))),
      onClear: () => setSelectedIds(new Set()),
      onSettled: (updatedIds: string[]) => setSelectedIds((previous) => {
        const next = new Set(previous);
        for (const id of updatedIds) next.delete(id);
        return next;
      }),
    },
  };
}
