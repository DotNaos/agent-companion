import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const logsDir = path.join(repoRoot, 'logs');

if (!fs.existsSync(logsDir)) {
    console.log('[logs:clean] No logs directory found. Nothing to clean.');
    process.exit(0);
}

const entries = fs.readdirSync(logsDir);

if (entries.length === 0) {
    console.log('[logs:clean] Logs directory is already empty.');
    process.exit(0);
}

for (const entry of entries) {
    fs.rmSync(path.join(logsDir, entry), { recursive: true, force: true });
}

console.log(
    `[logs:clean] Removed ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} from logs/.`,
);
