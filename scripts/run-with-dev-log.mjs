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
const sanitizedPackageName = sanitizePackageName(packageName);
const sessionDirPath = resolveSessionDir({
    inheritedSessionDir: process.env.AGENT_COMPANION_DEV_SESSION_DIR,
    logsDir,
    sessionId,
});
const logFilePath = path.join(sessionDirPath, `${sanitizedPackageName}.log`);
const levelLogPaths = {
    info: path.join(sessionDirPath, 'info.log'),
    warn: path.join(sessionDirPath, 'warn.log'),
    error: path.join(sessionDirPath, 'error.log'),
};

fs.mkdirSync(logsDir, { recursive: true });
fs.mkdirSync(sessionDirPath, { recursive: true });

const logStream = fs.createWriteStream(logFilePath, { flags: 'a' });
const levelStreams = {
    info: fs.createWriteStream(levelLogPaths.info, { flags: 'a' }),
    warn: fs.createWriteStream(levelLogPaths.warn, { flags: 'a' }),
    error: fs.createWriteStream(levelLogPaths.error, { flags: 'a' }),
};
const outputState = {
    stderr: { buffer: '', lastLevel: 'warn' },
    stdout: { buffer: '', lastLevel: 'info' },
};

writeEvent('session_start', {
    packageName,
    sessionId,
    sessionDirectory: path.relative(repoRoot, sessionDirPath),
    cwd: process.cwd(),
    command,
    pid: process.pid,
});

const child = spawn(command[0], command.slice(1), {
    cwd: process.cwd(),
    env: {
        ...process.env,
        AGENT_COMPANION_DEV_SESSION_ID: sessionId,
        AGENT_COMPANION_DEV_SESSION_DIR: sessionDirPath,
        AGENT_COMPANION_DEV_LOG_FILE: logFilePath,
    },
    stdio: ['inherit', 'pipe', 'pipe'],
});

child.stdout.on('data', (chunk) => {
    process.stdout.write(chunk);
    writeChunk('stdout', chunk);
});

child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk);
    writeChunk('stderr', chunk);
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
    closeLogStreams(() => process.exit(1));
});

child.on('exit', (code, signal) => {
    flushPendingOutput();
    writeEvent('session_end', {
        packageName,
        code,
        signal,
    });
    closeLogStreams(() => {
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

function resolveSessionDir({ inheritedSessionDir, logsDir, sessionId }) {
    if (inheritedSessionDir) {
        return inheritedSessionDir;
    }

    return path.join(logsDir, sessionId);
}

function writeEvent(type, payload) {
    const line = `${JSON.stringify({
        timestamp: new Date().toISOString(),
        type,
        ...payload,
    })}\n`;
    writeLine(line, classifyStructuredEvent(type, payload));
}

function writeChunk(source, chunk) {
    const state = outputState[source];
    const text = Buffer.isBuffer(chunk)
        ? chunk.toString('utf8')
        : String(chunk);
    state.buffer += text;

    while (true) {
        const newlineIndex = state.buffer.indexOf('\n');
        if (newlineIndex === -1) {
            break;
        }

        const line = state.buffer.slice(0, newlineIndex + 1);
        state.buffer = state.buffer.slice(newlineIndex + 1);
        const level = classifyTextLine(line, source, state.lastLevel);
        state.lastLevel = level;
        writeLine(line, level);
    }
}

function flushPendingOutput() {
    for (const [source, state] of Object.entries(outputState)) {
        if (!state.buffer) {
            continue;
        }

        const line = state.buffer.endsWith('\n')
            ? state.buffer
            : `${state.buffer}\n`;
        const level = classifyTextLine(line, source, state.lastLevel);
        state.lastLevel = level;
        writeLine(line, level);
        state.buffer = '';
    }
}

function writeLine(line, level) {
    logStream.write(line);
    levelStreams[level].write(formatLevelLine(line));
}

function formatLevelLine(line) {
    const normalized = line.endsWith('\n') ? line.slice(0, -1) : line;
    return `[${sanitizedPackageName}] ${normalized}\n`;
}

function classifyStructuredEvent(type, payload) {
    if (type === 'child_error') {
        return 'error';
    }

    if (type === 'session_end') {
        if (payload.signal) {
            return 'warn';
        }

        return payload.code && payload.code !== 0 ? 'error' : 'info';
    }

    if (type === 'signal_forwarded') {
        return 'warn';
    }

    return 'info';
}

function classifyTextLine(line, source, lastLevel) {
    const trimmed = line.trim();
    if (!trimmed) {
        return lastLevel;
    }

    const structuredLevel = classifyJsonLine(trimmed);
    if (structuredLevel) {
        return structuredLevel;
    }

    const explicitMatch = trimmed.match(
        /\b(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\b/i,
    );
    if (explicitMatch) {
        return normalizeLevel(explicitMatch[1]);
    }

    if (/^\s/.test(line)) {
        return lastLevel;
    }

    if (source === 'stderr') {
        return /error|failed|exception|enoent/i.test(trimmed)
            ? 'error'
            : 'warn';
    }

    return 'info';
}

function classifyJsonLine(trimmed) {
    if (!trimmed.startsWith('{')) {
        return null;
    }

    try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed.level === 'string') {
            return normalizeLevel(parsed.level);
        }
        if (typeof parsed.type === 'string') {
            return classifyStructuredEvent(parsed.type, parsed);
        }
    } catch {
        return null;
    }

    return null;
}

function normalizeLevel(level) {
    const normalized = String(level).toLowerCase();
    if (normalized === 'error' || normalized === 'fatal') {
        return 'error';
    }
    if (normalized === 'warn' || normalized === 'warning') {
        return 'warn';
    }
    return 'info';
}

function closeLogStreams(callback) {
    logStream.end(() => {
        levelStreams.info.end(() => {
            levelStreams.warn.end(() => {
                levelStreams.error.end(callback);
            });
        });
    });
}
