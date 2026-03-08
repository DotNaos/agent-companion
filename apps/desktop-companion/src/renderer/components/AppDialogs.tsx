import { Check, Copy, ExternalLink } from "lucide-react";
import { useState } from "react";
import { Button, buttonVariants } from "./ui/button.js";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./ui/card.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.js";
import { Input } from "./ui/input.js";

type ConfirmFullAccessDialogProps = Readonly<{
  onCancel: () => void;
  onConfirm: () => void;
}>;

export function ConfirmFullAccessDialog({
  onCancel,
  onConfirm,
}: ConfirmFullAccessDialogProps) {
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onCancel())}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Enable full access?</DialogTitle>
          <DialogDescription>
            Full access allows arbitrary commands and broader MCP capabilities
            inside every allowed path. Only enable it when you fully trust this
            setup.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-2xl border border-amber-500/20 bg-amber-500/8 p-4 text-sm text-amber-100">
          This applies globally to every allowed path in the list.
        </div>

        <div className="flex justify-end gap-3">
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            onClick={onConfirm}
            className="bg-white text-black hover:bg-slate-200"
          >
            Confirm full access
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

type SetupGuideModalProps = Readonly<{
  onClose: () => void;
  publicAdminUrl: string | null;
  publicMcpUrl: string | null;
  tunnelRunning: boolean;
}>;

export function SetupGuideModal({
  onClose,
  publicAdminUrl,
  publicMcpUrl,
  tunnelRunning,
}: SetupGuideModalProps) {
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="setup-modal">
        <DialogHeader className="pr-10">
          <p className="eyebrow">agent-companion</p>
          <DialogTitle>ChatGPT MCP Setup</DialogTitle>
          <DialogDescription>
            This guide only covers the tunnel and how to link your MCP server in
            ChatGPT Apps &amp; Connectors.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-6 grid gap-4">
          <Card className="border-white/10 bg-slate-900/50">
            <CardHeader>
              <CardTitle className="text-2xl">Use these public URLs</CardTitle>
              <CardDescription>
                In ChatGPT Apps &amp; Connectors, use the MCP server URL. The
                admin dashboard URL is not the one you paste into the app
                connection.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              <SetupUrlField
                label="MCP server URL for ChatGPT"
                value={publicMcpUrl ?? "Not detected yet"}
                disabled={!publicMcpUrl}
              />
              <SetupUrlField
                label="Remote admin URL"
                value={publicAdminUrl ?? "Not detected yet"}
                disabled={!publicAdminUrl}
              />
            </CardContent>
          </Card>

          <SetupStep
            index={1}
            done={tunnelRunning}
            title="Start the tunnel"
            description="Use the Tunnel card in the dashboard. It should switch to Running and keep the MCP host reachable from the public Internet."
          />
          <SetupStep
            index={2}
            title="Open ChatGPT Apps & Connectors"
            description="Create or import a custom remote MCP server in ChatGPT. The URL you paste there is the MCP server URL shown above."
          />
          <SetupStep
            index={3}
            title="Paste the MCP hostname"
            description="Use the MCP URL exactly as shown. Do not use the admin dashboard URL for the ChatGPT app connection."
          />
          <SetupStep
            index={4}
            title="Complete the auth flow"
            description="When ChatGPT connects, sign in and approve access so ChatGPT can reach your remote MCP server."
          />
          <SetupStep
            index={5}
            title="Connect from ChatGPT"
            description="After the app is linked on ChatGPT web, you can use the same connection in chat and in compatible clients like the API Playground."
          />
          <SetupStep
            index={6}
            title="Keep OAuth and review redirects in mind"
            description="For a ChatGPT app flow, ChatGPT will use its own OAuth redirect URL shown in the app management page. Your auth server must allowlist that redirect in addition to your local Google setup."
          />
          <SetupStep
            index={7}
            title="Verify the full flow"
            description="Run a simple prompt in ChatGPT after linking the app and confirm that the remote MCP server is reachable and can answer tool calls."
          />

          <div className="flex justify-end pt-2">
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

type SetupStepProps = Readonly<{
  index: number;
  title: string;
  description: string;
  done?: boolean;
}>;

function SetupStep({
  index,
  title,
  description,
  done = false,
}: SetupStepProps) {
  return (
    <Card className="bg-slate-950/50">
      <CardContent className="grid grid-cols-[52px_1fr] gap-4 p-5">
        <div className={`setup-check ${done ? "done" : ""}`}>
          {done ? "Done" : index}
        </div>
        <div>
          <h3 className="font-['IBM_Plex_Sans'] text-2xl font-semibold text-white">
            {title}
          </h3>
          <p className="mt-2 text-base leading-7 text-slate-400">
            {description}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

type SetupUrlFieldProps = Readonly<{
  label: string;
  value: string;
  disabled?: boolean;
}>;

function SetupUrlField({ label, value, disabled }: SetupUrlFieldProps) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="grid gap-2">
      <span className="text-sm font-medium text-slate-200">{label}</span>
      <div className="relative">
        <Input
          value={value}
          readOnly
          disabled={disabled}
          className="pr-24 font-mono text-xs sm:text-sm"
        />
        <div className="absolute inset-y-0 right-2 flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            disabled={disabled}
            onClick={async () => {
              await navigator.clipboard.writeText(value);
              setCopied(true);
              globalThis.setTimeout(() => setCopied(false), 1400);
            }}
          >
            {copied ? (
              <Check className="h-4 w-4" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
          </Button>
          {value.startsWith("https://") ? (
            <a
              href={value}
              target="_blank"
              rel="noreferrer"
              className={buttonVariants({
                variant: "ghost",
                size: "icon",
              })}
              aria-disabled={disabled}
            >
              <ExternalLink className="h-4 w-4" />
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );
}
