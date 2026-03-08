# AGENTS.md

## agent-companion working notes

- When a user reports that something is broken, flaky, or behaving unexpectedly during development, check the repo-root `logs/` directory before guessing.
- Treat the per-session log files in `logs/` as the first debugging source for `pnpm dev` issues.
- Look for the newest log file that matches the package involved, using the session timestamp and package name in the filename.
- Review both structured session events and captured `stdout` / `stderr` from the relevant dev process.
- If the issue spans multiple packages, inspect the matching log files from the same session timestamp together.
- Mention relevant log findings in your response so the user does not have to restate what failed.
