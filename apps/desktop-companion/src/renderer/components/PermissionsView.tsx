import type { AgentCompanionConfig } from '@agent-companion/shared';
import { ArrowLeft, FolderOpen, Plus, Trash2 } from 'lucide-react';
import type { Bootstrap, MCPAccessMode } from '../app-shared.js';
import { ACCESS_MODE_OPTIONS } from '../app-shared.js';
import { EditorList, RunCommandRulesEditor } from './PermissionsEditors.js';
import { Button } from './ui/button.js';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from './ui/card.js';
import { Input } from './ui/input.js';
import { Label } from './ui/label.js';
import { Textarea } from './ui/textarea.js';

type PermissionsViewProps = Readonly<{
    bootstrap: Bootstrap | null;
    draftConfig: AgentCompanionConfig | null;
    canBrowseDirectories: boolean;
    onBack: () => void;
    onAddPathEntry: () => void;
    onUpdateAccessMode: (mode: MCPAccessMode) => void;
    onUpdateDraftConfig: (
        updater: (current: AgentCompanionConfig) => AgentCompanionConfig,
    ) => void;
    onUpdatePathValue: (id: string, nextPath: string) => void;
    onBrowseForPath: (id: string) => void | Promise<void>;
    onRemovePathEntry: (id: string) => void;
}>;

export function PermissionsView({
    bootstrap,
    draftConfig,
    canBrowseDirectories,
    onBack,
    onAddPathEntry,
    onUpdateAccessMode,
    onUpdateDraftConfig,
    onUpdatePathValue,
    onBrowseForPath,
    onRemovePathEntry,
}: PermissionsViewProps) {
    return (
        <>
            <div className="mb-6">
                <Button
                    variant="ghost"
                    size="sm"
                    className="pl-0 text-slate-400 hover:text-white"
                    onClick={onBack}>
                    <ArrowLeft className="mr-1.5 h-4 w-4" /> Back to Dashboard
                </Button>
            </div>

            <div className="grid min-w-0 gap-6">
                {draftConfig ? (
                    <>
                        <Card>
                            <CardHeader>
                                <CardTitle>Projects Root</CardTitle>
                                <CardDescription>
                                    Base directory for your workspace and
                                    development
                                </CardDescription>
                            </CardHeader>
                            <CardContent>
                                <Input
                                    value={draftConfig.projectsRoot ?? ''}
                                    onChange={(event) =>
                                        onUpdateDraftConfig((current) => ({
                                            ...current,
                                            projectsRoot:
                                                event.target.value || null,
                                        }))
                                    }
                                    placeholder="/Users/you/projects"
                                    className="max-w-xl"
                                />
                            </CardContent>
                        </Card>

                        <Card>
                            <CardHeader>
                                <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                                    <div>
                                        <CardTitle>Allowed Paths</CardTitle>
                                        <CardDescription>
                                            Add directories that the MCP may
                                            access. The mode below applies
                                            globally to every path in this list.
                                        </CardDescription>
                                    </div>
                                    <Button
                                        variant="secondary"
                                        onClick={onAddPathEntry}
                                        size="sm">
                                        <Plus className="mr-1.5 h-4 w-4" /> Add
                                        Path
                                    </Button>
                                </div>
                                <div className="grid gap-2 md:max-w-sm">
                                    <Label
                                        htmlFor="mcp-access-mode"
                                        className="text-xs text-slate-400">
                                        MCP Access Mode
                                    </Label>
                                    <select
                                        id="mcp-access-mode"
                                        value={draftConfig.mcpAccessMode}
                                        onChange={(event) =>
                                            onUpdateAccessMode(
                                                event.target
                                                    .value as MCPAccessMode,
                                            )
                                        }
                                        className="h-11 rounded-full border border-white/10 bg-white/5 px-4 text-sm text-slate-100 outline-none transition focus:border-white/30">
                                        {ACCESS_MODE_OPTIONS.map((option) => (
                                            <option
                                                key={option.value}
                                                value={option.value}>
                                                {option.label}
                                            </option>
                                        ))}
                                    </select>
                                    <p className="text-xs text-slate-500">
                                        {
                                            ACCESS_MODE_OPTIONS.find(
                                                (option) =>
                                                    option.value ===
                                                    draftConfig.mcpAccessMode,
                                            )?.description
                                        }
                                    </p>
                                </div>
                            </CardHeader>
                            <CardContent className="grid gap-4">
                                {draftConfig.allowedPaths.length === 0 ? (
                                    <p className="text-sm text-slate-400">
                                        No paths added yet.
                                    </p>
                                ) : (
                                    draftConfig.allowedPaths.map((entry) => (
                                        <div
                                            key={entry.id}
                                            className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 rounded-3xl border border-white/10 bg-black/20 p-3">
                                            <Input
                                                value={entry.path}
                                                onChange={(event) =>
                                                    onUpdatePathValue(
                                                        entry.id,
                                                        event.target.value,
                                                    )
                                                }
                                                placeholder="/absolute/path/to/allowed/folder"
                                                className="h-11 bg-slate-900 font-mono text-sm focus:ring-white/20"
                                            />
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                onClick={() =>
                                                    void onBrowseForPath(
                                                        entry.id,
                                                    )
                                                }
                                                disabled={!canBrowseDirectories}
                                                className="min-w-28"
                                                title={
                                                    canBrowseDirectories
                                                        ? 'Browse for a folder'
                                                        : 'Folder browsing is only available in the desktop app'
                                                }>
                                                <FolderOpen className="mr-1.5 h-4 w-4" />{' '}
                                                Browse
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                onClick={() =>
                                                    onRemovePathEntry(entry.id)
                                                }
                                                className="text-slate-400 hover:text-red-400">
                                                <Trash2 className="h-4 w-4" />
                                            </Button>
                                        </div>
                                    ))
                                )}
                            </CardContent>
                        </Card>

                        <EditorList
                            title="Allowed Repo Tasks"
                            items={draftConfig.tasks}
                            onChange={(tasks) =>
                                onUpdateDraftConfig((current) => ({
                                    ...current,
                                    tasks,
                                }))
                            }
                        />
                        <EditorList
                            title="Allowed Dev Server Tasks"
                            items={draftConfig.devServerTasks}
                            onChange={(devServerTasks) =>
                                onUpdateDraftConfig((current) => ({
                                    ...current,
                                    devServerTasks,
                                }))
                            }
                        />
                        <RunCommandRulesEditor
                            accessMode={draftConfig.mcpAccessMode}
                            rules={draftConfig.runCommandRules}
                            onChange={(runCommandRules) =>
                                onUpdateDraftConfig((current) => ({
                                    ...current,
                                    runCommandRules,
                                }))
                            }
                        />

                        <Card>
                            <CardHeader>
                                <CardTitle>
                                    Allowed Remote Admin Origins
                                </CardTitle>
                                <CardDescription>
                                    CORS allowed origins
                                </CardDescription>
                            </CardHeader>
                            <CardContent>
                                <Textarea
                                    rows={3}
                                    value={draftConfig.auth.allowedOrigins.join(
                                        '\n',
                                    )}
                                    onChange={(event) =>
                                        onUpdateDraftConfig((current) => ({
                                            ...current,
                                            auth: {
                                                ...current.auth,
                                                allowedOrigins:
                                                    event.target.value
                                                        .split('\n')
                                                        .map((value) =>
                                                            value.trim(),
                                                        )
                                                        .filter(Boolean),
                                            },
                                        }))
                                    }
                                    className="font-mono text-sm focus:ring-white/20"
                                />
                            </CardContent>
                        </Card>
                    </>
                ) : (
                    <Card>
                        <CardContent className="py-12 text-center text-slate-400">
                            {bootstrap?.desktop.runnerRunning
                                ? 'Runner is starting. Configuration will appear once the local service answers.'
                                : (bootstrap?.desktop.runnerLastError ??
                                  'Runner is offline. Start it from the Runner card above.')}
                        </CardContent>
                    </Card>
                )}
            </div>
        </>
    );
}
