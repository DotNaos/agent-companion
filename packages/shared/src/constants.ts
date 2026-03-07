export const CAPABILITIES = [
  "read",
  "write",
  "search",
  "list",
  "execute-tasks",
  "run-command",
] as const;

export const TOOL_NAMES = [
  "health_check",
  "list_projects",
  "create_project",
  "list_directory",
  "search_files",
  "read_file",
  "write_file",
  "start_dev_server",
  "stop_dev_server",
  "get_logs",
  "run_repo_task",
  "run_command",
  "create_todo_list",
  "update_todo_item",
  "list_todo_items",
] as const;

export const SENSITIVE_TOOLS = new Set([
  "write_file",
  "start_dev_server",
  "stop_dev_server",
  "run_repo_task",
  "run_command",
]);

export const LOCAL_LOOPBACK_HOST = "127.0.0.1";
export const DEFAULT_LOCAL_RUNNER_PORT = 4317;
export const DEFAULT_DESKTOP_SERVER_PORT = 4318;
export const DEFAULT_REMOTE_SERVER_PORT = 8787;
export const DEFAULT_ACTIVITY_LIMIT = 100;
export const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
export const DEFAULT_OUTPUT_LIMIT_BYTES = 32_000;
