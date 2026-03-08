import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const DEFAULT_SAMPLE_SECONDS = 3;
const DEFAULT_MAX_PROCESSES = 5;
const PROFILE_ROOT = path.join(repoRoot, 'profiles', 'desktop');
const DESKTOP_USER_DATA_SEGMENT = '@agent-companion/desktop-companion';

const options = parseArgs(process.argv.slice(2));
const timestamp = createSessionId();
const outputDir = path.join(PROFILE_ROOT, timestamp);

fs.mkdirSync(outputDir, { recursive: true });

const branch =
    safeRun('git', ['rev-parse', '--abbrev-ref', 'HEAD'])?.trim() ?? 'unknown';
const commit = safeRun('git', ['rev-parse', 'HEAD'])?.trim() ?? 'unknown';
const psOutput = requiredRun('ps', [
    '-Ao',
    'pid,ppid,%cpu,%mem,command',
    '-ww',
]);
fs.writeFileSync(path.join(outputDir, 'ps.txt'), psOutput, 'utf8');

const processes = parsePsOutput(psOutput)
    .filter((entry) => isDesktopProcess(entry.command))
    .map((entry) => ({
        ...entry,
        kind: classifyProcess(entry.command),
    }))
    .sort((left, right) => right.cpu - left.cpu);

if (processes.length === 0) {
    console.error(
        '[profile:desktop] No desktop companion Electron processes found. Start the desktop app first.',
    );
    process.exit(1);
}

const selectedProcesses = selectProcesses(processes, options.maxProcesses);
const latestLogDir = findLatestSessionLogDir(path.join(repoRoot, 'logs'));
if (latestLogDir) {
    copyLogDir(latestLogDir, path.join(outputDir, 'logs'));
}

const samples = [];
for (const entry of selectedProcesses) {
    const safeKind = entry.kind.replaceAll(/[^a-z0-9-]+/gi, '-');
    const samplePath = path.join(
        outputDir,
        `sample-${safeKind}-${entry.pid}.txt`,
    );
    const vmmapPath = path.join(
        outputDir,
        `vmmap-${safeKind}-${entry.pid}.txt`,
    );

    const sampled = runToFile('sample', [
        String(entry.pid),
        String(options.sampleSeconds),
        '-mayDie',
        '-file',
        samplePath,
    ]);
    const vmmapped = runToFile('vmmap', [String(entry.pid)], vmmapPath);

    samples.push({
        pid: entry.pid,
        kind: entry.kind,
        samplePath: sampled ? path.basename(samplePath) : null,
        vmmapPath: vmmapped ? path.basename(vmmapPath) : null,
    });
}

const logSignals = latestLogDir
    ? analyzeCopiedLogs(path.join(outputDir, 'logs'))
    : {
          sessionId: null,
          websocketWarnings: 0,
          dialogWarnings: 0,
          cspWarnings: 0,
          plutoMentions: 0,
      };
const heuristics = buildHeuristics(processes, outputDir, logSignals);

const profileJson = {
    createdAt: new Date().toISOString(),
    host: os.hostname(),
    platform: `${process.platform}-${process.arch}`,
    branch,
    commit,
    outputDir: path.relative(repoRoot, outputDir),
    options,
    latestLogSession: latestLogDir ? path.basename(latestLogDir) : null,
    processes,
    selectedProcesses,
    samples,
    heuristics,
    logSignals,
};

fs.writeFileSync(
    path.join(outputDir, 'profile.json'),
    JSON.stringify(profileJson, null, 2),
    'utf8',
);

const summary = renderSummary({
    branch,
    commit,
    heuristics,
    logSignals,
    outputDir,
    processes,
    repoRoot,
    selectedProcesses,
    timestamp,
});
fs.writeFileSync(path.join(outputDir, 'summary.md'), summary, 'utf8');

console.log(
    `[profile:desktop] Wrote desktop profile bundle to ${path.relative(repoRoot, outputDir)}`,
);
console.log(
    `[profile:desktop] Summary: ${path.relative(repoRoot, path.join(outputDir, 'summary.md'))}`,
);

function parseArgs(args) {
    const parsed = {
        sampleSeconds: DEFAULT_SAMPLE_SECONDS,
        maxProcesses: DEFAULT_MAX_PROCESSES,
    };

    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === '--sample-seconds') {
            parsed.sampleSeconds = parsePositiveInt(
                args[index + 1],
                DEFAULT_SAMPLE_SECONDS,
            );
            index += 1;
            continue;
        }
        if (arg === '--max-processes') {
            parsed.maxProcesses = parsePositiveInt(
                args[index + 1],
                DEFAULT_MAX_PROCESSES,
            );
            index += 1;
        }
    }

    return parsed;
}

function parsePositiveInt(value, fallback) {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function requiredRun(command, args) {
    return execFileSync(command, args, {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

function safeRun(command, args) {
    try {
        return requiredRun(command, args);
    } catch {
        return null;
    }
}

function runToFile(command, args, explicitOutputPath = null) {
    try {
        const output = requiredRun(command, args);
        if (explicitOutputPath) {
            fs.writeFileSync(explicitOutputPath, output, 'utf8');
        }
        return true;
    } catch (error) {
        const destination = explicitOutputPath ?? null;
        if (destination) {
            fs.writeFileSync(
                destination,
                `Command failed: ${command} ${args.join(' ')}\n${String(error)}`,
                'utf8',
            );
        }
        return false;
    }
}

function parsePsOutput(output) {
    return output
        .split('\n')
        .slice(1)
        .map((line) =>
            line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(.*)$/),
        )
        .filter(Boolean)
        .map((match) => ({
            pid: Number.parseInt(match[1], 10),
            ppid: Number.parseInt(match[2], 10),
            cpu: Number.parseFloat(match[3]),
            mem: Number.parseFloat(match[4]),
            command: match[5],
        }));
}

function isDesktopProcess(command) {
    return (
        command.includes(DESKTOP_USER_DATA_SEGMENT) ||
        command.includes(`${path.sep}apps${path.sep}desktop-companion`) ||
        command.includes(`${path.sep}node_modules${path.sep}electron`) ||
        command.includes('electron .')
    );
}

function classifyProcess(command) {
    if (command.includes('--type=gpu-process')) {
        return 'gpu';
    }
    if (command.includes('--type=renderer')) {
        return 'renderer';
    }
    if (command.includes('--utility-sub-type=audio.mojom.AudioService')) {
        return 'audio-service';
    }
    if (command.includes('--utility-sub-type=network.mojom.NetworkService')) {
        return 'network-service';
    }
    if (
        command.includes('Contents/MacOS/Electron .') ||
        command.endsWith('electron .')
    ) {
        return 'main';
    }
    return 'other';
}

function selectProcesses(processes, maxProcesses) {
    const selected = [];
    const seenKinds = new Set();
    for (const entry of processes) {
        if (!seenKinds.has(entry.kind) || selected.length < maxProcesses) {
            selected.push(entry);
            seenKinds.add(entry.kind);
        }
        if (selected.length >= maxProcesses) {
            break;
        }
    }
    return selected;
}

function findLatestSessionLogDir(logsDir) {
    if (!fs.existsSync(logsDir)) {
        return null;
    }

    const latestEntry = fs
        .readdirSync(logsDir)
        .filter((entry) => /^\d{8}-\d{6}-\d{3}$/.test(entry))
        .sort()
        .at(-1);

    return latestEntry ? path.join(logsDir, latestEntry) : null;
}

function copyLogDir(sourceDir, destinationDir) {
    fs.mkdirSync(destinationDir, { recursive: true });
    for (const entry of fs.readdirSync(sourceDir)) {
        const sourcePath = path.join(sourceDir, entry);
        const destinationPath = path.join(destinationDir, entry);
        const stat = fs.statSync(sourcePath);
        if (stat.isDirectory()) {
            copyLogDir(sourcePath, destinationPath);
            continue;
        }
        fs.copyFileSync(sourcePath, destinationPath);
    }
}

function analyzeCopiedLogs(logDir) {
    const desktopLogPath = path.join(
        logDir,
        'agent-companion-desktop-companion.log',
    );
    if (!fs.existsSync(desktopLogPath)) {
        return {
            sessionId: path.basename(path.dirname(logDir)),
            websocketWarnings: 0,
            dialogWarnings: 0,
            cspWarnings: 0,
            plutoMentions: 0,
        };
    }

    const logText = fs.readFileSync(desktopLogPath, 'utf8');
    return {
        sessionId: path.basename(path.dirname(logDir)),
        websocketWarnings: countMatches(
            logText,
            /WebSocket connection .* failed/gi,
        ),
        dialogWarnings: countMatches(
            logText,
            /DialogContent.*DialogTitle|Missing `Description`/g,
        ),
        cspWarnings: countMatches(logText, /Insecure Content-Security-Policy/g),
        plutoMentions: countMatches(logText, /pluto|voice session|audio/gi),
    };
}

function countMatches(text, regex) {
    return [...text.matchAll(regex)].length;
}

function buildHeuristics(processes, outputDir, logSignals) {
    const hottest = processes[0] ?? null;
    const gpu = processes.find((entry) => entry.kind === 'gpu') ?? null;
    const renderer =
        processes.find((entry) => entry.kind === 'renderer') ?? null;
    const sampleTexts = fs
        .readdirSync(outputDir)
        .filter(
            (entry) => entry.startsWith('sample-') && entry.endsWith('.txt'),
        )
        .map((entry) => fs.readFileSync(path.join(outputDir, entry), 'utf8'));
    const sampleCorpus = sampleTexts.join('\n');

    return {
        hottestKind: hottest?.kind ?? null,
        hottestPid: hottest?.pid ?? null,
        hottestCpu: hottest?.cpu ?? null,
        gpuCpu: gpu?.cpu ?? null,
        rendererCpu: renderer?.cpu ?? null,
        likelyGpuCompositing:
            Boolean(gpu && gpu.cpu > 20) &&
            /QuartzCore|CA::Render|CA::Context::commit_transaction|IOSurface|ColorSync/gi.test(
                sampleCorpus,
            ),
        likelyRendererChurn:
            Boolean(renderer && renderer.cpu > 10) &&
            /renderer|v8::|host_import_module_dynamically_callback/gi.test(
                sampleCorpus,
            ),
        recentWebsocketNoise: logSignals.websocketWarnings > 0,
        recentDialogA11yWarnings: logSignals.dialogWarnings > 0,
    };
}

function renderSummary({
    branch,
    commit,
    heuristics,
    logSignals,
    outputDir,
    processes,
    repoRoot,
    selectedProcesses,
    timestamp,
}) {
    const topRows = processes
        .slice(0, 6)
        .map(
            (entry) =>
                `| ${entry.kind} | ${entry.pid} | ${entry.cpu.toFixed(1)} | ${entry.mem.toFixed(1)} | \`${truncate(entry.command, 96)}\` |`,
        )
        .join('\n');

    const findings = [];
    if (heuristics.likelyGpuCompositing) {
        findings.push(
            '- GPU process is the hottest path and the samples point to QuartzCore / CA::Render / IOSurface compositing churn.',
        );
    }
    if (heuristics.likelyRendererChurn) {
        findings.push(
            '- Renderer work is also hot, so the issue is not only backend logic; UI/render scheduling is part of the cost.',
        );
    }
    if (logSignals.recentWebsocketNoise) {
        findings.push(
            `- Latest desktop logs still contain ${logSignals.websocketWarnings} WebSocket connection warning(s).`,
        );
    }
    if (logSignals.recentDialogA11yWarnings) {
        findings.push(
            `- Latest desktop logs contain ${logSignals.dialogWarnings} dialog accessibility warning(s).`,
        );
    }
    if (findings.length === 0) {
        findings.push(
            '- No dominant heuristic fired; inspect the raw samples and vmmap outputs directly.',
        );
    }

    const artifactList = selectedProcesses
        .map((entry) => {
            const sampleFile = `sample-${entry.kind}-${entry.pid}.txt`;
            const vmmapFile = `vmmap-${entry.kind}-${entry.pid}.txt`;
            const vmmapSuffix = fs.existsSync(path.join(outputDir, vmmapFile))
                ? `, \`${vmmapFile}\``
                : '';
            return `- ${entry.kind}: \`${sampleFile}\`${vmmapSuffix}`;
        })
        .join('\n');

    return `# Desktop performance bundle\n\n- Captured at: ${new Date().toISOString()}\n- Branch: \`${branch}\`\n- Commit: \`${commit}\`\n- Output: \`${path.relative(repoRoot, outputDir)}\`\n- Latest log session: \`${logSignals.sessionId ?? 'none'}\`\n\n## Top CPU processes\n\n| kind | pid | cpu % | mem % | command |\n| --- | ---: | ---: | ---: | --- |\n${topRows}\n\n## Automated findings\n\n${findings.join('\n')}\n\n## Raw artifacts\n\n- \`ps.txt\`\n- \`profile.json\`\n- \`summary.md\`\n${artifactList}\n${logSignals.sessionId ? '- copied latest desktop logs under `logs/`' : ''}\n\n## Suggested next prompt for an LLM\n\nAnalyse \`${path.relative(repoRoot, path.join(outputDir, 'summary.md'))}\`, \`${path.relative(repoRoot, path.join(outputDir, 'profile.json'))}\`, and the hottest \`sample-*.txt\` files. Focus on whether the hottest path is GPU compositing, renderer churn, or memory growth, and suggest concrete code-level fixes.\n\n## Session id\n\n- ${timestamp}\n`;
}

function truncate(value, maxLength) {
    return value.length > maxLength
        ? `${value.slice(0, maxLength - 1)}…`
        : value;
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
