'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseEnvironmentFile } = require('./environment');

const projectRoot = path.resolve(__dirname, '..');
const localEnvironmentPath = path.join(projectRoot, '.env');

function localPythonSettings() {
    const settings = {};
    if (!fs.existsSync(localEnvironmentPath)) return settings;

    const parsed = parseEnvironmentFile(
        fs.readFileSync(localEnvironmentPath, 'utf8')
    );
    for (const name of ['PYTHON_BIN', 'PYTHON_PATH']) {
        if (Object.prototype.hasOwnProperty.call(parsed, name)) {
            settings[name] = parsed[name];
        }
    }
    return settings;
}

const localEnvironment = localPythonSettings();

function pinnedPythonVersions() {
    const versions = {};
    const requirementsPath = path.join(projectRoot, 'requirements.txt');
    for (const line of fs.readFileSync(requirementsPath, 'utf8').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const match = trimmed.match(/^([A-Za-z0-9_.-]+)==([^\s;]+)$/);
        if (!match) {
            throw new Error(`requirement is not an exact pin: ${trimmed}`);
        }
        versions[match[1].toLowerCase().replace(/[-_.]+/g, '-')] = match[2];
    }
    for (const required of ['matplotlib', 'numpy', 'pillow']) {
        if (!versions[required]) {
            throw new Error(`requirements.txt is missing an exact ${required} pin`);
        }
    }
    return versions;
}

function pythonCandidates() {
    const configured = String(
        process.env.PYTHON_BIN ||
        process.env.PYTHON_PATH ||
        localEnvironment.PYTHON_BIN ||
        localEnvironment.PYTHON_PATH ||
        ''
    ).trim();
    if (configured) {
        return [{
            command: configured,
            args: [],
            label: process.env.PYTHON_BIN || localEnvironment.PYTHON_BIN
                ? 'PYTHON_BIN'
                : 'PYTHON_PATH',
            required: true,
        }];
    }

    const localExecutables = process.platform === 'win32'
        ? [
            path.join(projectRoot, 'venv', 'Scripts', 'python.exe'),
            path.join(projectRoot, '.venv', 'Scripts', 'python.exe'),
        ]
        : [
            path.join(projectRoot, 'venv', 'bin', 'python'),
            path.join(projectRoot, '.venv', 'bin', 'python'),
        ];
    const candidates = localExecutables
        .filter(command => fs.existsSync(command))
        .map(command => ({
            command,
            args: [],
            label: path.relative(projectRoot, command),
            required: false,
        }));

    for (const version of ['3.13', '3.12', '3.11', '3.10']) {
        candidates.push({
            command: `python${version}`,
            args: [],
            label: `python${version}`,
            required: false,
        });
    }
    candidates.push(
        { command: 'python3', args: [], label: 'python3', required: false },
        { command: 'python', args: [], label: 'python', required: false },
    );
    if (process.platform === 'win32') {
        for (const version of ['3.13', '3.12', '3.11', '3.10']) {
            candidates.push({
                command: 'py',
                args: [`-${version}`],
                label: `py -${version}`,
                required: false,
            });
        }
    }

    const seen = new Set();
    return candidates.filter(candidate => {
        const key = `${candidate.command}\0${candidate.args.join('\0')}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

const childEnvironment = {
    ...process.env,
    MPLCONFIGDIR: process.env.MPLCONFIGDIR ||
        path.join(os.tmpdir(), 'home-run-bot-matplotlib'),
    PYTHONDONTWRITEBYTECODE: '1',
};
for (const name of Object.keys(childEnvironment)) {
    if (name.toUpperCase() === 'BOT_TOKEN') {
        delete childEnvironment[name];
    }
}
let expectedVersions;
try {
    expectedVersions = pinnedPythonVersions();
} catch (error) {
    console.error(`Cannot run Python tests: ${error.message}`);
    process.exit(1);
}
const probe = [
    'import sys',
    'if not ((3, 10) <= sys.version_info[:2] <= (3, 13)):',
    '    raise RuntimeError("Python 3.10 through 3.13 is required")',
    'import importlib.metadata as metadata',
    `expected = ${JSON.stringify(expectedVersions)}`,
    'for name, expected_version in expected.items():',
    '    actual_version = metadata.version(name)',
    '    if actual_version != expected_version:',
    '        raise RuntimeError(f"{name} {actual_version} is installed; expected {expected_version}")',
    'import matplotlib, numpy, PIL',
].join('\n');
const diagnostics = [];

for (const candidate of pythonCandidates()) {
    const probeResult = spawnSync(
        candidate.command,
        [...candidate.args, '-c', probe],
        {
            cwd: projectRoot,
            encoding: 'utf8',
            env: childEnvironment,
            timeout: 15_000,
            windowsHide: true,
        },
    );
    if (probeResult.status !== 0) {
        const detail = String(
            probeResult.stderr ||
            probeResult.error?.message ||
            'could not start'
        ).trim().split(/\r?\n/).at(-1);
        diagnostics.push(`${candidate.label}: ${detail}`);
        if (candidate.required) break;
        continue;
    }

    const testResult = spawnSync(
        candidate.command,
        [
            ...candidate.args,
            '-B',
            '-m',
            'unittest',
            'discover',
            '--start-directory',
            'test',
            '--pattern',
            'test_*.py',
            '--verbose',
        ],
        {
            cwd: projectRoot,
            env: childEnvironment,
            stdio: 'inherit',
            windowsHide: true,
        },
    );
    if (testResult.error) {
        console.error(`Could not run Python tests via ${candidate.label}: ${testResult.error.message}`);
        process.exitCode = 1;
    } else {
        process.exitCode = testResult.status ?? 1;
    }
    process.exit();
}

console.error(
    'No Python 3.10-3.13 interpreter with the pinned Matplotlib, NumPy, and Pillow ' +
    `dependencies could run the tests. ${diagnostics.join(' | ')}`
);
process.exitCode = 1;
