import { execFileSync } from 'node:child_process';
import process from 'node:process';

const [, , rawPort, serviceName = 'service'] = process.argv;

if (!rawPort) {
    console.error(
        'Usage: node scripts/free-dev-port.mjs <port> [service-name]',
    );
    process.exit(1);
}

const port = Number(rawPort);

if (!Number.isInteger(port) || port <= 0) {
    console.error(`Invalid port: ${rawPort}`);
    process.exit(1);
}

if (process.platform === 'win32') {
    console.log(
        `Skipping ${serviceName} port cleanup on Windows for port ${port}.`,
    );
    process.exit(0);
}

function listListeners(targetPort) {
    try {
        const output = execFileSync(
            'lsof',
            ['-nP', `-iTCP:${targetPort}`, '-sTCP:LISTEN', '-Fpc'],
            { encoding: 'utf8' },
        );

        /** @type {{ pid: number; command: string }[]} */
        const listeners = [];

        for (const line of output.split('\n').filter(Boolean)) {
            if (line.startsWith('p')) {
                listeners.push({ pid: Number(line.slice(1)), command: '' });
                continue;
            }

            if (line.startsWith('c') && listeners.length > 0) {
                const lastListener = listeners.at(-1);
                if (lastListener) {
                    lastListener.command = line.slice(1);
                }
            }
        }

        return listeners;
    } catch {
        return [];
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

const listeners = listListeners(port);

if (listeners.length === 0) {
    console.log(`${serviceName}: port ${port} is free.`);
    process.exit(0);
}

for (const listener of listeners) {
    if (!['node', 'electron'].includes(listener.command)) {
        console.error(
            `${serviceName}: port ${port} is in use by ${listener.command} (${listener.pid}). Refusing to kill a non-dev process.`,
        );
        process.exit(1);
    }

    console.log(
        `${serviceName}: stopping existing ${listener.command} process on port ${port} (pid ${listener.pid}).`,
    );
    process.kill(listener.pid, 'SIGTERM');
}

for (let attempt = 0; attempt < 20; attempt += 1) {
    if (listListeners(port).length === 0) {
        console.log(`${serviceName}: port ${port} is ready.`);
        process.exit(0);
    }
    await sleep(150);
}

for (const listener of listListeners(port)) {
    if (['node', 'electron'].includes(listener.command)) {
        console.log(
            `${serviceName}: forcing shutdown of ${listener.command} on port ${port} (pid ${listener.pid}).`,
        );
        process.kill(listener.pid, 'SIGKILL');
    }
}

await sleep(150);

if (listListeners(port).length > 0) {
    console.error(`${serviceName}: failed to free port ${port}.`);
    process.exit(1);
}

console.log(`${serviceName}: port ${port} is ready.`);
