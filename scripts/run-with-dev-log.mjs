import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const separatorIndex = args.indexOf('--');
const packageName = args[0];
const command =
    separatorIndex >= 0 ? args.slice(separatorIndex + 1) : args.slice(1);

if (!packageName || command.length === 0) {
    console.error(
        'Usage: node scripts/run-with-dev-log.mjs <package-name> -- <command> [args...]',
    );
    process.exit(1);
}

const sessionId =
    process.env.AGENT_COMPANION_DEV_SESSION_ID ?? createSessionId();
const logsDir = path.join(repoRoot, 'logs');
const logFilePath = path.join(
    logsDir,
    `${sessionId}-${sanitizePackageName(packageName)}.log`,
);

fs.mkdirSync(logsDir, { recursive: true });
const logStream = fs.createWriteStream(logFilePath, { flags: 'a' });

writeEvent('session_start', {
    packageName,
    sessionId,
    cwd: process.cwd(),
    command,
    pid: process.pid,
});

const child = spawn(command[0], command.slice(1), {
    cwd: process.cwd(),
    env: {
        ...process.env,
        AGENT_COMPANION_DEV_SESSION_ID: sessionId,
        AGENT_COMPANION_DEV_LOG_FILE: logFilePath,
    },
    stdio: ['inherit', 'pipe', 'pipe'],
});

child.stdout.on('data', (chunk) => {
    process.stdout.write(chunk);
    logStream.write(chunk);
});

child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk);
    logStream.write(chunk);
});

child.on('spawn', () => {
    writeEvent('child_spawned', {
        packageName,
        pid: child.pid,
    });
    console.error(
        `[dev-log] ${packageName}: writing session log to ${path.relative(repoRoot, logFilePath)}`,
    );
});

child.on('error', (error) => {
    writeEvent('child_error', {
        packageName,
        message: error.message,
    });
    closeLogStream(() => process.exit(1));
});

child.on('exit', (code, signal) => {
    writeEvent('session_end', {
        packageName,
        code,
        signal,
    });
    closeLogStream(() => {
        if (signal) {
            process.kill(process.pid, signal);
            return;
        }
        process.exit(code ?? 0);
    });
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
        writeEvent('signal_forwarded', {
            packageName,
            signal,
        });

        if (!child.killed) {
            child.kill(signal);
        }
    });
}

function createSessionId() {
    const now = new Date();
    const yyyy = String(now.getFullYear());
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    const ms = String(now.getMilliseconds()).padStart(3, '0');
    return `${yyyy}${mm}${dd}-${hh}${min}${ss}-${ms}`;
}

function sanitizePackageName(value) {
    return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

function writeEvent(type, payload) {
    logStream.write(
        `${JSON.stringify({
            timestamp: new Date().toISOString(),
            type,
            ...payload,
        })}\n`,
    );
}

function closeLogStream(callback) {
    logStream.end(callback);
}
