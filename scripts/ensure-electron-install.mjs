import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

function findElectronPackageDir() {
    const packageJsonPath = require.resolve('electron/package.json', {
        paths: [process.cwd()],
    });

    return path.dirname(packageJsonPath);
}

function resolveElectronBinary(packageDir) {
    const pathFile = path.join(packageDir, 'path.txt');
    if (!fs.existsSync(pathFile)) {
        return null;
    }

    const relativeBinaryPath = fs.readFileSync(pathFile, 'utf8').trim();
    if (!relativeBinaryPath) {
        return null;
    }

    const binaryPath = path.resolve(packageDir, 'dist', relativeBinaryPath);
    return fs.existsSync(binaryPath) ? binaryPath : null;
}

const packageDir = findElectronPackageDir();
const existingBinary = resolveElectronBinary(packageDir);

if (existingBinary) {
    console.log(`Electron binary ready: ${existingBinary}`);
    process.exit(0);
}

console.log('Electron binary missing, running package installer...');
const installScript = path.join(packageDir, 'install.js');
const result = spawnSync(process.execPath, [installScript], {
    stdio: 'inherit',
});

if (result.status !== 0) {
    process.exit(result.status ?? 1);
}

const installedBinary = resolveElectronBinary(packageDir);
if (!installedBinary) {
    console.error('Electron installation did not produce a runnable binary.');
    process.exit(1);
}

console.log(`Electron binary ready: ${installedBinary}`);
