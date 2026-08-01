'use strict';

const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { loadEnvironmentFile } = require('./environment');

const projectRoot = path.resolve(__dirname, '..');
const errors = [];
const successes = [];

function loadLocalEnvironment() {
    const envPath = path.join(projectRoot, '.env');
    if (!fs.existsSync(envPath)) {
        if (process.env.BOT_TOKEN || process.env.CHANNEL_ID) {
            successes.push('configuration supplied through the process environment');
        } else {
            errors.push(
                'No configuration found. Copy .env.example to .env or export the required environment variables.'
            );
        }
        return;
    }
    loadEnvironmentFile(envPath);
}

function validateNode() {
    const major = Number.parseInt(process.versions.node.split('.')[0], 10);
    if (!Number.isFinite(major) || major < 24) {
        errors.push(`Node.js 24 or newer is required; found ${process.versions.node}.`);
        return;
    }

    successes.push(`Node.js ${process.versions.node}`);
}

function validateNodeDependencies() {
    try {
        const manifest = JSON.parse(
            fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')
        );
        const lock = JSON.parse(
            fs.readFileSync(path.join(projectRoot, 'package-lock.json'), 'utf8')
        );
        if (lock.lockfileVersion !== 3 || !lock.packages?.['']) {
            throw new Error('package-lock.json must use lockfile version 3');
        }
        const manifestDependencies = manifest.dependencies || {};
        const lockedRootDependencies =
            lock.packages[''].dependencies || {};
        for (const [name, expectedVersion] of Object.entries(
            manifestDependencies
        )) {
            if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(
                String(expectedVersion)
            )) {
                throw new Error(
                    `package.json dependency ${name} is not exactly pinned`
                );
            }
            if (lockedRootDependencies[name] !== expectedVersion) {
                throw new Error(
                    `${name} differs between package.json and package-lock.json`
                );
            }
            const lockedPackage = lock.packages[`node_modules/${name}`];
            if (lockedPackage?.version !== expectedVersion) {
                throw new Error(
                    `${name} ${expectedVersion} is missing from package-lock.json`
                );
            }
            const installedManifestPath = path.join(
                projectRoot,
                'node_modules',
                ...name.split('/'),
                'package.json'
            );
            const installedManifest = JSON.parse(
                fs.readFileSync(installedManifestPath, 'utf8')
            );
            if (installedManifest.version !== expectedVersion) {
                throw new Error(
                    `${name} ${installedManifest.version || 'unknown'} is installed; expected ${expectedVersion}`
                );
            }
            require.resolve(name, { paths: [projectRoot] });
        }
        successes.push(
            `${Object.keys(manifestDependencies).length} direct Node dependencies match the exact lock`
        );
    } catch (error) {
        errors.push(`Node dependency installation cannot be verified: ${error.message}.`);
    }
}

function validateEnvironment() {
    const token = String(process.env.BOT_TOKEN || '').trim();
    const parseIds = name => String(process.env[name] || '')
        .split(',')
        .map(value => value.trim())
        .filter(Boolean);
    const channelIds = parseIds('CHANNEL_ID');

    if (!token || /your_discord_bot_token/i.test(token)) {
        errors.push('BOT_TOKEN is missing or still uses the example placeholder.');
    } else {
        successes.push('BOT_TOKEN is configured (value not displayed)');
    }

    if (channelIds.length === 0) {
        errors.push('CHANNEL_ID must contain at least one Discord channel ID.');
    } else if (channelIds.some(value => !/^\d{17,20}$/.test(value))) {
        errors.push('Every CHANNEL_ID entry must be a 17-20 digit Discord snowflake.');
    } else {
        successes.push(`${channelIds.length} alert channel ID(s) configured`);
    }

    for (const name of ['ADMIN_USER_IDS', 'ALLOWED_GUILD_IDS']) {
        const ids = parseIds(name);
        if (ids.some(value => !/^\d{17,20}$/.test(value))) {
            errors.push(`Every ${name} entry must be a 17-20 digit Discord snowflake.`);
        } else if (ids.length > 0) {
            successes.push(`${ids.length} ${name} entry or entries configured`);
        }
    }

    const numericSettings = [
        ['HTTP_TIMEOUT_MS', 1_000, 120_000],
        ['HTTP_RETRIES', 0, 10],
        ['ENRICHMENT_CONCURRENCY', 1, 20],
        ['ANALYSIS_CONCURRENCY', 1, 8],
        ['BACKFILL_COOLDOWN_MS', 1_000, 3_600_000],
        ['POLL_INTERVAL_MS', 30_000, 3_600_000],
        ['OFFSEASON_POLL_INTERVAL_MS', 60_000, 86_400_000],
        ['POLL_JITTER_MS', 0, 300_000],
        ['READY_TIMEOUT_MS', 1_000, 300_000],
    ];
    const backfillName = process.env.BACKFILL_BATCH_SIZE !== undefined
        ? 'BACKFILL_BATCH_SIZE'
        : 'BACKFILL_LIMIT';
    numericSettings.push([backfillName, 1, 25]);

    for (const [name, minimum, maximum] of numericSettings) {
        const rawValue = String(process.env[name] || '').trim();
        if (!rawValue) {
            continue;
        }
        const value = Number(rawValue);
        if (!Number.isInteger(value) || value < minimum || value > maximum) {
            errors.push(`${name} must be an integer from ${minimum} through ${maximum}.`);
        }
    }

    validateStatePath();
}

function validateStatePath(options = {}) {
    const fileSystem = options.fileSystem || fs;
    const environment = options.environment || process.env;
    const currentDirectory = options.currentDirectory || process.cwd();
    const successMessages = options.successMessages || successes;
    const errorMessages = options.errorMessages || errors;
    const accessConstants = fileSystem.constants || fs.constants;
    const configured = String(environment.STATE_PATH || '').trim();
    try {
        if (configured.includes('\0')) {
            throw new Error('contains a null byte');
        }
        if (configured && /[\\/]$/.test(configured)) {
            throw new Error('must name a file, not a directory');
        }

        const statePath = configured
            ? path.resolve(currentDirectory, configured)
            : path.join(projectRoot, 'data', 'bot_state.json');
        if (!path.parse(statePath).base || path.parse(statePath).root === statePath) {
            throw new Error('must resolve to an explicit file path');
        }
        const leasePath = `${statePath}.lock`;
        if (fileSystem.existsSync(leasePath)) {
            throw new Error(
                `has an active or unreleased lease at ${leasePath}; inspect the running bot before removing it`
            );
        }

        if (fileSystem.existsSync(statePath)) {
            if (!fileSystem.statSync(statePath).isFile()) {
                throw new Error('points to a non-file path');
            }
            fileSystem.accessSync(
                statePath,
                accessConstants.R_OK
            );
            const stateDirectory = path.dirname(statePath);
            if (!fileSystem.statSync(stateDirectory).isDirectory()) {
                throw new Error('parent path is not a directory');
            }
            fileSystem.accessSync(
                stateDirectory,
                accessConstants.W_OK | accessConstants.X_OK
            );
            successMessages.push(
                'STATE_PATH is an accessible file in a writable directory'
            );
            return;
        }

        let writableAncestor = path.dirname(statePath);
        while (!fileSystem.existsSync(writableAncestor)) {
            const parent = path.dirname(writableAncestor);
            if (parent === writableAncestor) break;
            writableAncestor = parent;
        }
        if (!fileSystem.existsSync(writableAncestor) ||
            !fileSystem.statSync(writableAncestor).isDirectory()) {
            throw new Error('has no existing parent directory');
        }
        fileSystem.accessSync(
            writableAncestor,
            accessConstants.W_OK | accessConstants.X_OK
        );
        successMessages.push('STATE_PATH can be created beneath a writable directory');
    } catch (error) {
        errorMessages.push(`STATE_PATH ${error.message}.`);
    }
}

function validateDataFiles() {
    const parsedFiles = new Map();
    const rawFiles = new Map();
    for (const relativePath of [
        path.join('data', 'fences.json'),
        path.join('data', 'stadium_paths.json'),
        path.join('data', 'ballpark_metadata.json'),
    ]) {
        const filePath = path.join(projectRoot, relativePath);
        try {
            const rawPayload = fs.readFileSync(filePath);
            const payload = JSON.parse(rawPayload.toString('utf8'));
            if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
                throw new Error('top-level JSON value must be an object');
            }
            parsedFiles.set(relativePath, payload);
            rawFiles.set(relativePath, rawPayload);
            successes.push(`${relativePath} is readable JSON`);
        } catch (error) {
            errors.push(`${relativePath} is unavailable or invalid: ${error.message}`);
        }
    }

    const metadataPath = path.join('data', 'ballpark_metadata.json');
    const metadata = parsedFiles.get(metadataPath);
    if (!metadata) {
        return false;
    }
    const release = metadata.analysis_release;
    const verified = metadata.verified_venues;
    const retained = metadata.retained_venue_mappings;
    const unsupported = metadata.unsupported_venues;
    const expectedVenueCount = Number(
        metadata.expected_active_venues
    );
    if (metadata.schema_version !== 2) {
        errors.push(`${metadataPath} must use schema_version 2.`);
    }
    if (!release || typeof release !== 'object' ||
        release.verification_schema_version !== 1) {
        errors.push(`${metadataPath} has no valid analysis_release attestation.`);
    }
    for (const [label, candidate] of [
        ['verified_venues', verified],
        ['retained_venue_mappings', retained],
        ['unsupported_venues', unsupported],
    ]) {
        if (!candidate || typeof candidate !== 'object' ||
            Array.isArray(candidate)) {
            errors.push(`${metadataPath} ${label} must be an object.`);
        }
    }
    if (!Number.isInteger(expectedVenueCount) ||
        expectedVenueCount < 1 ||
        Object.keys(retained || {}).length +
            Object.keys(unsupported || {}).length !== expectedVenueCount) {
        errors.push(
            `${metadataPath} retained and unsupported venue coverage must equal expected_active_venues.`
        );
    }
    const verifiedIds = Array.isArray(release?.verified_venue_ids)
        ? release.verified_venue_ids.map(String).sort()
        : null;
    if (!verifiedIds ||
        JSON.stringify(verifiedIds) !== JSON.stringify(
            Object.keys(verified || {}).sort()
        )) {
        errors.push(
            `${metadataPath} verified_venue_ids must exactly match verified_venues.`
        );
    }
    if (metadata.advanced_analysis_enabled === false &&
        String(metadata.analysis_disabled_reason || '').trim() &&
        release?.status === 'disabled' &&
        Object.keys(verified || {}).length === 0) {
        successes.push(
            `advanced park analysis is intentionally disabled: ${metadata.analysis_disabled_reason}`
        );
    } else if (metadata.advanced_analysis_enabled === true) {
        const retainedJson = JSON.stringify(retained || {});
        const verifiedJson = JSON.stringify(verified || {});
        const enabledReleaseIsVerified =
            release?.status === 'verified' &&
            release.source_revisions_recorded === true &&
            release.calibration_complete === true &&
            release.calculation_rendering_walls_aligned === true &&
            retainedJson === verifiedJson &&
            !String(metadata.data_version || '').match(
                /disabled|unverified/i
            ) &&
            String(metadata.geometry_source_revision || '').trim() &&
            metadata.geometry_source_revision !== 'checked-in-snapshot';
        if (!enabledReleaseIsVerified) {
            errors.push(
                `${metadataPath} enables analysis without a complete verified release and exact retained coverage.`
            );
        }
    } else {
        errors.push(
            `${metadataPath} must explicitly enable a verified release or document a disabled release with no verified venues.`
        );
    }

    for (const [fileName, relativePath] of [
        ['fences.json', path.join('data', 'fences.json')],
        ['stadium_paths.json', path.join('data', 'stadium_paths.json')],
    ]) {
        const expectedHash = metadata.geometry_files_sha256?.[fileName];
        const rawPayload = rawFiles.get(relativePath);
        if (!/^[a-f0-9]{64}$/.test(String(expectedHash || ''))) {
            errors.push(`${metadataPath} has no valid SHA-256 pin for ${fileName}.`);
            continue;
        }
        if (!rawPayload) {
            continue;
        }
        const actualHash = crypto.createHash('sha256').update(rawPayload).digest('hex');
        if (actualHash !== expectedHash) {
            errors.push(`${relativePath} does not match its reviewed SHA-256 snapshot.`);
        } else {
            successes.push(`${relativePath} matches its reviewed SHA-256 snapshot`);
        }
    }
    return metadata.advanced_analysis_enabled === true;
}

function pythonCandidates() {
    const candidates = [];
    const configuredName = String(process.env.PYTHON_BIN || '').trim()
        ? 'PYTHON_BIN'
        : 'PYTHON_PATH';
    const configured = String(
        process.env.PYTHON_BIN || process.env.PYTHON_PATH || ''
    ).trim();
    if (configured) {
        candidates.push({
            command: configured,
            args: [],
            label: configuredName,
            required: true,
        });
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

    for (const command of localExecutables) {
        if (fs.existsSync(command)) {
            candidates.push({
                command,
                args: [],
                label: path.relative(projectRoot, command),
                required: false,
            });
        }
    }

    for (const version of ['3.13', '3.12', '3.11', '3.10']) {
        candidates.push({
            command: `python${version}`,
            args: [],
            label: `python${version}`,
            required: false,
        });
    }
    candidates.push({ command: 'python3', args: [], label: 'python3', required: false });
    candidates.push({ command: 'python', args: [], label: 'python', required: false });
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
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}

function validatePython() {
    const diagnostics = [];
    const expectedVersions = loadPinnedPythonVersions();
    if (!expectedVersions) {
        return;
    }
    const pythonEnvironment = {
        ...process.env,
        MPLCONFIGDIR: process.env.MPLCONFIGDIR || path.join(projectRoot, 'tmp', 'matplotlib'),
        PYTHONDONTWRITEBYTECODE: '1',
    };
    for (const name of Object.keys(pythonEnvironment)) {
        if (name.toUpperCase() === 'BOT_TOKEN') {
            delete pythonEnvironment[name];
        }
    }
    const probe = [
        'import json, sys',
        'if not ((3, 10) <= sys.version_info[:2] <= (3, 13)):',
        '  raise RuntimeError("Python 3.10 through 3.13 is required")',
        'import matplotlib, numpy, PIL',
        'print(json.dumps({',
        '  "python": sys.version.split()[0],',
        '  "matplotlib": matplotlib.__version__,',
        '  "numpy": numpy.__version__,',
        '  "pillow": PIL.__version__,',
        '}))',
    ].join('\n');

    for (const candidate of pythonCandidates()) {
        const result = spawnSync(
            candidate.command,
            [...candidate.args, '-c', probe],
            {
                cwd: projectRoot,
                encoding: 'utf8',
                env: pythonEnvironment,
                timeout: 15_000,
                windowsHide: true,
            }
        );

        if (result.error && result.status === null) {
            if (candidate.required) {
                errors.push(
                    `Configured ${candidate.label} could not be started: ${result.error.message}`
                );
                return;
            }
            diagnostics.push(`${candidate.label}: could not start`);
            continue;
        }

        if (result.status !== 0) {
            const detail = String(result.stderr || result.error?.message || 'unknown error')
                .trim()
                .split(/\r?\n/)
                .at(-1);
            if (candidate.required) {
                errors.push(`Python probe failed via ${candidate.label}: ${detail}`);
                return;
            }
            diagnostics.push(`${candidate.label}: ${detail}`);
            continue;
        }

        try {
            const versions = JSON.parse(String(result.stdout).trim());
            const mismatches = Object.entries(expectedVersions)
                .filter(([name, expected]) => versions[name] !== expected)
                .map(([name, expected]) =>
                    `${name} ${versions[name] || 'missing'} (expected ${expected})`
                );
            if (mismatches.length > 0) {
                throw new Error(`dependency version mismatch: ${mismatches.join(', ')}`);
            }
            successes.push(
                `Python ${versions.python} via ${candidate.label} ` +
                `(matplotlib ${versions.matplotlib}, NumPy ${versions.numpy}, Pillow ${versions.pillow})`
            );
            return;
        } catch (error) {
            if (candidate.required) {
                errors.push(
                    `Python probe via ${candidate.label} failed validation: ${error.message}`
                );
                return;
            }
            diagnostics.push(`${candidate.label}: ${error.message}`);
        }
    }

    const attempted = diagnostics.length > 0
        ? ` Attempts: ${diagnostics.join(' | ')}`
        : '';
    errors.push(
        'No usable Python interpreter was found. Set PYTHON_BIN or create venv/.venv and install requirements.txt.' +
        attempted
    );
}

function loadPinnedPythonVersions() {
    const requirementsPath = path.join(projectRoot, 'requirements.txt');
    try {
        const versions = {};
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
                throw new Error(`missing exact ${required} pin`);
            }
        }
        return versions;
    } catch (error) {
        errors.push(`requirements.txt cannot be verified: ${error.message}`);
        return null;
    }
}

function runPreflight() {
    successes.length = 0;
    errors.length = 0;
    loadLocalEnvironment();
    validateNode();
    validateNodeDependencies();
    validateEnvironment();
    const advancedAnalysisEnabled = validateDataFiles();
    if (advancedAnalysisEnabled) {
        validatePython();
    } else {
        successes.push(
            'Python park-analysis dependencies are optional while advanced analysis is disabled'
        );
    }

    for (const message of successes) {
        console.log(`OK: ${message}`);
    }

    if (errors.length > 0) {
        for (const message of errors) {
            console.error(`ERROR: ${message}`);
        }
        process.exitCode = 1;
    } else {
        console.log('Preflight passed.');
    }
}

module.exports = { runPreflight, validateStatePath };

if (require.main === module) {
    runPreflight();
}
