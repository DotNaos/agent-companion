import type { ApprovalRequest } from "@agent-companion/shared";
import { Button } from "./ui/button.js";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./ui/card.js";
import { ScrollArea } from "./ui/scroll-area.js";

type ApprovalsViewProps = Readonly<{
  approvals: ApprovalRequest[];
  onDecideApproval: (
    id: string,
    decision: "approved" | "denied",
    remember: boolean,
  ) => void | Promise<void>;
}>;

export function ApprovalsView({
  approvals,
  onDecideApproval,
}: ApprovalsViewProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Pending Approvals</CardTitle>
        <CardDescription>
          Approve once, deny, or persist the requested permission.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {approvals.length === 0 ? (
          <div className="rounded-3xl border border-white/10 bg-slate-900/30 p-8 text-center text-slate-400">
            No approvals are waiting.
          </div>
        ) : (
          approvals.map((approval) => (
            <div
              key={approval.id}
              className="rounded-3xl border border-white/20 bg-white/5 p-5"
            >
              <div className="mb-4">
                <h4 className="text-lg font-semibold text-white">
                  {approval.toolName}
                </h4>
                <p className="mt-1 text-sm text-slate-300">
                  {approval.summary}
                </p>
              </div>
              <ScrollArea className="mb-5 h-32 w-full rounded-2xl border border-white/10 bg-black/40 p-3">
                <pre className="wrap-break-word whitespace-pre-wrap text-xs font-mono text-slate-400">
                  {JSON.stringify(approval.payload, null, 2)}
                </pre>
              </ScrollArea>
              <div className="flex flex-wrap gap-3">
                <Button
                  onClick={() =>
                    void onDecideApproval(approval.id, "approved", false)
                  }
                >
                  Approve Once
                </Button>
                <Button
                  variant="secondary"
                  onClick={() =>
                    void onDecideApproval(approval.id, "approved", true)
                  }
                >
                  Approve + Remember
                </Button>
                <Button
                  variant="ghost"
                  onClick={() =>
                    void onDecideApproval(approval.id, "denied", false)
                  }
                  className="hover:bg-red-500/10 hover:text-red-400"
                >
                  Deny
                </Button>
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
