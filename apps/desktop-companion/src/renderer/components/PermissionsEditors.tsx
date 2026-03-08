import type { AgentCompanionConfig } from '@agent-companion/shared';
import { Plus, Trash2, X } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import { useState } from 'react';
import type { MCPAccessMode, RunCommandMatchMode } from '../app-shared.js';
import { Button } from './ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card.js';
import { Input } from './ui/input.js';

type EditorListProps = Readonly<{
    title: string;
    items: AgentCompanionConfig['tasks'];
    onChange: (items: AgentCompanionConfig['tasks']) => void;
}>;

export function EditorList({ title, items, onChange }: EditorListProps) {
    return (
        <Card>
            <CardHeader>
                <CardTitle>{title}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3">
                {items.map((task) => (
                    <div key={task.id} className="flex items-center gap-3">
                        <Input
                            value={task.label}
                            onChange={(event) =>
                                onChange(
                                    updateTask(items, task.id, {
                                        label: event.target.value,
                                    }),
                                )
                            }
                            placeholder="Label"
                            className="h-9 w-1/3 bg-white/5 focus:ring-white/20"
                        />
                        <Input
                            value={task.command.join(' ')}
                            onChange={(event) =>
                                onChange(
                                    updateTask(items, task.id, {
                                        command: splitCommandInput(
                                            event.target.value,
                                        ),
                                    }),
                                )
                            }
                            placeholder="npm run build"
                            className="h-9 flex-1 bg-white/5 font-mono text-sm focus:ring-white/20"
                        />
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={() =>
                                onChange(
                                    items.filter(
                                        (entry) => entry.id !== task.id,
                                    ),
                                )
                            }
                            className="h-9 w-9 shrink-0 text-slate-500 hover:text-red-400">
                            <Trash2 className="h-4 w-4" />
                        </Button>
                    </div>
                ))}
                <Button
                    variant="outline"
                    size="sm"
                    className="mt-3 w-fit rounded-full border-dashed border-white/20 text-slate-300 hover:border-white/40 hover:bg-white/5"
                    onClick={() =>
                        onChange([
                            ...items,
                            {
                                id: crypto.randomUUID(),
                                label: 'New task',
                                command: ['npm', 'run', 'build'],
                                managed: false,
                                timeoutMs: 60000,
                                outputLimitBytes: 32000,
                            },
                        ])
                    }>
                    <Plus className="mr-1.5 h-4 w-4" /> Add Task
                </Button>
            </CardContent>
        </Card>
    );
}

type RunCommandRulesEditorProps = Readonly<{
    accessMode: MCPAccessMode;
    rules: AgentCompanionConfig['runCommandRules'];
    onChange: (rules: AgentCompanionConfig['runCommandRules']) => void;
}>;

export function RunCommandRulesEditor({
    accessMode,
    rules,
    onChange,
}: RunCommandRulesEditorProps) {
    const [inputValue, setInputValue] = useState('');
    const [inputMode, setInputMode] = useState<RunCommandMatchMode>('prefix');
    const description = getAccessModeDescription(accessMode);

    const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key !== 'Enter' || !inputValue.trim()) {
            return;
        }

        event.preventDefault();
        onChange([
            ...rules,
            {
                id: crypto.randomUUID(),
                label: inputValue.trim(),
                command: splitCommandInput(inputValue),
                matchMode: inputMode,
                approvalRequired: false,
            },
        ]);
        setInputValue('');
    };

    return (
        <div className="flex flex-col items-start gap-6 py-4 md:flex-row">
            <div className="pt-2 md:w-1/3">
                <h3 className="mb-1 text-base font-medium text-slate-100">
                    Command Allowlist
                </h3>
                <p className="text-sm text-slate-400">{description}</p>
            </div>

            <div className="flex w-full flex-wrap items-center gap-2 rounded-2xl border border-white/10 bg-white/5 p-4 md:w-2/3">
                {rules.map((rule) => {
                    const cmdString = `${rule.command.join(' ')}${rule.matchMode === 'prefix' ? ' *' : ''}`;
                    return (
                        <div
                            key={rule.id}
                            className="flex min-w-0 items-center gap-1.5 rounded-lg border border-white/20 bg-transparent px-3 py-1.5 text-sm text-slate-300 hover:text-slate-100">
                            <span className="truncate">{cmdString}</span>
                            <button
                                type="button"
                                onClick={() =>
                                    onChange(
                                        rules.filter(
                                            (entry) => entry.id !== rule.id,
                                        ),
                                    )
                                }
                                className="ml-1 shrink-0 text-slate-500 hover:text-white">
                                <X className="h-3.5 w-3.5" />
                            </button>
                        </div>
                    );
                })}
                <select
                    value={inputMode}
                    onChange={(event) =>
                        setInputMode(event.target.value as RunCommandMatchMode)
                    }
                    className="h-8 rounded-full border border-white/10 bg-black/40 px-3 text-xs text-slate-200 outline-none"
                    disabled={accessMode === 'read-only'}>
                    <option value="prefix">Base / Namespace</option>
                    <option value="exact">Exact command</option>
                </select>
                <input
                    type="text"
                    className="h-8 min-w-35 flex-1 border-none bg-transparent px-2 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-0"
                    placeholder={
                        inputMode === 'prefix'
                            ? 'Add base command or namespace (e.g. pnpm or docker compose) ...'
                            : 'Add exact command (e.g. pnpm install) ...'
                    }
                    value={inputValue}
                    onChange={(event) => setInputValue(event.target.value)}
                    onKeyDown={handleKeyDown}
                    disabled={accessMode === 'read-only'}
                />
            </div>
        </div>
    );
}

function splitCommandInput(input: string) {
    return input
        .split(' ')
        .map((part) => part.trim())
        .filter(Boolean);
}

function updateTask(
    items: AgentCompanionConfig['tasks'],
    taskId: string,
    patch: Partial<AgentCompanionConfig['tasks'][number]>,
) {
    return items.map((entry) =>
        entry.id === taskId ? { ...entry, ...patch } : entry,
    );
}

function getAccessModeDescription(accessMode: MCPAccessMode) {
    if (accessMode === 'read-only') {
        return 'Read-only mode disables command execution entirely.';
    }
    if (accessMode === 'full-access') {
        return 'Full access mode allows any command inside the allowed paths. The allowlist below is kept for when you switch back to Default.';
    }
    return 'Choose whether a rule should allow one exact command or an entire base/namespace such as pnpm or docker compose.';
}
