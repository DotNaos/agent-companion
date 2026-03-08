import type { ToolName } from "./schemas.js";

export const toolDescriptions: Record<ToolName, string> = {
  health_check: "Return the local runner health status.",
  list_projects: "List projects inside the configured projects root.",
  create_project: "Create a new project folder inside the configured projects root.",
  list_directory: "List directory contents within approved roots.",
  search_files: "Search files inside approved roots.",
  read_file: "Read a file inside approved roots.",
  write_file: "Write a file inside approved roots.",
  start_dev_server: "Start an allowlisted dev server task for an approved project.",
  stop_dev_server: "Stop a managed dev server process.",
  get_logs: "Read recent logs from managed processes.",
  run_repo_task: "Run an allowlisted repository task in an approved path.",
  run_command: "Run an explicitly allowlisted command in an approved path.",
  create_todo_list: "Create a lightweight todo list for multi-step work.",
  update_todo_item: "Update a todo list item.",
  list_todo_items: "List todo lists and items.",
  notify_pluto:
    "Ask Pluto to tell the user something directly, optionally summarizing a longer remote-agent update into a short user-facing message.",
};
