# MCP Tools

Every tool uses a strict shared Zod schema in `packages/shared/src/schemas.ts`.

## `health_check`

- Input: `{}`
- Output: `{ status: "ok", timestamp: string }`
- Restrictions: none

## `list_projects`

- Input: `{}`
- Output: `{ projectsRoot, projects[] }`
- Restrictions: reads only the configured `projectsRoot`

## `create_project`

- Input: `{ name }`
- Output: `{ created, path }`
- Restrictions: only creates `projectsRoot/name`; traversal is rejected at schema and path-policy level

## `list_directory`

- Input: `{ path }`
- Output: `{ path, entries[] }`
- Restrictions: path must be inside an allowed root with `list`

## `search_files`

- Input: `{ path, query, maxResults }`
- Output: `{ matches[] }`
- Restrictions: path must be inside an allowed root with `search`

## `read_file`

- Input: `{ path, maxBytes }`
- Output: `{ path, content, truncated }`
- Restrictions: path must be inside an allowed root with `read`

## `write_file`

- Input: `{ path, content }`
- Output: `{ path, bytesWritten }`
- Restrictions: path must be inside an allowed root with `write`; can also require approval

## `start_dev_server`

- Input: `{ projectPath, taskId }`
- Output: `{ processId, taskId }`
- Restrictions: `projectPath` needs `execute-tasks`; `taskId` must exist in the dev-server allowlist

## `stop_dev_server`

- Input: `{ processId }`
- Output: `{ processId, stopped }`
- Restrictions: can require approval; only stops managed processes

## `get_logs`

- Input: `{ processId?, limit }`
- Output: `{ entries[] }`
- Restrictions: returns managed-process logs only

## `run_repo_task`

- Input: `{ projectPath, taskId }`
- Output: `{ exitCode, stdout, stderr }`
- Restrictions: path needs `execute-tasks`; task must be in the allowlist; no shell

## `run_command`

- Input: `{ workingDirectory, command[] }`
- Output: `{ exitCode, stdout, stderr, approvedViaRule }`
- Restrictions:
  - denied by default
  - cwd must have `run-command`
  - command must match an exact allowlist rule or wait for approval
  - never runs through a shell

## `create_todo_list`

- Input: `{ title, items[] }`
- Output: `{ listId, items[] }`
- Restrictions: local runner only

## `update_todo_item`

- Input: `{ listId, itemId, text?, completed? }`
- Output: `{ updated }`
- Restrictions: local runner only

## `list_todo_items`

- Input: `{ listId? }`
- Output: `{ lists[] }`
- Restrictions: local runner only
