// @vitest-environment jsdom
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIssue } from "../../storybook/fixtures/paperclipData";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Issues } from "./Issues";

// The default Tasks page: Issues -> CoordinatorTaskViews -> CoordinatorTasks,
// with the real TaskList, KanbanBoard and IssuesBulkBar. Only data and the
// toolbar (to flip the layout) are stubbed.
const mocks = vi.hoisted(() => ({ designSandbox: false, list: vi.fn(), update: vi.fn() }));
vi.mock("../context/DesignSandboxContext", () => ({ useDesignSandbox: () => mocks.designSandbox }));
vi.mock("@/api/heartbeats", () => ({ heartbeatsApi: { liveRunsForCompany: async () => [] } }));
vi.mock("@/api/issues", () => ({ issuesApi: { list: mocks.list, listCompact: mocks.list, get: vi.fn(), listLabels: async () => [], update: mocks.update } }));
vi.mock("@/api/attention", () => ({ attentionApi: { taskIndex: async () => ({ taskIds: [] }) } }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: async () => [{ id: "agent-1", name: "Builder", status: "idle" }] } }));
vi.mock("@/api/projects", () => ({ projectsApi: { list: async () => [] } }));
vi.mock("@/api/access", () => ({ accessApi: { listUserDirectory: async () => ({ users: [{ principalId: "operator-1", user: { name: "Rob Operator", email: null, image: null } }] }) } }));
vi.mock("@/api/companies-query", () => ({ useAccountIdentity: () => ({ userId: "viewer", settled: true }) }));
vi.mock("../hooks/useCoordinatorWorkspaceEnabled", () => ({ useCoordinatorWorkspaceEnabled: () => ({ enabled: true, loaded: true, userId: "viewer" }) }));
vi.mock("../hooks/useStreamlinedUiEnabled", () => ({ useStreamlinedUiEnabled: () => ({ enabled: true }) }));
vi.mock("../hooks/useCombinedInboxTasksEnabled", () => ({ useCombinedInboxTasksEnabled: () => ({ enabled: false }) }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company", selectedCompany: { issuePrefix: "ORG" } }) }));
vi.mock("../context/DialogContext", () => ({ useDialogActions: () => ({ openNewIssue: vi.fn() }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("@/components/TaskListToolbar", () => ({ TaskListToolbar: ({ onLayoutChange }: { onLayoutChange: (layout: "list" | "board") => void }) =>
  <button onClick={() => onLayoutChange("board")}>Board view</button> }));

const issues = [
  createIssue({ id: "task-a", identifier: "ORG-1", title: "Measure the window", companyId: "company", parentId: null, status: "todo", assigneeAgentId: null, assigneeUserId: "operator-1" }),
  createIssue({ id: "task-b", identifier: "ORG-2", title: "Order the glass", companyId: "company", parentId: null, status: "todo", assigneeAgentId: null, assigneeUserId: null }),
  createIssue({ id: "task-c", identifier: "ORG-3", title: "Fit the glass", companyId: "company", parentId: null, status: "todo", assigneeAgentId: null, assigneeUserId: null }),
];

describe("default Tasks page (Coordinator workspace)", () => {
  let root: Root, host: HTMLDivElement, client: QueryClient;
  beforeEach(() => {
    vi.clearAllMocks(); localStorage.clear();
    mocks.designSandbox = false;
    mocks.list.mockImplementation(async (_company: string, filters: { ids?: string[]; unreadForUserId?: string }) =>
      filters.unreadForUserId ? [] : filters.ids ? issues.filter(issue => filters.ids!.includes(issue.id)) : issues);
    mocks.update.mockResolvedValue({});
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  });
  afterEach(() => { flushSync(() => root.unmount()); client.clear(); host.remove(); vi.restoreAllMocks(); });

  async function mount() {
    flushSync(() => root.render(<QueryClientProvider client={client}><TooltipProvider><MemoryRouter initialEntries={["/ORG/issues?view=all"]}><Routes>
      <Route path="/ORG/issues" element={<Issues />} />
    </Routes></MemoryRouter></TooltipProvider></QueryClientProvider>));
    await vi.waitFor(() => expect(host.textContent).toContain("Order the glass"));
  }
  const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(el => el.textContent?.trim().endsWith(text));
  const box = (label: string) => host.querySelector<HTMLElement>(`[aria-label="${label}"]`);

  it.each([false, true])("shows the operator on an operator-assigned board card (design sandbox: %s)", async designSandbox => {
    mocks.designSandbox = designSandbox;
    await mount();
    act(() => { button("Board view")!.click(); });
    await vi.waitFor(() => {
      const card = [...host.querySelectorAll("a, [data-issue-id], div")].find(el => el.textContent?.includes("Measure the window") && el.textContent.length < 200 && el.textContent.includes("Rob Operator"));
      expect(card).toBeDefined();
    });
  });

  it("selects rows in the list and bulk-changes status and assignee through the API", async () => {
    await mount();
    await vi.waitFor(() => expect(box("Select ORG-1")).not.toBeNull());
    expect(host.querySelector("[aria-label='Selected tasks']")).toBeNull();
    act(() => { box("Select ORG-1")!.click(); });
    act(() => { box("Select ORG-3")!.click(); });
    expect(host.querySelector("[aria-label='Selected tasks']")?.textContent).toContain("2 selected");

    act(() => { button("Set status")!.click(); });
    await vi.waitFor(() => expect(button("In Progress")).toBeDefined());
    await act(async () => { button("In Progress")!.click(); });
    await vi.waitFor(() => expect(mocks.update.mock.calls).toEqual([["task-a", { status: "in_progress" }], ["task-c", { status: "in_progress" }]]));
    // Updated tasks leave the selection, so the bar closes.
    await vi.waitFor(() => expect(host.querySelector("[aria-label='Selected tasks']")).toBeNull());

    mocks.update.mockClear();
    act(() => { box("Select ORG-2")!.click(); });
    act(() => { button("Assign to")!.click(); });
    await vi.waitFor(() => expect(button("Builder")).toBeDefined());
    await act(async () => { button("Builder")!.click(); });
    await vi.waitFor(() => expect(mocks.update.mock.calls).toEqual([["task-b", { assigneeAgentId: "agent-1", assigneeUserId: null }]]));
  });
});
