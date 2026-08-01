const Discord = require('discord.js');
const { execFile } = require('child_process');
const { parse } = require('csv-parse/sync');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { loadEnvironmentFile } = require('./scripts/environment');

const STATE_VERSION = 3;
const DEFAULT_HTTP_TIMEOUT_MS = 10000;
const DEFAULT_HTTP_RETRIES = 3;
const DEFAULT_ENRICHMENT_CONCURRENCY = 3;
const DEFAULT_ANALYSIS_CONCURRENCY = 2;
const DEFAULT_BACKFILL_LIMIT = 3;
const DEFAULT_BACKFILL_COOLDOWN_MS = 60000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 15000;
const DEFAULT_READY_TIMEOUT_MS = 60000;
const DEFAULT_ENRICHMENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ENRICHMENT_MAX_DATA_ATTEMPTS = 96;
const DEFAULT_AUTHORITATIVE_RECONCILIATION_INTERVAL_MS = 6 * 60 * 60 * 1000;

function parseCsvIds(value, label, { required = false } = {}) {
    const ids = [...new Set(String(value || '')
        .split(',')
        .map(id => id.trim())
        .filter(Boolean))];

    if (required && ids.length === 0) {
        throw new Error(`${label} must contain at least one Discord ID`);
    }

    const invalidIds = ids.filter(id => !/^\d{17,20}$/.test(id));
    if (invalidIds.length > 0) {
        throw new Error(`${label} contains invalid Discord ID values`);
    }

    return ids;
}

function parsePositiveInteger(
    value,
    fallback,
    minimum = 1,
    maximum = Number.MAX_SAFE_INTEGER,
    label = 'configuration value'
) {
    if (value === undefined || value === null || String(value).trim() === '') {
        return fallback;
    }
    const parsed = Number.parseInt(value, 10);
    if (!/^-?\d+$/.test(String(value).trim()) ||
        !Number.isInteger(parsed) ||
        parsed < minimum ||
        parsed > maximum) {
        throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
    }
    return parsed;
}

function resolveStatePath(value, baseDirectory = process.cwd()) {
    const configuredValue = String(value || '').trim();
    if (configuredValue.includes('\0')) {
        throw new Error('STATE_PATH contains a null byte');
    }
    if (configuredValue && /[\\/]$/.test(configuredValue)) {
        throw new Error('STATE_PATH must name a file, not a directory');
    }
    const resolvedPath = configuredValue
        ? path.resolve(baseDirectory, configuredValue)
        : path.resolve(__dirname, 'data', 'bot_state.json');
    const parsedPath = path.parse(resolvedPath);
    if (!parsedPath.base || parsedPath.root === resolvedPath) {
        throw new Error('STATE_PATH must resolve to an explicit file path');
    }
    try {
        if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isDirectory()) {
            throw new Error('STATE_PATH points to a directory');
        }
    } catch (error) {
        if (error.message === 'STATE_PATH points to a directory') throw error;
        throw new Error(`STATE_PATH cannot be inspected: ${error.message}`);
    }
    return resolvedPath;
}

function parseConfig(env = process.env, options = {}) {
    const token = String(env.BOT_TOKEN || '').trim();
    if (!token) {
        throw new Error('BOT_TOKEN is required');
    }
    const backfillBatchSize = parsePositiveInteger(
        env.BACKFILL_BATCH_SIZE ?? env.BACKFILL_LIMIT,
        DEFAULT_BACKFILL_LIMIT,
        1,
        25,
        env.BACKFILL_BATCH_SIZE !== undefined ? 'BACKFILL_BATCH_SIZE' : 'BACKFILL_LIMIT'
    );

    return {
        token,
        channelIds: parseCsvIds(env.CHANNEL_ID, 'CHANNEL_ID', { required: true }),
        adminUserIds: parseCsvIds(env.ADMIN_USER_IDS, 'ADMIN_USER_IDS'),
        allowedGuildIds: parseCsvIds(env.ALLOWED_GUILD_IDS, 'ALLOWED_GUILD_IDS'),
        botUsername: String(env.BOT_USERNAME || '').trim() || null,
        pythonPath: String(env.PYTHON_BIN || env.PYTHON_PATH || '').trim() || null,
        statePath: resolveStatePath(env.STATE_PATH, options.cwd || process.cwd()),
        httpTimeoutMs: parsePositiveInteger(
            env.HTTP_TIMEOUT_MS,
            DEFAULT_HTTP_TIMEOUT_MS,
            1000,
            120000,
            'HTTP_TIMEOUT_MS'
        ),
        httpRetries: parsePositiveInteger(env.HTTP_RETRIES, DEFAULT_HTTP_RETRIES, 0, 10, 'HTTP_RETRIES'),
        enrichmentConcurrency: parsePositiveInteger(
            env.ENRICHMENT_CONCURRENCY,
            DEFAULT_ENRICHMENT_CONCURRENCY,
            1,
            20,
            'ENRICHMENT_CONCURRENCY'
        ),
        analysisConcurrency: parsePositiveInteger(
            env.ANALYSIS_CONCURRENCY,
            DEFAULT_ANALYSIS_CONCURRENCY,
            1,
            8,
            'ANALYSIS_CONCURRENCY'
        ),
        backfillBatchSize,
        // Compatibility for callers using the pre-rename option. New deployments should use
        // BACKFILL_BATCH_SIZE because this limits work per job, not concurrent jobs.
        backfillLimit: backfillBatchSize,
        backfillCooldownMs: parsePositiveInteger(
            env.BACKFILL_COOLDOWN_MS,
            DEFAULT_BACKFILL_COOLDOWN_MS,
            1000,
            3600000,
            'BACKFILL_COOLDOWN_MS'
        ),
        pollIntervalMs: parsePositiveInteger(
            env.POLL_INTERVAL_MS,
            240000,
            30000,
            3600000,
            'POLL_INTERVAL_MS'
        ),
        offseasonPollIntervalMs: parsePositiveInteger(
            env.OFFSEASON_POLL_INTERVAL_MS,
            6 * 60 * 60 * 1000,
            60000,
            24 * 60 * 60 * 1000,
            'OFFSEASON_POLL_INTERVAL_MS'
        ),
        pollJitterMs: parsePositiveInteger(env.POLL_JITTER_MS, 30000, 0, 300000, 'POLL_JITTER_MS'),
        readyTimeoutMs: parsePositiveInteger(
            env.READY_TIMEOUT_MS,
            DEFAULT_READY_TIMEOUT_MS,
            1000,
            300000,
            'READY_TIMEOUT_MS'
        )
    };
}

function defaultSleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function safeDateTimestamp(value) {
    const timestamp = value ? Date.parse(value) : Number.NaN;
    return Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER;
}

function validateStateDocument(value) {
    const isRecord = candidate =>
        Boolean(candidate) && typeof candidate === 'object' && !Array.isArray(candidate);
    const validateIdArray = (candidate, label) => {
        if (!Array.isArray(candidate) ||
            candidate.some(item =>
                typeof item !== 'string' ||
                !item.trim() ||
                item.length > 512
            )) {
            throw new Error(`${label} must be an array of non-empty IDs`);
        }
    };
    const validateRecordValues = (candidate, label, predicate = isRecord) => {
        if (!isRecord(candidate) ||
            Object.entries(candidate).some(([key, item]) =>
                !key.trim() || !predicate(item)
            )) {
            throw new Error(`${label} is invalid`);
        }
    };
    const validateOptionalString = (candidate, label, { nullable = true } = {}) => {
        if (candidate === undefined || (nullable && candidate === null)) return;
        if (typeof candidate !== 'string' || !candidate.trim()) {
            throw new Error(`${label} must be a non-empty string`);
        }
    };
    const validateOptionalTimestamp = (candidate, label) => {
        if (candidate === undefined || candidate === null) return;
        if (typeof candidate !== 'string' || !Number.isFinite(Date.parse(candidate))) {
            throw new Error(`${label} must be a valid timestamp`);
        }
    };

    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('state root must be an object');
    }
    if (!Number.isInteger(Number(value.season)) || Number(value.season) < 2000) {
        throw new Error('state season is invalid');
    }
    if (value.version !== undefined &&
        (!Number.isInteger(value.version) || value.version < 1 || value.version > STATE_VERSION)) {
        throw new Error(
            `state version ${String(value.version)} is unsupported; this bot supports legacy unversioned state through version ${STATE_VERSION}`
        );
    }
    if (!value.players || typeof value.players !== 'object' || Array.isArray(value.players)) {
        throw new Error('state players object is missing');
    }
    validateOptionalTimestamp(value.updatedAt, 'state updatedAt');
    for (const [playerId, playerState] of Object.entries(value.players)) {
        if (!playerId.trim() || !isRecord(playerState)) {
            throw new Error(`state player ${playerId} must be an object`);
        }
        const checkpoint = playerState.lastCheckedHR;
        if (!Number.isInteger(checkpoint) || checkpoint < 0 || checkpoint > 1000) {
            throw new Error(`state player ${playerId} has an invalid checkpoint`);
        }
        if (Number(value.version || 0) >= 3 &&
            typeof playerState.checkpointInitialized !== 'boolean') {
            throw new Error(`state player ${playerId} is missing its checkpoint flag`);
        }
        if (playerState.checkpointInitialized !== undefined &&
            typeof playerState.checkpointInitialized !== 'boolean') {
            throw new Error(`state player ${playerId} has an invalid checkpoint flag`);
        }
        for (const field of [
            'sentHomeRuns',
            'baselineHomeRunIds',
            'authoritativeHomeRunIds',
        ]) {
            if (playerState[field] !== undefined) {
                validateIdArray(playerState[field], `state player ${playerId} ${field}`);
            }
        }
        for (const field of [
            'eventAliases',
            'homeRunEvents',
            'homeRunParks',
            'sentHomeRunsByChannel',
            'alertMessagesByChannel',
        ]) {
            if (playerState[field] !== undefined && !isRecord(playerState[field])) {
                throw new Error(`state player ${playerId} ${field} must be an object`);
            }
        }
        if (playerState.eventAliases !== undefined) {
            validateRecordValues(
                playerState.eventAliases,
                `state player ${playerId} eventAliases`,
                item => typeof item === 'string' && Boolean(item.trim())
            );
        }
        if (playerState.homeRunEvents !== undefined) {
            validateRecordValues(
                playerState.homeRunEvents,
                `state player ${playerId} homeRunEvents`
            );
        }
        if (playerState.homeRunParks !== undefined) {
            validateRecordValues(
                playerState.homeRunParks,
                `state player ${playerId} homeRunParks`,
                item => isRecord(item) ||
                    ((typeof item === 'number' || typeof item === 'string') &&
                        String(item).trim() &&
                        Number.isFinite(Number(item)))
            );
        }
        for (const [channelId, ids] of Object.entries(
            playerState.sentHomeRunsByChannel || {}
        )) {
            if (!channelId.trim()) {
                throw new Error(`state player ${playerId} has an empty channel ID`);
            }
            validateIdArray(ids, `state player ${playerId} channel ${channelId}`);
        }
        for (const [channelId, records] of Object.entries(
            playerState.alertMessagesByChannel || {}
        )) {
            if (!isRecord(records) ||
                Object.values(records).some(record => !isRecord(record))) {
                throw new Error(
                    `state player ${playerId} channel ${channelId} alert records are invalid`
                );
            }
            for (const [eventId, record] of Object.entries(records)) {
                if (!eventId.trim()) {
                    throw new Error(
                        `state player ${playerId} channel ${channelId} has an empty event ID`
                    );
                }
                for (const field of [
                    'messageId',
                    'deliveryMode',
                    'playerId',
                    'hrId',
                    'enrichmentDeliveryMode',
                    'enrichmentMessageId',
                    'correctionMessageId',
                    'enrichmentFailureReason',
                    'analysisSourceDataHash',
                    'analysisMetadataVersion',
                ]) {
                    validateOptionalString(
                        record[field],
                        `state alert ${channelId}/${eventId} ${field}`
                    );
                }
                for (const field of [
                    'basicSentAt',
                    'enrichedAt',
                    'retractedAt',
                    'enrichmentFailedAt',
                    'parkAnalysisWithdrawnAt',
                ]) {
                    validateOptionalTimestamp(
                        record[field],
                        `state alert ${channelId}/${eventId} ${field}`
                    );
                }
                if (record.hrDetail !== undefined && !isRecord(record.hrDetail)) {
                    throw new Error(
                        `state alert ${channelId}/${eventId} hrDetail is invalid`
                    );
                }
                for (const field of [
                    'imageDelivered',
                    'parkAnalysisDelivered',
                ]) {
                    if (record[field] !== undefined &&
                        typeof record[field] !== 'boolean') {
                        throw new Error(
                            `state alert ${channelId}/${eventId} ${field} must be boolean`
                        );
                    }
                }
            }
        }
        for (const field of [
            'baselineSnapshotInitialized',
            'authoritativeSnapshotInitialized',
        ]) {
            if (playerState[field] !== undefined &&
                typeof playerState[field] !== 'boolean') {
                throw new Error(`state player ${playerId} ${field} must be boolean`);
            }
        }
        if (Number(value.version || 0) >= 3) {
            for (const field of [
                'baselineSnapshotInitialized',
                'authoritativeSnapshotInitialized',
            ]) {
                if (typeof playerState[field] !== 'boolean') {
                    throw new Error(`state player ${playerId} is missing ${field}`);
                }
            }
            for (const field of [
                'sentHomeRuns',
                'baselineHomeRunIds',
                'authoritativeHomeRunIds',
            ]) {
                if (!Array.isArray(playerState[field])) {
                    throw new Error(`state player ${playerId} is missing ${field}`);
                }
            }
            const acknowledgedIds = new Set([
                ...playerState.baselineHomeRunIds,
                ...playerState.sentHomeRuns,
            ]);
            const authoritativeIds = new Set(
                playerState.authoritativeHomeRunIds
            );
            if (playerState.checkpointInitialized &&
                playerState.baselineSnapshotInitialized &&
                acknowledgedIds.size < checkpoint) {
                throw new Error(
                    `state player ${playerId} baseline inventory does not cover its checkpoint`
                );
            }
            if (playerState.checkpointInitialized &&
                playerState.authoritativeSnapshotInitialized &&
                authoritativeIds.size < checkpoint) {
                throw new Error(
                    `state player ${playerId} authoritative inventory does not cover its checkpoint`
                );
            }
            if (playerState.baselineSnapshotInitialized &&
                playerState.authoritativeSnapshotInitialized) {
                for (const eventId of acknowledgedIds) {
                    if (!authoritativeIds.has(eventId)) {
                        throw new Error(
                            `state player ${playerId} acknowledges an event outside its authoritative inventory`
                        );
                    }
                }
                for (const eventId of Object.keys(
                    playerState.homeRunEvents || {}
                )) {
                    if (!authoritativeIds.has(eventId)) {
                        throw new Error(
                            `state player ${playerId} caches an event outside its authoritative inventory`
                        );
                    }
                }
                for (const eventId of Object.keys(
                    playerState.homeRunParks || {}
                )) {
                    if (!authoritativeIds.has(eventId)) {
                        throw new Error(
                            `state player ${playerId} has park data outside its authoritative inventory`
                        );
                    }
                }
            }
            for (const [channelId, eventIds] of Object.entries(
                playerState.sentHomeRunsByChannel || {}
            )) {
                const records =
                    playerState.alertMessagesByChannel?.[channelId] || {};
                for (const eventId of eventIds) {
                    if (playerState.authoritativeSnapshotInitialized &&
                        !authoritativeIds.has(eventId)) {
                        throw new Error(
                            `state player ${playerId} channel ${channelId} acknowledges an event outside its authoritative inventory`
                        );
                    }
                    if (!Number.isFinite(Date.parse(
                        records[eventId]?.basicSentAt
                    ))) {
                        throw new Error(
                            `state player ${playerId} channel ${channelId} has no durable alert record for ${eventId}`
                        );
                    }
                }
            }
        }
        if (playerState.lowerTotalObservation !== undefined &&
            playerState.lowerTotalObservation !== null) {
            const observation = playerState.lowerTotalObservation;
            if (!isRecord(observation) ||
                !Number.isInteger(observation.value) ||
                observation.value < 0 ||
                !Number.isInteger(observation.count) ||
                observation.count < 1) {
                throw new Error(
                    `state player ${playerId} lower-total observation is invalid`
                );
            }
        }
        if (playerState.inventoryCorrectionCandidate !== undefined &&
            playerState.inventoryCorrectionCandidate !== null) {
            const candidate =
                playerState.inventoryCorrectionCandidate;
            if (!isRecord(candidate) ||
                !/^[a-f0-9]{64}$/.test(String(candidate.digest || '')) ||
                !Number.isInteger(candidate.authoritativeTotal) ||
                candidate.authoritativeTotal < 0) {
                throw new Error(
                    `state player ${playerId} inventory correction candidate is invalid`
                );
            }
            validateIdArray(
                candidate.eventIds,
                `state player ${playerId} inventory correction candidate eventIds`
            );
            validateOptionalTimestamp(
                candidate.observedAt,
                `state player ${playerId} inventory correction candidate observedAt`
            );
            if (!candidate.observedAt) {
                throw new Error(
                    `state player ${playerId} inventory correction candidate has no observedAt`
                );
            }
        }
        if (playerState.lastKnownStats !== undefined &&
            playerState.lastKnownStats !== null &&
            (!isRecord(playerState.lastKnownStats) ||
                !isRecord(playerState.lastKnownStats.stats))) {
            throw new Error(`state player ${playerId} cached stats are invalid`);
        }
        validateOptionalTimestamp(
            playerState.lastKnownStats?.fetchedAt,
            `state player ${playerId} cached stats timestamp`
        );
        validateOptionalTimestamp(
            playerState.authoritativeSnapshotCapturedAt,
            `state player ${playerId} authoritative snapshot timestamp`
        );
    }
    if (Number(value.version || 0) >= 3 &&
        !isRecord(value.pendingEnrichments)) {
        throw new Error('state pendingEnrichments is missing');
    }
    if (value.pendingEnrichments !== undefined &&
        (!value.pendingEnrichments || typeof value.pendingEnrichments !== 'object' ||
            Array.isArray(value.pendingEnrichments))) {
        throw new Error('state pendingEnrichments must be an object');
    }
    for (const [jobKey, record] of Object.entries(value.pendingEnrichments || {})) {
        if (!isRecord(record) ||
            !jobKey.trim() ||
            typeof record.playerId !== 'string' ||
            !record.playerId.trim() ||
            !Number.isInteger(record.season) ||
            typeof record.hrId !== 'string' ||
            !record.hrId.trim() ||
            !isRecord(record.hrDetail)) {
            throw new Error(`state pending enrichment ${jobKey} is invalid`);
        }
        const expectedJobKey =
            `${record.season}:${record.playerId}:${record.hrId}`;
        if (jobKey !== expectedJobKey) {
            throw new Error(
                `state pending enrichment ${jobKey} does not match ${expectedJobKey}`
            );
        }
        validateIdArray(
            record.channelIds,
            `state pending enrichment ${jobKey} channelIds`
        );
        if (record.previousHrIds !== undefined) {
            validateIdArray(
                record.previousHrIds,
                `state pending enrichment ${jobKey} previousHrIds`
            );
        }
        if (record.channelIds.length === 0 ||
            !String(record.hrDetail.gameId || '').trim() ||
            !Number.isInteger(record.hrDetail.gameHomeRunIndex) ||
            record.hrDetail.gameHomeRunIndex < 1) {
            throw new Error(`state pending enrichment ${jobKey} lacks event context`);
        }
        const playerDocument = value.players[record.playerId];
        const deliveryIds = [
            record.hrId,
            ...(record.previousHrIds || [])
        ];
        if (playerDocument?.authoritativeSnapshotInitialized) {
            const authoritativeIds = new Set(
                playerDocument.authoritativeHomeRunIds || []
            );
            if (!deliveryIds.some(eventId =>
                authoritativeIds.has(eventId)
            )) {
                throw new Error(
                    `state pending enrichment ${jobKey} is outside the authoritative inventory`
                );
            }
        }
        if (!playerDocument ||
                    record.channelIds.some(channelId => {
                        const channelRecords =
                            playerDocument.alertMessagesByChannel?.[channelId];
                        return !deliveryIds.some(eventId =>
                            Number.isFinite(Date.parse(
                                channelRecords?.[eventId]?.basicSentAt
                            )) &&
                            !channelRecords[eventId].enrichedAt &&
                            !channelRecords[eventId].retractedAt &&
                            !channelRecords[eventId].enrichmentFailedAt
                        );
                    })) {
            throw new Error(
                `state pending enrichment ${jobKey} has no durable basic delivery`
            );
        }
        validateOptionalTimestamp(
            record.createdAt,
            `state pending enrichment ${jobKey} createdAt`
        );
        if (!record.createdAt) {
            throw new Error(`state pending enrichment ${jobKey} has no createdAt`);
        }
        validateOptionalTimestamp(
            record.nextAttemptAt,
            `state pending enrichment ${jobKey} nextAttemptAt`
        );
        for (const field of [
            'attempts',
            'dataAttempts',
            'analysisAttempts',
            'deliveryAttempts',
            'imageRegenerationAttempts',
        ]) {
            if (record[field] !== undefined &&
                (!Number.isInteger(record[field]) || record[field] < 0)) {
                throw new Error(
                    `state pending enrichment ${jobKey} ${field} is invalid`
                );
            }
        }
    }
    return value;
}

class BaseballBot {
    constructor(token, channelIds, options = {}) {
        this.client = options.client || new Discord.Client({
            intents: [
                Discord.GatewayIntentBits.Guilds,
                Discord.GatewayIntentBits.GuildMessages,
                Discord.GatewayIntentBits.MessageContent
            ],
            allowedMentions: { parse: [], repliedUser: false }
        });
        this.token = token;
        this.channelIds = [...new Set((Array.isArray(channelIds) ? channelIds : [channelIds])
            .map(id => String(id || '').trim())
            .filter(Boolean))];
        if (this.channelIds.length === 0 || this.channelIds.some(id => !/^\d{17,20}$/.test(id))) {
            throw new Error('At least one valid Discord channel ID is required');
        }

        this.clock = options.clock || (() => new Date());
        this.sleep = options.sleep || defaultSleep;
        this.random = options.random || Math.random;
        this.currentSeason = this.clock().getUTCFullYear();
        this.httpClient = options.httpClient || null;
        this.fetchImpl = options.fetch || globalThis.fetch;
        if (!this.httpClient && typeof this.fetchImpl !== 'function') {
            throw new Error('A Fetch-compatible HTTP implementation is required');
        }
        this.httpTimeoutMs = options.httpTimeoutMs || DEFAULT_HTTP_TIMEOUT_MS;
        this.httpRetries = Number.isInteger(options.httpRetries) ? options.httpRetries : DEFAULT_HTTP_RETRIES;
        this.fileSystem = options.fileSystem || fs;
        this.pythonRunner = options.pythonRunner || null;
        this.pythonPath = options.pythonPath || null;
        this.tempRoot = options.tempRoot || path.join(os.tmpdir(), 'home-run-bot');
        this.pythonCommand = null;
        this.pythonArgsPrefix = [];
        this.ballparkDataVersion = null;
        this.ballparkMetadataVersion = null;
        this.pythonPreflightPromise = null;
        this.analysisAvailable = false;
        this.analysisPermanentlyUnavailable = false;
        this.analysisUnavailableReason = null;
        this.initializationComplete = false;

        // Players to monitor
        this.players = {
            '592450': { name: 'Aaron Judge', aliases: ['judge', 'aaron judge'], team: 'NYY', number: '99', lastCheckedHR: 0, sentHomeRuns: new Set(), homeRunParks: {} },
            '700250': { name: 'Ben Rice', aliases: ['rice', 'ben rice'], team: 'NYY', number: '22', lastCheckedHR: 0, sentHomeRuns: new Set(), homeRunParks: {} },
            '665742': { name: 'Juan Soto', aliases: ['soto', 'juan soto'], team: 'NYM', number: '22', lastCheckedHR: 0, sentHomeRuns: new Set(), homeRunParks: {} },
            '660271': { name: 'Shohei Ohtani', aliases: ['ohtani', 'shohei ohtani'], team: 'LAD', number: '17', lastCheckedHR: 0, sentHomeRuns: new Set(), homeRunParks: {} },
            '656941': { name: 'Kyle Schwarber', aliases: ['schwarber', 'kyle schwarber'], team: 'PHI', number: '12', lastCheckedHR: 0, sentHomeRuns: new Set(), homeRunParks: {} },
            '547180': { name: 'Bryce Harper', aliases: ['harper', 'bryce harper'], team: 'PHI', number: '3', lastCheckedHR: 0, sentHomeRuns: new Set(), homeRunParks: {} },
            '683002': { name: 'Gunnar Henderson', aliases: ['gunnar', 'henderson', 'gunnar henderson'], team: 'BAL', number: '2', lastCheckedHR: 0, sentHomeRuns: new Set(), homeRunParks: {} },
            '545361': { name: 'Mike Trout', aliases: ['trout', 'mike trout'], team: 'LAA', number: '27', lastCheckedHR: 0, sentHomeRuns: new Set(), homeRunParks: {} }
        };
        for (const playerData of Object.values(this.players)) {
            playerData.sentHomeRunsByChannel = {};
            playerData.alertMessagesByChannel = {};
            playerData.eventAliases = {};
            playerData.homeRunEvents = {};
            playerData.checkpointInitialized = false;
            playerData.lowerTotalObservation = null;
            playerData.inventoryCorrectionCandidate = null;
            playerData.baselineHomeRunIds = new Set();
            playerData.baselineSnapshotInitialized = false;
            playerData.authoritativeHomeRunIds = new Set();
            playerData.authoritativeSnapshotInitialized = false;
            playerData.authoritativeSnapshotCapturedAt = null;
            playerData.lastKnownStats = null;
            playerData.lastStatsFetchAttemptAt = null;
        }

        this.statePath = resolveStatePath(options.statePath);
        this.stateBackupPath = `${this.statePath}.bak`;
        this.stateLeasePath = `${this.statePath}.lock`;
        this.disableStateLock = Boolean(options.disableStateLock);
        this.stateLeaseId = null;
        this.botUsername = options.botUsername || null;
        this.adminUserIds = new Set((options.adminUserIds || []).map(id => id.toString()));
        this.allowedGuildIds = new Set((options.allowedGuildIds || []).map(id => id.toString()));
        this.guildAllowlistReady = this.allowedGuildIds.size > 0;
        this.processRef = options.processRef || process;

        this.lastCheckTime = null;
        this.lastSuccessfulPollAt = null;
        this.metrics = {
            checksStarted: 0,
            checksSucceeded: 0,
            checksFailed: 0,
            detected: 0,
            queued: 0,
            delivered: 0,
            failed: 0,
            enrichmentsTerminal: 0
        };
        this.checkInProgress = null;
        this.pendingNotifications = new Set();
        this.pendingEnrichments = new Map();
        this.activeEnrichmentJobs = new Map();
        this.activeEnrichmentRecords = new Map();
        this.enrichmentQueue = [];
        this.enrichmentActive = 0;
        this.maxEnrichmentConcurrency = options.enrichmentConcurrency || DEFAULT_ENRICHMENT_CONCURRENCY;
        this.enrichmentMaxAgeMs =
            options.enrichmentMaxAgeMs || DEFAULT_ENRICHMENT_MAX_AGE_MS;
        this.enrichmentMaxDataAttempts =
            options.enrichmentMaxDataAttempts || DEFAULT_ENRICHMENT_MAX_DATA_ATTEMPTS;
        this.authoritativeReconciliationIntervalMs =
            options.authoritativeReconciliationIntervalMs ||
            DEFAULT_AUTHORITATIVE_RECONCILIATION_INTERVAL_MS;
        this.analysisQueue = [];
        this.analysisActive = 0;
        this.maxAnalysisConcurrency = options.analysisConcurrency || DEFAULT_ANALYSIS_CONCURRENCY;
        this.backfillPromises = new Map();
        this.backfillLastStartedAt = new Map();
        this.inventoryReconciliationPlayerIds = new Set();
        this.playerMutationLocks = new Map();
        this.inventoryReconciliationLocks = new Map();
        this.discordMessageMutationLocks = new Map();
        this.discordEventMutationLocks = new Map();
        this.backfillBatchSize =
            options.backfillBatchSize || options.backfillLimit || DEFAULT_BACKFILL_LIMIT;
        this.backfillCooldownMs = options.backfillCooldownMs || DEFAULT_BACKFILL_COOLDOWN_MS;
        this.pollIntervalMs = options.pollIntervalMs || 240000;
        this.offseasonPollIntervalMs = options.offseasonPollIntervalMs || 6 * 60 * 60 * 1000;
        this.pollJitterMs = Number.isInteger(options.pollJitterMs) ? options.pollJitterMs : 30000;
        this.backgroundJobs = new Set();
        this.activeTempDirectories = new Set();
        this.gameLogCache = new Map();
        this.playByPlayCache = new Map();
        this.gameMetadataCache = new Map();
        this.statcastCache = new Map();
        this.displayStatsPromises = new Map();
        this.statsRequestSequences = new Map();
        this.analysisCache = new Map();
        this.gameLogCacheTtlMs = options.gameLogCacheTtlMs || 120000;
        this.playByPlayCacheTtlMs = options.playByPlayCacheTtlMs || 60000;
        this.gameMetadataCacheTtlMs = options.gameMetadataCacheTtlMs || 300000;
        this.statcastCacheTtlMs = options.statcastCacheTtlMs || 30000;
        this.displayStatsCacheTtlMs = options.displayStatsCacheTtlMs || 60000;
        this.monitorTask = null;
        this.enrichmentWakeTimer = null;
        this.gatewayReadyPromise = null;
        this.readyPromise = null;
        this.shuttingDown = false;
        this.shutdownPromise = null;
        this.shutdownFinalizePromise = null;
        this.discordDestroyed = false;
        this.fatalShutdownPromise = null;
        this.removeProcessHandlers = null;
        this.shutdownTimeoutMs = options.shutdownTimeoutMs || DEFAULT_SHUTDOWN_TIMEOUT_MS;
        this.readyTimeoutMs = options.readyTimeoutMs || DEFAULT_READY_TIMEOUT_MS;
        this.startupCatchUpPlayerIds = new Set();
    }

    getPlayerHeadshotUrlById(playerId) {
        if (!playerId) {
            return null;
        }

        return `https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/${playerId}/headshot/67/current`;
    }

    loadState() {
        const fileSystem = this.fileSystem;
        if (!fileSystem.existsSync(this.statePath) && !fileSystem.existsSync(this.stateBackupPath)) {
            return new Set();
        }

        try {
            let parsedState;
            let primaryError = null;
            try {
                parsedState = validateStateDocument(
                    JSON.parse(fileSystem.readFileSync(this.statePath, 'utf8'))
                );
            } catch (error) {
                primaryError = error;
                if (!fileSystem.existsSync(this.stateBackupPath)) {
                    throw error;
                }
                parsedState = validateStateDocument(
                    JSON.parse(fileSystem.readFileSync(this.stateBackupPath, 'utf8'))
                );
            }
            if (primaryError) {
                this.log(`Primary state is invalid (${primaryError.message}); loaded last-known-good backup`);
            }

            const savedSeason = Number(parsedState.season);
            if (savedSeason > this.currentSeason) {
                throw new Error(
                    `state season ${savedSeason} is newer than the active season ` +
                    `${this.currentSeason}; verify the system clock`
                );
            }
            if (savedSeason < this.currentSeason) {
                this.log(
                    `Rolling prior-season state ${savedSeason} forward to ` +
                    `${this.currentSeason} with an explicit zero checkpoint`
                );
                for (const playerData of Object.values(this.players)) {
                    playerData.lastCheckedHR = 0;
                    playerData.checkpointInitialized = true;
                    playerData.baselineHomeRunIds = new Set();
                    playerData.baselineSnapshotInitialized = true;
                    playerData.authoritativeHomeRunIds = new Set();
                    playerData.authoritativeSnapshotInitialized = true;
                    playerData.authoritativeSnapshotCapturedAt =
                        this.clock().toISOString();
                }
                return new Set(Object.keys(this.players));
            }

            const restoredPlayers = new Set();
            const currentReconstructionVersion =
                Number(parsedState.version || 0) >= STATE_VERSION;
            for (const [playerId, savedState] of Object.entries(parsedState.players)) {
                if (!this.players[playerId] || !savedState || typeof savedState !== 'object') {
                    continue;
                }

                const playerData = this.players[playerId];
                const parsedCheckpoint = Number(savedState.lastCheckedHR);
                playerData.lastCheckedHR = parsedCheckpoint;
                playerData.checkpointInitialized =
                    savedState.checkpointInitialized !== false;
                playerData.lowerTotalObservation = savedState.lowerTotalObservation &&
                    Number.isInteger(savedState.lowerTotalObservation.value) &&
                    Number.isInteger(savedState.lowerTotalObservation.count)
                    ? savedState.lowerTotalObservation
                    : null;
                playerData.inventoryCorrectionCandidate =
                    savedState.inventoryCorrectionCandidate &&
                    typeof savedState.inventoryCorrectionCandidate ===
                        'object'
                        ? {
                            ...savedState.inventoryCorrectionCandidate,
                            eventIds: [
                                ...(savedState
                                    .inventoryCorrectionCandidate
                                    .eventIds || [])
                            ]
                        }
                        : null;
                playerData.baselineHomeRunIds = new Set(
                    Array.isArray(savedState.baselineHomeRunIds)
                        ? savedState.baselineHomeRunIds.map(String)
                        : []
                );
                playerData.baselineSnapshotInitialized = Boolean(
                    savedState.baselineSnapshotInitialized
                );
                playerData.authoritativeHomeRunIds = new Set(
                    Array.isArray(savedState.authoritativeHomeRunIds)
                        ? savedState.authoritativeHomeRunIds.map(String)
                        : []
                );
                playerData.authoritativeSnapshotInitialized = Boolean(
                    savedState.authoritativeSnapshotInitialized
                );
                playerData.authoritativeSnapshotCapturedAt =
                    Number.isFinite(Date.parse(
                        savedState.authoritativeSnapshotCapturedAt
                    ))
                        ? savedState.authoritativeSnapshotCapturedAt
                        : null;

                const legacySentHomeRuns = Array.isArray(savedState.sentHomeRuns)
                    ? savedState.sentHomeRuns.map(String)
                    : [];
                playerData.sentHomeRuns = new Set(legacySentHomeRuns);
                playerData.sentHomeRunsByChannel = {};
                playerData.alertMessagesByChannel = {};
                const savedUpdatedAt = parsedState.updatedAt || this.clock().toISOString();
                for (const channelId of this.channelIds) {
                    const perChannelSentHomeRuns = Array.isArray(savedState.sentHomeRunsByChannel?.[channelId])
                        ? savedState.sentHomeRunsByChannel[channelId].map(String)
                        : legacySentHomeRuns;
                    playerData.sentHomeRunsByChannel[channelId] = new Set(perChannelSentHomeRuns);

                    const savedRecords = savedState.alertMessagesByChannel?.[channelId];
                    playerData.alertMessagesByChannel[channelId] =
                        savedRecords && typeof savedRecords === 'object'
                            ? Object.fromEntries(
                                Object.entries(savedRecords).map(
                                    ([eventId, record]) => {
                                        const restoredRecord = { ...record };
                                        delete restoredRecord.retractionInProgress;
                                        return [eventId, restoredRecord];
                                    }
                                )
                            )
                            : {};
                    for (const eventId of perChannelSentHomeRuns) {
                        if (!playerData.alertMessagesByChannel[channelId][eventId]) {
                            if (currentReconstructionVersion) {
                                throw new Error(
                                    `Current state lacks an alert record for ${eventId} in ${channelId}`
                                );
                            }
                            playerData.alertMessagesByChannel[channelId][eventId] = {
                                messageId: null,
                                basicSentAt: savedUpdatedAt,
                                enrichedAt: savedUpdatedAt,
                                deliveryMode: 'legacy-migrated'
                            };
                        }
                    }
                }
                playerData.eventAliases = currentReconstructionVersion &&
                    savedState.eventAliases && typeof savedState.eventAliases === 'object'
                    ? { ...savedState.eventAliases }
                    : {};
                playerData.homeRunEvents = currentReconstructionVersion &&
                    savedState.homeRunEvents &&
                    typeof savedState.homeRunEvents === 'object'
                    ? { ...savedState.homeRunEvents }
                    : {};
                playerData.lastKnownStats = savedState.lastKnownStats &&
                    typeof savedState.lastKnownStats === 'object' &&
                    savedState.lastKnownStats.stats &&
                    typeof savedState.lastKnownStats.stats === 'object'
                    ? {
                        stats: { ...savedState.lastKnownStats.stats },
                        fetchedAt: savedState.lastKnownStats.fetchedAt || parsedState.updatedAt || null
                    }
                    : null;
                this.rebuildSentHomeRuns(playerData);
                playerData.homeRunParks = currentReconstructionVersion &&
                    savedState.homeRunParks &&
                    typeof savedState.homeRunParks === 'object' ? savedState.homeRunParks : {};
                if (playerData.checkpointInitialized) {
                    restoredPlayers.add(playerId);
                }
            }

            const pendingRecords = parsedState.pendingEnrichments;
            if (pendingRecords && typeof pendingRecords === 'object') {
                for (const [jobKey, record] of Object.entries(pendingRecords)) {
                    if (!record || !this.players[String(record.playerId)] ||
                        Number(record.season) !== this.currentSeason || !record.hrDetail) {
                        continue;
                    }
                    const targetChannelIds = Array.isArray(record.channelIds)
                        ? [...new Set(record.channelIds.map(String))].filter(id => this.channelIds.includes(id))
                        : [];
                    if (targetChannelIds.length > 0) {
                        this.pendingEnrichments.set(jobKey, { ...record, channelIds: targetChannelIds });
                    }
                }
            }

            for (const [playerId, playerData] of Object.entries(this.players)) {
                for (const channelId of this.channelIds) {
                    for (const [eventId, delivery] of Object.entries(
                        playerData.alertMessagesByChannel[channelId] || {}
                    )) {
                        if (!delivery?.basicSentAt ||
                            delivery.enrichedAt ||
                            delivery.retractedAt ||
                            delivery.enrichmentFailedAt ||
                            !delivery.hrDetail) {
                            continue;
                        }
                        const hrId = String(eventId);
                        const season = Number(delivery.season) || this.currentSeason;
                        const jobKey = `${season}:${playerId}:${hrId}`;
                        const existing = this.pendingEnrichments.get(jobKey);
                        const channelIds = [...new Set([...(existing?.channelIds || []), channelId])];
                        this.pendingEnrichments.set(jobKey, {
                            playerId,
                            season,
                            hrId,
                            totalHomeRuns: Number(delivery.totalHomeRuns) || null,
                            hrDetail: delivery.hrDetail,
                            createdAt: delivery.basicSentAt,
                            attempts: 0,
                            ...existing,
                            channelIds
                        });
                    }
                }
            }

            return restoredPlayers;
        } catch (error) {
            this.logEvent('fatal', 'state_load_failed', {
                statePath: this.statePath,
                backupPath: this.stateBackupPath,
                error: error.message
            });
            throw new Error(`No valid current state file could be loaded: ${error.message}`, {
                cause: error
            });
        }
    }

    serializeState() {
        const serializedPlayers = {};
        for (const [playerId, playerData] of Object.entries(this.players)) {
            this.ensurePlayerDeliveryState(playerData);
            this.rebuildSentHomeRuns(playerData);
            const serializedPerChannelState = {};
            const serializedAlertRecords = {};
            for (const channelId of this.channelIds) {
                serializedPerChannelState[channelId] = Array.from(playerData.sentHomeRunsByChannel[channelId]);
                serializedAlertRecords[channelId] = Object.fromEntries(
                    Object.entries(
                        playerData.alertMessagesByChannel[channelId] || {}
                    ).map(([eventId, record]) => {
                        const serializedRecord = { ...record };
                        delete serializedRecord.retractionInProgress;
                        return [eventId, serializedRecord];
                    })
                );
            }

            serializedPlayers[playerId] = {
                lastCheckedHR: playerData.lastCheckedHR,
                checkpointInitialized: Boolean(playerData.checkpointInitialized),
                lowerTotalObservation: playerData.lowerTotalObservation || null,
                inventoryCorrectionCandidate:
                    playerData.inventoryCorrectionCandidate || null,
                baselineHomeRunIds: Array.from(playerData.baselineHomeRunIds),
                baselineSnapshotInitialized: Boolean(
                    playerData.baselineSnapshotInitialized
                ),
                authoritativeHomeRunIds: Array.from(
                    playerData.authoritativeHomeRunIds
                ),
                authoritativeSnapshotInitialized: Boolean(
                    playerData.authoritativeSnapshotInitialized
                ),
                authoritativeSnapshotCapturedAt:
                    playerData.authoritativeSnapshotCapturedAt || null,
                sentHomeRuns: Array.from(playerData.sentHomeRuns),
                sentHomeRunsByChannel: serializedPerChannelState,
                alertMessagesByChannel: serializedAlertRecords,
                eventAliases: playerData.eventAliases || {},
                homeRunEvents: playerData.homeRunEvents || {},
                homeRunParks: playerData.homeRunParks || {},
                lastKnownStats: playerData.lastKnownStats || null
            };
        }

        return {
            version: STATE_VERSION,
            season: this.currentSeason,
            updatedAt: this.clock().toISOString(),
            players: serializedPlayers,
            pendingEnrichments: Object.fromEntries(this.pendingEnrichments)
        };
    }

    saveState({ throwOnError = false } = {}) {
        const fileSystem = this.fileSystem;
        let temporaryPath = null;
        let backupTemporaryPath = null;
        try {
            const stateDocument = this.serializeState();
            validateStateDocument(stateDocument);
            const stateDir = path.dirname(this.statePath);
            if (!fileSystem.existsSync(stateDir)) {
                fileSystem.mkdirSync(stateDir, { recursive: true });
            }

            temporaryPath = path.join(
                stateDir,
                `.${path.basename(this.statePath)}.${process.pid}.${crypto.randomUUID()}.tmp`
            );
            const payload = `${JSON.stringify(stateDocument, null, 2)}\n`;
            const descriptor = fileSystem.openSync(temporaryPath, 'wx', 0o600);
            try {
                fileSystem.writeFileSync(descriptor, payload, 'utf8');
                if (typeof fileSystem.fsyncSync === 'function') {
                    fileSystem.fsyncSync(descriptor);
                }
            } finally {
                fileSystem.closeSync(descriptor);
            }
            if (fileSystem.existsSync(this.statePath)) {
                let currentStateIsValid = false;
                try {
                    validateStateDocument(JSON.parse(fileSystem.readFileSync(this.statePath, 'utf8')));
                    currentStateIsValid = true;
                } catch {}
                if (currentStateIsValid) {
                    backupTemporaryPath = path.join(
                        stateDir,
                        `.${path.basename(this.stateBackupPath)}.${process.pid}.${crypto.randomUUID()}.tmp`
                    );
                    fileSystem.copyFileSync(this.statePath, backupTemporaryPath);
                    const backupDescriptor = fileSystem.openSync(backupTemporaryPath, 'r+');
                    try {
                        if (typeof fileSystem.fsyncSync === 'function') {
                            fileSystem.fsyncSync(backupDescriptor);
                        }
                    } finally {
                        fileSystem.closeSync(backupDescriptor);
                    }
                    fileSystem.renameSync(backupTemporaryPath, this.stateBackupPath);
                    backupTemporaryPath = null;
                }
            }
            fileSystem.renameSync(temporaryPath, this.statePath);
            temporaryPath = null;
            try {
                const directoryDescriptor = fileSystem.openSync(stateDir, 'r');
                try {
                    if (typeof fileSystem.fsyncSync === 'function') {
                        fileSystem.fsyncSync(directoryDescriptor);
                    }
                } finally {
                    fileSystem.closeSync(directoryDescriptor);
                }
            } catch {
                // Directory fsync is not supported on every platform (notably Windows).
            }
            return true;
        } catch (error) {
            this.log(`Could not save state file: ${error.message}`);
            if (temporaryPath) {
                try {
                    fileSystem.unlinkSync(temporaryPath);
                } catch {}
            }
            if (backupTemporaryPath) {
                try {
                    fileSystem.unlinkSync(backupTemporaryPath);
                } catch {}
            }
            if (throwOnError) {
                throw error;
            }
            return false;
        }
    }

    ensurePlayerDeliveryState(playerData) {
        if (!(playerData.sentHomeRuns instanceof Set)) {
            playerData.sentHomeRuns = new Set(Array.isArray(playerData.sentHomeRuns) ? playerData.sentHomeRuns : []);
        }

        if (!playerData.sentHomeRunsByChannel || typeof playerData.sentHomeRunsByChannel !== 'object') {
            playerData.sentHomeRunsByChannel = {};
        }
        if (!playerData.alertMessagesByChannel || typeof playerData.alertMessagesByChannel !== 'object') {
            playerData.alertMessagesByChannel = {};
        }
        if (!playerData.eventAliases || typeof playerData.eventAliases !== 'object') {
            playerData.eventAliases = {};
        }
        if (!playerData.homeRunEvents || typeof playerData.homeRunEvents !== 'object') {
            playerData.homeRunEvents = {};
        }
        if (!(playerData.baselineHomeRunIds instanceof Set)) {
            playerData.baselineHomeRunIds = new Set(
                Array.isArray(playerData.baselineHomeRunIds)
                    ? playerData.baselineHomeRunIds.map(String)
                    : []
            );
        }
        if (!(playerData.authoritativeHomeRunIds instanceof Set)) {
            playerData.authoritativeHomeRunIds = new Set(
                Array.isArray(playerData.authoritativeHomeRunIds)
                    ? playerData.authoritativeHomeRunIds.map(String)
                    : []
            );
        }
        playerData.baselineSnapshotInitialized = Boolean(
            playerData.baselineSnapshotInitialized
        );
        playerData.authoritativeSnapshotInitialized = Boolean(
            playerData.authoritativeSnapshotInitialized
        );
        if (!Number.isFinite(Date.parse(
            playerData.authoritativeSnapshotCapturedAt
        ))) {
            playerData.authoritativeSnapshotCapturedAt = null;
        }

        for (const channelId of this.channelIds) {
            if (!(playerData.sentHomeRunsByChannel[channelId] instanceof Set)) {
                const existingIds = Array.isArray(playerData.sentHomeRunsByChannel[channelId])
                    ? playerData.sentHomeRunsByChannel[channelId]
                    : Array.from(playerData.sentHomeRuns);
                playerData.sentHomeRunsByChannel[channelId] = new Set(existingIds);
            }
            if (!playerData.alertMessagesByChannel[channelId] ||
                typeof playerData.alertMessagesByChannel[channelId] !== 'object') {
                playerData.alertMessagesByChannel[channelId] = {};
            }
        }
    }

    getAlertDeliveryRecord(playerData, channelId, hrId, create = false) {
        this.ensurePlayerDeliveryState(playerData);
        if (!playerData.alertMessagesByChannel[channelId][hrId] && create) {
            playerData.alertMessagesByChannel[channelId][hrId] = {};
        }
        return playerData.alertMessagesByChannel[channelId][hrId] || null;
    }

    rebuildSentHomeRuns(playerData) {
        this.ensurePlayerDeliveryState(playerData);
        const fullySentHomeRuns = new Set();
        const candidateIds = new Set();

        for (const channelId of this.channelIds) {
            for (const hrId of playerData.sentHomeRunsByChannel[channelId]) {
                candidateIds.add(hrId);
            }
        }

        for (const hrId of candidateIds) {
            if (this.channelIds.every(channelId => playerData.sentHomeRunsByChannel[channelId].has(hrId))) {
                fullySentHomeRuns.add(hrId);
            }
        }

        playerData.sentHomeRuns = fullySentHomeRuns;
        return fullySentHomeRuns;
    }

    getPendingChannelIdsForHomeRun(playerData, hrId) {
        this.ensurePlayerDeliveryState(playerData);
        return this.channelIds.filter(channelId => !playerData.sentHomeRunsByChannel[channelId].has(hrId));
    }

    markHomeRunSentToChannels(playerData, hrId, channelIds, metadata = {}) {
        if (!Array.isArray(channelIds) || channelIds.length === 0) {
            return;
        }

        this.ensurePlayerDeliveryState(playerData);
        for (const channelId of channelIds) {
            if (!playerData.sentHomeRunsByChannel[channelId]) {
                playerData.sentHomeRunsByChannel[channelId] = new Set();
            }
            playerData.sentHomeRunsByChannel[channelId].add(hrId);
            Object.assign(
                this.getAlertDeliveryRecord(playerData, channelId, hrId, true),
                {
                    basicSentAt: metadata.basicSentAt || this.clock().toISOString(),
                    ...metadata
                }
            );
        }

        this.rebuildSentHomeRuns(playerData);
    }

    isHomeRunFullySent(playerData, hrId) {
        this.ensurePlayerDeliveryState(playerData);
        return this.channelIds.every(channelId => playerData.sentHomeRunsByChannel[channelId].has(hrId));
    }

    countContiguousDeliveredHomeRuns(playerId, playerData, homeRunDetails, checkpointFloor = 0) {
        let deliveredCount = 0;
        const safeCheckpointFloor = Math.max(0, parseInt(checkpointFloor, 10) || 0);
        this.ensurePlayerDeliveryState(playerData);

        for (let index = 0; index < homeRunDetails.length; index++) {
            const hrDetail = homeRunDetails[index];
            if (this.isFallbackHomeRunDetail(hrDetail)) {
                break;
            }

            const hrId = this.reconcileHomeRunAliases(playerId, playerData, hrDetail);
            const acceptedAsBaseline =
                playerData.baselineSnapshotInitialized &&
                playerData.baselineHomeRunIds.has(hrId);
            const legacyCheckpointFallback =
                !playerData.baselineSnapshotInitialized &&
                index < safeCheckpointFloor;
            if (!acceptedAsBaseline &&
                !legacyCheckpointFallback &&
                !this.isHomeRunFullySent(playerData, hrId)) {
                break;
            }

            deliveredCount++;
        }

        return deliveredCount;
    }

    prepareHomeRunInventory(playerId, homeRunDetails, count) {
        const requestedCount = Math.max(0, Number.parseInt(count, 10) || 0);
        const details = Array.isArray(homeRunDetails)
            ? homeRunDetails.slice(0, requestedCount)
            : [];
        if (details.length !== requestedCount ||
            details.some(detail => this.isFallbackHomeRunDetail(detail))) {
            return null;
        }

        const prepared = details.map(detail => {
            const identity = this.getHomeRunAliases(detail, playerId);
            return {
                detail,
                canonicalId: identity.canonicalId,
                aliases: identity.aliases
            };
        });
        if (new Set(prepared.map(item => item.canonicalId)).size !== requestedCount) {
            this.logEvent('warn', 'duplicate_home_run_inventory_identity', {
                playerId: String(playerId),
                requestedCount
            });
            return null;
        }

        const aliasOwners = new Map();
        for (const item of prepared) {
            for (const alias of item.aliases) {
                const owner = aliasOwners.get(alias);
                if (owner && owner !== item.canonicalId) {
                    this.logEvent('warn', 'ambiguous_home_run_inventory_alias', {
                        playerId: String(playerId),
                        alias,
                        eventIds: [owner, item.canonicalId]
                    });
                    return null;
                }
                aliasOwners.set(alias, item.canonicalId);
            }
        }
        return prepared;
    }

    canonicalizeHomeRunInventory(playerId, playerData, homeRunDetails, count) {
        const prepared = this.prepareHomeRunInventory(
            playerId,
            homeRunDetails,
            count
        );
        if (!prepared) return null;

        const eventIds = [];
        for (const { detail } of prepared) {
            const eventId = this.reconcileHomeRunAliases(
                playerId,
                playerData,
                detail
            );
            eventIds.push(eventId);
            playerData.homeRunEvents[eventId] = {
                ...detail,
                eventKey: eventId,
                playerId: String(playerId),
                season: this.currentSeason
            };
        }
        return eventIds;
    }

    captureBaselineInventory(playerId, playerData, homeRunDetails, count) {
        const eventIds = this.canonicalizeHomeRunInventory(
            playerId,
            playerData,
            homeRunDetails,
            count
        );
        if (!eventIds) return false;
        playerData.baselineHomeRunIds = new Set(eventIds);
        playerData.baselineSnapshotInitialized = true;
        return true;
    }

    captureAuthoritativeInventory(playerId, playerData, homeRunDetails, count) {
        const eventIds = this.canonicalizeHomeRunInventory(
            playerId,
            playerData,
            homeRunDetails,
            count
        );
        if (!eventIds) return null;
        playerData.authoritativeHomeRunIds = new Set(eventIds);
        playerData.authoritativeSnapshotInitialized = true;
        playerData.authoritativeSnapshotCapturedAt =
            this.clock().toISOString();
        return eventIds;
    }

    async acquireKeyedLock(lockMap, key) {
        const normalizedKey = String(key);
        const previous = lockMap.get(normalizedKey) || Promise.resolve();
        let releaseGate;
        const gate = new Promise(resolve => {
            releaseGate = resolve;
        });
        const tail = previous.catch(() => {}).then(() => gate);
        lockMap.set(normalizedKey, tail);
        await previous.catch(() => {});

        let released = false;
        return () => {
            if (released) return;
            released = true;
            releaseGate();
            if (lockMap.get(normalizedKey) === tail) {
                lockMap.delete(normalizedKey);
            }
        };
    }

    async annotateRetractedHomeRun(playerId, playerData, eventId) {
        let allAnnotated = true;
        for (const channelId of this.channelIds) {
            const releaseEventMutation =
                await this.acquireKeyedLock(
                    this.discordEventMutationLocks,
                    `${channelId}:${eventId}`
                );
            try {
                const delivery = this.getAlertDeliveryRecord(
                    playerData,
                    channelId,
                    eventId
                );
                if (!delivery || delivery.retractedAt) continue;

                let annotated = false;
                delivery.retractionInProgress = true;
                try {
                    const channel =
                        await this.client.channels.fetch(channelId);
                    const messageIds = [...new Set([
                        delivery.messageId,
                        delivery.enrichmentMessageId
                    ].filter(Boolean))];
                    const failedMessageIds = [];
                    for (const messageId of messageIds) {
                        const releaseMessageMutation =
                            await this.acquireKeyedLock(
                                this.discordMessageMutationLocks,
                                `${channelId}:${messageId}`
                            );
                        try {
                            const message =
                                await channel.messages.fetch(messageId);
                            if (!message?.embeds?.[0]) {
                                throw new Error(
                                    'message has no editable alert embed'
                                );
                            }
                            const embed =
                                Discord.EmbedBuilder.from(
                                    message.embeds[0]
                                )
                                    .setColor('#747F8D')
                                    .setFooter({
                                        text:
                                            'MLB correction: this play is no longer counted as a home run.'
                                    });
                            await message.edit({ embeds: [embed] });
                        } catch (error) {
                            failedMessageIds.push(messageId);
                            this.logEvent(
                                'warn',
                                'retracted_alert_edit_failed',
                                {
                                    playerId,
                                    eventId,
                                    channelId,
                                    messageId,
                                    error: error.message
                                }
                            );
                        } finally {
                            releaseMessageMutation();
                        }
                    }
                    if ((messageIds.length === 0 ||
                        failedMessageIds.length > 0) &&
                        !delivery.correctionMessageId) {
                        const correction = await channel.send({
                            content:
                                `Correction: MLB no longer counts the previously alerted ` +
                                `${playerData.name} play (${eventId}) as a home run.`,
                            allowedMentions: { parse: [] },
                            nonce: this.buildDiscordNonce(
                                'correction',
                                channelId,
                                eventId
                            ),
                            enforceNonce: true
                        });
                        delivery.correctionMessageId = correction?.id
                            ? String(correction.id)
                            : null;
                    }
                    annotated =
                        (messageIds.length > 0 &&
                            failedMessageIds.length === 0) ||
                        Boolean(delivery.correctionMessageId);
                } catch (error) {
                    this.logEvent(
                        'warn',
                        'retracted_alert_annotation_failed',
                        {
                            playerId,
                            eventId,
                            channelId,
                            error: error.message
                        }
                    );
                } finally {
                    delivery.retractionInProgress = false;
                }
                if (annotated) {
                    delivery.retractedAt =
                        this.clock().toISOString();
                    try {
                        this.saveState({ throwOnError: true });
                    } catch (error) {
                        this.scheduleFatalShutdown(
                            'correction-ack-persistence-failed',
                            error
                        );
                        throw error;
                    }
                } else {
                    allAnnotated = false;
                }
            } finally {
                releaseEventMutation();
            }
        }
        return allAnnotated;
    }

    cancelEnrichmentsForEvent(playerId, eventId, reason) {
        const matchesEvent = record =>
            String(record?.playerId) === String(playerId) &&
            [record?.hrId, ...(record?.previousHrIds || [])]
                .map(String)
                .includes(String(eventId));
        const activeJobs = new Set();

        for (const [jobKey, record] of [...this.pendingEnrichments]) {
            if (!matchesEvent(record)) continue;
            record.cancelledReason = reason;
            this.pendingEnrichments.delete(jobKey);
            this.enrichmentQueue = this.enrichmentQueue
                .filter(queuedKey => queuedKey !== jobKey);
        }
        for (const [jobKey, record] of this.activeEnrichmentRecords) {
            if (!matchesEvent(record)) continue;
            record.cancelledReason = reason;
            const job = this.activeEnrichmentJobs.get(jobKey);
            if (job) activeJobs.add(job);
        }
        return [...activeJobs];
    }

    restoreEnrichmentForEvent(playerId, playerData, eventId) {
        const channelIds = this.channelIds.filter(channelId => {
            const delivery = this.getAlertDeliveryRecord(
                playerData,
                channelId,
                eventId
            );
            return delivery?.basicSentAt &&
                !delivery.enrichedAt &&
                !delivery.retractedAt &&
                !delivery.enrichmentFailedAt &&
                delivery.hrDetail;
        });
        if (channelIds.length === 0) return false;

        const delivery = this.getAlertDeliveryRecord(
            playerData,
            channelIds[0],
            eventId
        );
        const season =
            Number(delivery.season) || this.currentSeason;
        this.queueEnrichment({
            playerId: String(playerId),
            season,
            hrId: String(eventId),
            totalHomeRuns:
                Number(delivery.totalHomeRuns) || null,
            hrDetail: {
                ...delivery.hrDetail,
                eventKey: String(eventId),
                playerId: String(playerId),
                season
            },
            channelIds,
            createdAt:
                delivery.basicSentAt ||
                this.clock().toISOString(),
            attempts: 0
        }, { persist: false });
        return true;
    }

    async reconcileAuthoritativeInventory(
        playerId,
        playerData,
        details,
        authoritativeTotal,
        {
            persist = true,
            requireCorrectionConfirmation = false
        } = {}
    ) {
        const release = await this.acquireKeyedLock(
            this.inventoryReconciliationLocks,
            playerId
        );
        try {
            return await this.reconcileAuthoritativeInventoryCore(
                playerId,
                playerData,
                details,
                authoritativeTotal,
                {
                    persist,
                    requireCorrectionConfirmation
                }
            );
        } finally {
            release();
        }
    }

    async reconcileAuthoritativeInventoryCore(
        playerId,
        playerData,
        details,
        authoritativeTotal,
        {
            persist = true,
            requireCorrectionConfirmation = false
        } = {}
    ) {
        const reconciliationPlayerId = String(playerId);
        this.inventoryReconciliationPlayerIds.add(reconciliationPlayerId);
        try {
            this.ensurePlayerDeliveryState(playerData);
            const activeBackfill = this.backfillPromises.get(reconciliationPlayerId);
            if (activeBackfill) {
                await activeBackfill;
                if (this.shuttingDown) return null;
                const refreshedTotal =
                    await this.getPlayerHomeRunTotal(playerId);
                if (refreshedTotal !== authoritativeTotal) {
                    this.logEvent(
                        'warn',
                        'inventory_snapshot_changed_after_backfill',
                        {
                            playerId,
                            expectedTotal: authoritativeTotal,
                            refreshedTotal
                        }
                    );
                    return null;
                }
                details = authoritativeTotal > 0
                    ? await this.getRecentHomeRunDetails(
                        playerId,
                        authoritativeTotal,
                        { force: true }
                    )
                    : [];
                const reconfirmedTotal =
                    await this.getPlayerHomeRunTotal(playerId);
                if (reconfirmedTotal !== authoritativeTotal) {
                    this.logEvent(
                        'warn',
                        'inventory_snapshot_changed_during_backfill_refresh',
                        {
                            playerId,
                            expectedTotal: authoritativeTotal,
                            reconfirmedTotal
                        }
                    );
                    return null;
                }
            }
            const prepared = this.prepareHomeRunInventory(
                playerId,
                details,
                authoritativeTotal
            );
            if (!prepared) {
                this.logEvent('warn', 'correction_inventory_unavailable', {
                    playerId,
                    authoritativeTotal
                });
                return null;
            }

            const prospectiveIds = new Set(
                prepared.map(item => item.canonicalId)
            );
            const aliasOwners = new Map();
            for (const item of prepared) {
                for (const alias of item.aliases) {
                    aliasOwners.set(alias, item.canonicalId);
                }
            }
            const priorIds = playerData.authoritativeSnapshotInitialized
                ? new Set(playerData.authoritativeHomeRunIds)
                : new Set([
                    ...Object.keys(playerData.homeRunEvents || {}),
                    ...this.channelIds.flatMap(channelId =>
                        [...(playerData.sentHomeRunsByChannel[channelId] || [])]
                    )
                ]);
            const removedIds = [...priorIds].filter(eventId =>
                !prospectiveIds.has(eventId) && !aliasOwners.has(eventId)
            );
            if (removedIds.length > 0 &&
                requireCorrectionConfirmation) {
                const candidateEventIds =
                    [...prospectiveIds].sort();
                const digest = crypto.createHash('sha256')
                    .update(JSON.stringify({
                        authoritativeTotal,
                        eventIds: candidateEventIds
                    }))
                    .digest('hex');
                const priorCandidate =
                    playerData.inventoryCorrectionCandidate;
                if (priorCandidate?.digest !== digest) {
                    playerData.inventoryCorrectionCandidate = {
                        digest,
                        authoritativeTotal,
                        eventIds: candidateEventIds,
                        observedAt: this.clock().toISOString()
                    };
                    try {
                        this.saveState({ throwOnError: true });
                    } catch (error) {
                        this.scheduleFatalShutdown(
                            'inventory-correction-candidate-persistence-failed',
                            error
                        );
                        throw error;
                    }
                    this.logEvent(
                        'warn',
                        'inventory_correction_waiting_for_confirmation',
                        {
                            playerId,
                            authoritativeTotal,
                            removedEventIds: removedIds
                        }
                    );
                    return null;
                }
            }

            const activeCorrectionJobs = new Set();
            for (const eventId of removedIds) {
                for (const job of this.cancelEnrichmentsForEvent(
                    playerId,
                    eventId,
                    'official-correction'
                )) {
                    activeCorrectionJobs.add(job);
                }
            }
            if (activeCorrectionJobs.size > 0) {
                await Promise.allSettled(activeCorrectionJobs);
                if (this.shuttingDown) return null;
            }

            for (const eventId of removedIds) {
                const annotated = await this.annotateRetractedHomeRun(
                    playerId,
                    playerData,
                    eventId
                );
                if (!annotated) {
                    for (const removedEventId of removedIds) {
                        this.restoreEnrichmentForEvent(
                            playerId,
                            playerData,
                            removedEventId
                        );
                    }
                    try {
                        this.saveState({ throwOnError: true });
                    } catch (error) {
                        this.scheduleFatalShutdown(
                            'correction-restoration-persistence-failed',
                            error
                        );
                        throw error;
                    }
                    this.logEvent('warn', 'correction_alert_annotation_deferred', {
                        playerId,
                        eventId
                    });
                    return null;
                }
            }

            const eventIds = this.canonicalizeHomeRunInventory(
                playerId,
                playerData,
                details,
                authoritativeTotal
            );
            if (!eventIds) {
                throw new Error(
                    'Prepared authoritative inventory could not be committed'
                );
            }
            const currentIds = new Set(eventIds);
            for (const eventId of [...playerData.baselineHomeRunIds]) {
                if (!currentIds.has(eventId)) {
                    playerData.baselineHomeRunIds.delete(eventId);
                }
            }
            for (const eventId of Object.keys(playerData.homeRunEvents)) {
                if (!currentIds.has(eventId)) {
                    delete playerData.homeRunEvents[eventId];
                }
            }
            for (const eventId of Object.keys(playerData.homeRunParks)) {
                if (!currentIds.has(eventId)) {
                    delete playerData.homeRunParks[eventId];
                }
            }
            for (const channelId of this.channelIds) {
                for (const eventId of [
                    ...playerData.sentHomeRunsByChannel[channelId]
                ]) {
                    if (!currentIds.has(eventId)) {
                        playerData.sentHomeRunsByChannel[channelId].delete(
                            eventId
                        );
                    }
                }
            }
            playerData.authoritativeHomeRunIds = currentIds;
            playerData.authoritativeSnapshotInitialized = true;
            playerData.authoritativeSnapshotCapturedAt =
                this.clock().toISOString();
            playerData.inventoryCorrectionCandidate = null;
            this.rebuildSentHomeRuns(playerData);
            if (removedIds.length > 0 && playerData.checkpointInitialized) {
                playerData.lastCheckedHR = Math.min(
                    authoritativeTotal,
                    playerData.lastCheckedHR,
                    this.countContiguousDeliveredHomeRuns(
                        playerId,
                        playerData,
                        details,
                        0
                    )
                );
            }
            if (persist) {
                try {
                    this.saveState({ throwOnError: true });
                } catch (error) {
                    this.scheduleFatalShutdown(
                        'inventory-reconciliation-persistence-failed',
                        error
                    );
                    throw error;
                }
            }
            if (removedIds.length > 0) {
                this.logEvent('warn', 'official_inventory_correction_reconciled', {
                    playerId,
                    authoritativeTotal,
                    removedEventIds: removedIds
                });
            }
            return eventIds;
        } finally {
            this.inventoryReconciliationPlayerIds.delete(
                reconciliationPlayerId
            );
        }
    }

    async reconcileDownwardCorrection(
        playerId,
        playerData,
        correctedTotal
    ) {
        const details = correctedTotal > 0
            ? await this.getRecentHomeRunDetails(
                playerId,
                correctedTotal,
                { force: true }
            )
            : [];
        const confirmedTotal = await this.getPlayerHomeRunTotal(playerId);
        if (confirmedTotal !== correctedTotal) {
            this.logEvent('warn', 'correction_snapshot_changed', {
                playerId,
                expectedTotal: correctedTotal,
                confirmedTotal
            });
            return false;
        }
        const reconciled = await this.reconcileAuthoritativeInventory(
            playerId,
            playerData,
            details,
            correctedTotal
        );
        return Boolean(reconciled);
    }

    createHomeRunDetail(overrides = {}) {
        return {
            distance: 'Distance not available',
            rbi: null,
            rbiDescription: 'HR (RBI pending)',
            detailStatus: 'confirmed',
            gameId: null,
            gameDate: null,
            eventKey: null,
            atBatIndex: null,
            gameHomeRunIndex: null,
            playerId: null,
            season: this.currentSeason,
            ...overrides
        };
    }

    createFallbackHomeRunDetails(count, playerId) {
        return Array.from({ length: count }, (_, index) => this.createHomeRunDetail({
            detailStatus: 'fallback',
            playerId: String(playerId),
            season: this.currentSeason,
            eventKey: `hr:${this.currentSeason}:${playerId}:fallback:${index + 1}`
        }));
    }

    isFallbackHomeRunDetail(hrDetail) {
        if (!hrDetail) {
            return true;
        }

        return hrDetail.detailStatus === 'fallback' ||
            (!hrDetail.gameId && String(hrDetail.eventKey || '').includes('fallback'));
    }

    sortHomeRunDetailsChronologically(details) {
        return (Array.isArray(details) ? details : [])
            .map((detail, index) => ({ detail, index }))
            .sort((left, right) => {
                const leftDate = safeDateTimestamp(left.detail?.gameDate);
                const rightDate = safeDateTimestamp(right.detail?.gameDate);
                if (leftDate !== rightDate) {
                    return leftDate - rightDate;
                }

                const leftGameNumber = Number.isInteger(left.detail?.gameNumber)
                    ? left.detail.gameNumber
                    : Number.MAX_SAFE_INTEGER;
                const rightGameNumber = Number.isInteger(right.detail?.gameNumber)
                    ? right.detail.gameNumber
                    : Number.MAX_SAFE_INTEGER;
                if (leftGameNumber !== rightGameNumber) {
                    return leftGameNumber - rightGameNumber;
                }

                const leftGameId = Number.parseInt(left.detail?.gameId, 10);
                const rightGameId = Number.parseInt(right.detail?.gameId, 10);
                const safeLeftGameId = Number.isFinite(leftGameId) ? leftGameId : Number.MAX_SAFE_INTEGER;
                const safeRightGameId = Number.isFinite(rightGameId) ? rightGameId : Number.MAX_SAFE_INTEGER;
                if (safeLeftGameId !== safeRightGameId) {
                    return safeLeftGameId - safeRightGameId;
                }

                const leftSlot = Number.isInteger(left.detail?.gameHomeRunIndex)
                    ? left.detail.gameHomeRunIndex
                    : Number.MAX_SAFE_INTEGER;
                const rightSlot = Number.isInteger(right.detail?.gameHomeRunIndex)
                    ? right.detail.gameHomeRunIndex
                    : Number.MAX_SAFE_INTEGER;
                if (leftSlot !== rightSlot) {
                    return leftSlot - rightSlot;
                }

                const leftAtBatIndex = Number.isInteger(left.detail?.atBatIndex)
                    ? left.detail.atBatIndex
                    : Number.MAX_SAFE_INTEGER;
                const rightAtBatIndex = Number.isInteger(right.detail?.atBatIndex)
                    ? right.detail.atBatIndex
                    : Number.MAX_SAFE_INTEGER;
                if (leftAtBatIndex !== rightAtBatIndex) {
                    return leftAtBatIndex - rightAtBatIndex;
                }

                return left.index - right.index;
            })
            .map(item => item.detail);
    }

    buildHomeRunId(hrDetail, explicitPlayerId = null) {
        const playerId = String(explicitPlayerId || hrDetail?.playerId || 'unknown');
        const season = Number.parseInt(hrDetail?.season, 10) || this.currentSeason;
        const gameId = String(hrDetail?.gameId || 'unknown');

        if (Number.isInteger(hrDetail?.atBatIndex)) {
            return `hr:${season}:${playerId}:${gameId}:ab:${hrDetail.atBatIndex}`;
        }
        if (Number.isInteger(hrDetail?.gameHomeRunIndex)) {
            return `hr:${season}:${playerId}:${gameId}:slot:${hrDetail.gameHomeRunIndex}`;
        }
        if (String(hrDetail?.eventKey || '').startsWith('hr:')) {
            return String(hrDetail.eventKey);
        }

        const fallbackDigest = crypto.createHash('sha256')
            .update(JSON.stringify({
                playerId,
                season,
                gameId,
                gameDate: hrDetail?.gameDate || null,
                eventKey: hrDetail?.eventKey || null,
                slot: hrDetail?.gameHomeRunIndex || null
            }))
            .digest('hex')
            .slice(0, 16);
        return `hr:${season}:${playerId}:${gameId}:fallback:${fallbackDigest}`;
    }

    buildDiscordNonce(kind, channelId, eventId) {
        const digest = crypto.createHash('sha256')
            .update(`${kind}:${channelId}:${eventId}`)
            .digest('hex')
            .slice(0, 24);
        return `${String(kind || 'm').charAt(0)}${digest}`;
    }

    getHomeRunAliases(hrDetail, explicitPlayerId = null) {
        const playerId = String(explicitPlayerId || hrDetail?.playerId || 'unknown');
        const season = Number.parseInt(hrDetail?.season, 10) || this.currentSeason;
        const canonicalId = this.buildHomeRunId(hrDetail, playerId);
        const aliases = new Set([canonicalId]);
        const gameId = hrDetail?.gameId ? String(hrDetail.gameId) : null;
        const slot = Number.isInteger(hrDetail?.gameHomeRunIndex) ? hrDetail.gameHomeRunIndex : null;

        if (hrDetail?.eventKey) {
            aliases.add(String(hrDetail.eventKey));
        }
        if (gameId && Number.isInteger(hrDetail?.atBatIndex)) {
            aliases.add(`${gameId}_${hrDetail.atBatIndex}`);
        }
        if (gameId && slot !== null) {
            aliases.add(`hr:${season}:${playerId}:${gameId}:slot:${slot}`);
            aliases.add(`${gameId}_${hrDetail?.gameDate || 'unknown'}_placeholder_${slot}`);
            aliases.add(`${gameId}_${hrDetail?.gameDate || 'unknown'}_${slot}`);
        }
        return { canonicalId, aliases: Array.from(aliases).filter(Boolean) };
    }

    reconcileHomeRunAliases(playerId, playerData, hrDetail) {
        this.ensurePlayerDeliveryState(playerData);
        const { canonicalId, aliases } = this.getHomeRunAliases(hrDetail, playerId);

        for (const alias of aliases) {
            playerData.eventAliases[alias] = canonicalId;
        }
        for (const channelId of this.channelIds) {
            const sentSet = playerData.sentHomeRunsByChannel[channelId];
            const records = playerData.alertMessagesByChannel[channelId];
            const deliveredAlias = aliases.find(alias => alias !== canonicalId && sentSet.has(alias)) ||
                (sentSet.has(canonicalId) ? canonicalId : null);
            if (deliveredAlias) {
                sentSet.add(canonicalId);
                const recordAlias = aliases.find(alias => alias !== canonicalId && records[alias]);
                if (recordAlias) {
                    const aliasRecord = records[recordAlias];
                    const aliasSnapshot = { ...aliasRecord };
                    Object.assign(
                        aliasRecord,
                        records[canonicalId] || {},
                        aliasSnapshot,
                        {
                            reconciledFrom: recordAlias,
                            hrId: canonicalId,
                            hrDetail: {
                                ...(aliasRecord.hrDetail || {}),
                                ...hrDetail,
                                eventKey: canonicalId,
                                playerId: String(playerId),
                                season:
                                    Number.parseInt(hrDetail?.season, 10) ||
                                    this.currentSeason
                            }
                        }
                    );
                    records[canonicalId] = aliasRecord;
                }
            }
            for (const alias of aliases) {
                if (alias === canonicalId) continue;
                sentSet.delete(alias);
                delete records[alias];
            }
        }

        if (!Object.prototype.hasOwnProperty.call(playerData.homeRunParks, canonicalId)) {
            const parksAlias = aliases.find(alias => alias !== canonicalId &&
                Object.prototype.hasOwnProperty.call(playerData.homeRunParks, alias)
            );
            if (parksAlias) {
                playerData.homeRunParks[canonicalId] = playerData.homeRunParks[parksAlias];
            }
        }
        if (!Object.prototype.hasOwnProperty.call(playerData.homeRunEvents, canonicalId)) {
            const eventAlias = aliases.find(alias => alias !== canonicalId &&
                Object.prototype.hasOwnProperty.call(playerData.homeRunEvents, alias)
            );
            if (eventAlias) {
                playerData.homeRunEvents[canonicalId] = playerData.homeRunEvents[eventAlias];
            }
        }
        for (const alias of aliases) {
            if (alias === canonicalId) continue;
            delete playerData.homeRunParks[alias];
            delete playerData.homeRunEvents[alias];
        }
        for (const inventory of [
            playerData.baselineHomeRunIds,
            playerData.authoritativeHomeRunIds,
        ]) {
            if (aliases.some(alias => inventory.has(alias))) {
                inventory.add(canonicalId);
            }
            for (const alias of aliases) {
                if (alias !== canonicalId) inventory.delete(alias);
            }
        }
        this.migratePendingEnrichmentAliases(
            playerId,
            Number.parseInt(hrDetail?.season, 10) || this.currentSeason,
            canonicalId,
            aliases,
            hrDetail
        );

        this.rebuildSentHomeRuns(playerData);
        return canonicalId;
    }

    migratePendingEnrichmentAliases(
        playerId,
        season,
        canonicalId,
        aliases,
        canonicalDetail
    ) {
        const aliasSet = new Set(aliases.map(String));
        const matchingEntries = [...this.pendingEnrichments.entries()]
            .filter(([, record]) =>
                String(record?.playerId) === String(playerId) &&
                Number(record?.season) === Number(season) &&
                aliasSet.has(String(record?.hrId))
            );
        if (matchingEntries.length === 0) return;

        const canonicalJobKey = `${season}:${playerId}:${canonicalId}`;
        const canonicalRecord =
            this.pendingEnrichments.get(canonicalJobKey) || null;
        const activeRecord = matchingEntries
            .map(([, record]) => record)
            .find(record => this.isEnrichmentRecordActive(record));
        let targetRecord = activeRecord || canonicalRecord;
        if (targetRecord && canonicalRecord && targetRecord !== canonicalRecord) {
            this.mergeEnrichmentRecord(targetRecord, canonicalRecord);
        }
        for (const [oldJobKey, record] of matchingEntries) {
            record.previousHrIds = [...new Set([
                ...(record.previousHrIds || []),
                String(record.hrId)
            ])].filter(id => id !== canonicalId);
            record.hrId = canonicalId;
            record.hrDetail = {
                ...(record.hrDetail || {}),
                ...(canonicalDetail || {}),
                eventKey: canonicalId,
                playerId: String(playerId),
                season
            };

            if (!targetRecord || targetRecord === record) {
                targetRecord = record;
            } else {
                this.mergeEnrichmentRecord(targetRecord, record);
                if (this.isEnrichmentRecordActive(record)) {
                    record.cancelledReason = 'alias-superseded';
                }
            }
            if (oldJobKey !== canonicalJobKey) {
                this.pendingEnrichments.delete(oldJobKey);
            }
        }
        this.pendingEnrichments.set(canonicalJobKey, targetRecord);
        this.enrichmentQueue = [...new Set(this.enrichmentQueue.map(
            queuedKey => matchingEntries.some(([oldKey]) => oldKey === queuedKey)
                ? canonicalJobKey
                : queuedKey
        ))];
    }

    buildPlayIdentifiers(play, gameId, gameDate, gameHomeRunIndex, playerId = null) {
        const atBatIndex = Number.isInteger(play.about?.atBatIndex) ? play.about.atBatIndex : null;
        const detail = {
            playerId: playerId ? String(playerId) : null,
            season: this.currentSeason,
            gameId,
            gameDate,
            gameHomeRunIndex,
            atBatIndex
        };

        return {
            atBatIndex,
            gameHomeRunIndex,
            eventKey: this.buildHomeRunId(detail, playerId)
        };
    }

    resolvePlayerByName(playerName) {
        const query = String(playerName || '').trim().toLowerCase();
        if (!query) {
            return { status: 'not_found', query, playerId: null, candidates: [] };
        }
        if (this.players[query]) {
            return {
                status: 'matched',
                query,
                playerId: query,
                candidates: [{ playerId: query, name: this.players[query].name }]
            };
        }

        const exactMatches = Object.entries(this.players)
            .filter(([, player]) => [player.name, ...(player.aliases || [])]
                .some(alias => alias.toLowerCase() === query))
            .map(([playerId, player]) => ({ playerId, name: player.name }));
        if (exactMatches.length === 1) {
            return { status: 'matched', query, playerId: exactMatches[0].playerId, candidates: exactMatches };
        }
        if (exactMatches.length > 1) {
            return { status: 'ambiguous', query, playerId: null, candidates: exactMatches };
        }

        const partialMatches = Object.entries(this.players)
            .filter(([, player]) => [player.name, ...(player.aliases || [])]
                .some(alias => alias.toLowerCase().includes(query)))
            .map(([playerId, player]) => ({ playerId, name: player.name }));
        if (partialMatches.length === 1) {
            return {
                status: 'matched',
                query,
                playerId: partialMatches[0].playerId,
                candidates: partialMatches
            };
        }
        return {
            status: partialMatches.length > 1 ? 'ambiguous' : 'not_found',
            query,
            playerId: null,
            candidates: partialMatches
        };
    }

    formatPlayerResolutionError(playerName, resolution) {
        if (resolution.status === 'ambiguous') {
            const names = resolution.candidates.map(candidate => candidate.name).join(', ');
            return `Player query "${playerName}" is ambiguous. Matches: ${names}. Please use a full name.`;
        }
        return `Could not find a tracked player matching "${playerName}".`;
    }

    getPlayerShortcutCommands() {
        const candidates = new Map();
        for (const [playerId, player] of Object.entries(this.players)) {
            for (const alias of (player.aliases || [])) {
                const normalizedAlias = String(alias).trim().toLowerCase();
                if (!normalizedAlias || /\s/.test(normalizedAlias)) continue;
                const command = `!${normalizedAlias}`;
                const matches = candidates.get(command) || [];
                matches.push(playerId);
                candidates.set(command, matches);
            }
        }
        return new Map(
            [...candidates]
                .filter(([, playerIds]) => playerIds.length === 1)
                .map(([command, playerIds]) => [command, playerIds[0]])
        );
    }

    isGuildAllowed(message) {
        if (!message.guildId || !this.guildAllowlistReady) {
            return false;
        }
        return this.allowedGuildIds.has(message.guildId);
    }

    isAdminMessage(message) {
        return Boolean(message?.author?.id && this.adminUserIds.has(message.author.id));
    }

    async ensureAdmin(message) {
        if (this.isAdminMessage(message)) {
            return true;
        }

        await message.reply('That command is restricted to user IDs explicitly listed in ADMIN_USER_IDS.');
        return false;
    }

    async syncBotProfile() {
        if (!this.botUsername || !this.client.user) {
            return;
        }

        if (this.client.user.username === this.botUsername) {
            this.log(`Bot username already set to ${this.botUsername}`);
            return;
        }

        try {
            await this.client.user.setUsername(this.botUsername);
            this.log(`Updated bot username to ${this.botUsername}`);
        } catch (error) {
            this.log(`Could not update bot username automatically: ${error.message}`);
        }
    }

    log(message) {
        this.logEvent('info', 'message', { message });
    }

    logEvent(level, event, context = {}) {
        const record = {
            timestamp: this.clock().toISOString(),
            level,
            event,
            ...context
        };
        const output = JSON.stringify(record);
        if (level === 'error' || level === 'fatal') {
            console.error(output);
        } else if (level === 'warn') {
            console.warn(output);
        } else {
            console.log(output);
        }
    }

    isProcessAlive(pid) {
        if (!Number.isInteger(pid) || pid <= 0) return false;
        try {
            process.kill(pid, 0);
            return true;
        } catch (error) {
            return error?.code === 'EPERM';
        }
    }

    acquireStateLease() {
        if (this.disableStateLock || this.stateLeaseId) return;
        const fileSystem = this.fileSystem;
        const stateDir = path.dirname(this.statePath);
        if (!fileSystem.existsSync(stateDir)) {
            fileSystem.mkdirSync(stateDir, { recursive: true });
        }

        const attemptAcquire = () => {
            const leaseId = crypto.randomUUID();
            const descriptor = fileSystem.openSync(this.stateLeasePath, 'wx', 0o600);
            try {
                const payload = JSON.stringify({
                    version: 1,
                    pid: process.pid,
                    leaseId,
                    createdAt: this.clock().toISOString(),
                    statePath: path.basename(this.statePath)
                });
                fileSystem.writeFileSync(descriptor, `${payload}\n`, 'utf8');
                if (typeof fileSystem.fsyncSync === 'function') fileSystem.fsyncSync(descriptor);
            } finally {
                fileSystem.closeSync(descriptor);
            }
            this.stateLeaseId = leaseId;
        };

        try {
            attemptAcquire();
            return;
        } catch (error) {
            if (error?.code !== 'EEXIST') throw error;
        }

        let existingLease = null;
        let lockAgeMs = Number.POSITIVE_INFINITY;
        try {
            const stat = fileSystem.statSync(this.stateLeasePath);
            lockAgeMs = Math.max(0, this.clock().getTime() - stat.mtimeMs);
        } catch (error) {
            if (error?.code === 'ENOENT') {
                attemptAcquire();
                return;
            }
            throw new Error(`Could not inspect existing state lease: ${error.message}`);
        }
        try {
            existingLease = JSON.parse(fileSystem.readFileSync(this.stateLeasePath, 'utf8'));
        } catch {}

        const ownerAlive = this.isProcessAlive(Number(existingLease?.pid));
        const ownerDescription = existingLease?.pid
            ? `PID ${existingLease.pid}${ownerAlive ? ' (running)' : ' (not running)'}`
            : `an unreadable owner (${Math.round(lockAgeMs / 1000)}s old)`;
        throw new Error(
            `State lease is held by ${ownerDescription}. ` +
            'Refusing automatic recovery to prevent a two-process race; remove the lock manually only after verifying no bot is running.'
        );
    }

    releaseStateLease() {
        if (this.disableStateLock || !this.stateLeaseId) return;
        try {
            const existingLease = JSON.parse(this.fileSystem.readFileSync(this.stateLeasePath, 'utf8'));
            if (existingLease.leaseId === this.stateLeaseId) {
                this.fileSystem.unlinkSync(this.stateLeasePath);
            }
        } catch (error) {
            if (error?.code !== 'ENOENT') {
                this.log(`Could not release state lease: ${error.message}`);
            }
        } finally {
            this.stateLeaseId = null;
        }
    }

    async preflightConfiguredChannels() {
        const failures = [];
        const configuredGuildIds = new Set();
        const requiredPermissions = [
            ['ViewChannel', Discord.PermissionFlagsBits.ViewChannel],
            ['SendMessages', Discord.PermissionFlagsBits.SendMessages],
            ['EmbedLinks', Discord.PermissionFlagsBits.EmbedLinks],
            ['AttachFiles', Discord.PermissionFlagsBits.AttachFiles],
            ['ReadMessageHistory', Discord.PermissionFlagsBits.ReadMessageHistory]
        ];

        for (const channelId of this.channelIds) {
            try {
                const channel = await this.client.channels.fetch(channelId);
                const sendable = channel &&
                    (typeof channel.isSendable === 'function'
                        ? channel.isSendable()
                        : typeof channel.send === 'function');
                if (!sendable) {
                    throw new Error('channel is not sendable');
                }
                if (channel.guildId) configuredGuildIds.add(channel.guildId);

                if (typeof channel.permissionsFor === 'function' && this.client.user) {
                    const permissions = channel.permissionsFor(this.client.user);
                    const missing = requiredPermissions
                        .filter(([, flag]) => !permissions?.has(flag))
                        .map(([name]) => name);
                    if (typeof channel.isThread === 'function' && channel.isThread() &&
                        !permissions?.has(Discord.PermissionFlagsBits.SendMessagesInThreads)) {
                        missing.push('SendMessagesInThreads');
                    }
                    if (missing.length > 0) {
                        throw new Error(`missing permissions: ${missing.join(', ')}`);
                    }
                }
            } catch (error) {
                failures.push(`${channelId}: ${error.message}`);
            }
        }

        if (failures.length > 0) {
            throw new Error(`Discord channel preflight failed (${failures.join('; ')})`);
        }
        if (this.allowedGuildIds.size === 0) {
            this.allowedGuildIds = configuredGuildIds;
            this.log(`Command guild allowlist derived from configured alert channels (${this.allowedGuildIds.size} guild(s))`);
        }
        this.guildAllowlistReady = this.allowedGuildIds.size > 0;
        if (!this.guildAllowlistReady) {
            throw new Error('No guild allowlist could be derived from the configured alert channels');
        }
    }

    async ensureActiveSeason() {
        const activeSeason = this.clock().getUTCFullYear();
        if (activeSeason === this.currentSeason) return false;
        if (activeSeason < this.currentSeason) {
            throw new Error(
                `System clock moved from season ${this.currentSeason} back to ` +
                `${activeSeason}; refusing to overwrite newer state`
            );
        }

        this.log(`Season rollover detected: ${this.currentSeason} -> ${activeSeason}`);
        for (const record of this.activeEnrichmentRecords.values()) {
            record.cancelledReason = 'season-rollover';
        }
        if (this.activeEnrichmentJobs.size > 0) {
            await Promise.allSettled(this.activeEnrichmentJobs.values());
            if (this.shuttingDown) return false;
        }
        this.currentSeason = activeSeason;
        this.startupCatchUpPlayerIds = new Set(Object.keys(this.players));
        this.pendingEnrichments.clear();
        this.enrichmentQueue.length = 0;
        if (this.enrichmentWakeTimer) {
            clearTimeout(this.enrichmentWakeTimer);
            this.enrichmentWakeTimer = null;
        }
        this.gameLogCache.clear();
        this.playByPlayCache.clear();
        this.gameMetadataCache.clear();
        this.statcastCache.clear();
        this.displayStatsPromises.clear();
        this.backfillLastStartedAt.clear();
        this.backfillPromises.clear();
        for (const playerData of Object.values(this.players)) {
            playerData.lastCheckedHR = 0;
            playerData.checkpointInitialized = true;
            playerData.lowerTotalObservation = null;
            playerData.inventoryCorrectionCandidate = null;
            playerData.baselineHomeRunIds = new Set();
            playerData.baselineSnapshotInitialized = true;
            playerData.authoritativeHomeRunIds = new Set();
            playerData.authoritativeSnapshotInitialized = true;
            playerData.authoritativeSnapshotCapturedAt =
                this.clock().toISOString();
            playerData.sentHomeRuns = new Set();
            playerData.sentHomeRunsByChannel = {};
            playerData.alertMessagesByChannel = {};
            playerData.eventAliases = {};
            playerData.homeRunEvents = {};
            playerData.homeRunParks = {};
            playerData.lastKnownStats = null;
            playerData.lastStatsFetchAttemptAt = null;
            this.ensurePlayerDeliveryState(playerData);
        }
        this.saveState({ throwOnError: true });
        return true;
    }

    getRetryDelayMs(error, attempt) {
        const retryAfter = error?.retryAfter;
        if (typeof retryAfter === 'string' && retryAfter.trim()) {
            const seconds = Number(retryAfter);
            if (Number.isFinite(seconds) && seconds >= 0) {
                return Math.min(60000, Math.ceil(seconds * 1000));
            }
            const dateDelay = Date.parse(retryAfter) - this.clock().getTime();
            if (Number.isFinite(dateDelay) && dateDelay > 0) {
                return Math.min(60000, dateDelay);
            }
        }
        const baseDelay = Math.min(10000, 250 * (2 ** attempt));
        return baseDelay + Math.floor(this.random() * Math.max(1, baseDelay * 0.25));
    }

    isRetryableHttpError(error) {
        if (error?.name === 'AbortError' || error?.code === 'ETIMEDOUT') return true;
        if (!Number.isInteger(error?.status)) return true;
        return [408, 425, 429, 500, 502, 503, 504].includes(error.status);
    }

    async httpGet(url, options = {}) {
        const {
            responseType = 'json',
            timeoutMs = this.httpTimeoutMs,
            retries = this.httpRetries,
            maxBytes = responseType === 'text' ? 25 * 1024 * 1024 : 5 * 1024 * 1024,
            expectedContentTypes = responseType === 'json'
                ? ['application/json']
                : ['text/csv', 'text/plain', 'application/octet-stream']
        } = options;

        let lastError;
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                if (this.httpClient) {
                    const response = typeof this.httpClient.get === 'function'
                        ? await this.httpClient.get(url, { timeout: timeoutMs, responseType })
                        : await this.httpClient(url, { method: 'GET', timeoutMs, responseType, maxBytes });
                    if (!response || !Object.prototype.hasOwnProperty.call(response, 'data')) {
                        throw new Error(`Injected HTTP client returned a malformed response for ${url}`);
                    }
                    return response;
                }

                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), timeoutMs);
                let response;
                try {
                    response = await this.fetchImpl(url, {
                        method: 'GET',
                        headers: { accept: responseType === 'json' ? 'application/json' : 'text/csv,text/plain;q=0.9' },
                        signal: controller.signal,
                        redirect: 'follow'
                    });
                    const contentLength = Number(response.headers.get('content-length'));
                    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
                        const error = new Error(`HTTP response exceeded ${maxBytes} bytes`);
                        error.status = response.status;
                        throw error;
                    }

                    if (!response.ok) {
                        const error = new Error(`HTTP ${response.status} ${response.statusText}`.trim());
                        error.status = response.status;
                        error.retryAfter = response.headers.get('retry-after');
                        throw error;
                    }

                    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
                    if (expectedContentTypes.length > 0 &&
                        !expectedContentTypes.some(expected => contentType.includes(expected))) {
                        throw new Error(`Unexpected content type "${contentType || 'missing'}" from ${new URL(url).host}`);
                    }

                    const chunks = [];
                    let bytesRead = 0;
                    if (response.body) {
                        for await (const chunk of response.body) {
                            const buffer = Buffer.from(chunk);
                            bytesRead += buffer.byteLength;
                            if (bytesRead > maxBytes) {
                                controller.abort();
                                throw new Error(`HTTP response exceeded ${maxBytes} bytes`);
                            }
                            chunks.push(buffer);
                        }
                    }
                    const body = Buffer.concat(chunks, bytesRead);
                    const text = body.toString('utf8');
                    let data = text;
                    if (responseType === 'json') {
                        try {
                            data = JSON.parse(text);
                        } catch {
                            throw new Error(`Malformed JSON from ${new URL(url).host}`);
                        }
                    }
                    return { data, status: response.status, headers: response.headers };
                } finally {
                    clearTimeout(timeout);
                }
            } catch (error) {
                lastError = error;
                if (attempt >= retries || !this.isRetryableHttpError(error) || this.shuttingDown) {
                    break;
                }
                const delay = this.getRetryDelayMs(error, attempt);
                this.log(`HTTP attempt ${attempt + 1} failed (${error.message}); retrying in ${delay}ms`);
                await this.sleep(delay);
            }
        }
        throw lastError;
    }

    getStatsSplits(response, label) {
        const stats = response?.data?.stats;
        if (!Array.isArray(stats) || !stats[0] || !Array.isArray(stats[0].splits)) {
            throw new Error(`${label} response did not contain stats splits`);
        }
        return stats[0].splits;
    }

    getAllPlays(response, label) {
        const plays = response?.data?.allPlays ?? response?.data?.liveData?.plays?.allPlays;
        if (!Array.isArray(plays)) {
            throw new Error(`${label} response did not contain an allPlays array`);
        }
        return plays;
    }

    async getStableHomeRunInventory(playerId, expectedTotal) {
        const details = expectedTotal > 0
            ? await this.getRecentHomeRunDetails(
                playerId,
                expectedTotal,
                { force: true }
            )
            : [];
        const confirmedTotal = await this.getPlayerHomeRunTotal(playerId);
        if (confirmedTotal !== expectedTotal) {
            this.logEvent('warn', 'baseline_snapshot_changed', {
                playerId: String(playerId),
                expectedTotal,
                confirmedTotal
            });
            return null;
        }
        return details;
    }

    async initializeTrackingBaselines(restoredPlayers) {
        await Promise.all(Object.entries(this.players).map(
            async ([playerId, playerData]) => {
                if (this.shuttingDown) return;
                if (restoredPlayers.has(playerId) && playerData.checkpointInitialized) {
                    this.log(`Restored ${playerData.name}: ${playerData.lastCheckedHR} HRs`);
                    return;
                }

                const currentHR = await this.getPlayerHomeRunTotal(playerId);
                if (this.shuttingDown) return;
                if (currentHR === null) {
                    this.log(`Could not establish a baseline for ${playerData.name}; alerts remain gated until a valid total is available`);
                    return;
                }
                const details = await this.getStableHomeRunInventory(
                    playerId,
                    currentHR
                );
                if (this.shuttingDown) return;
                if (!details) {
                    this.log(
                        `Could not establish a stable baseline for ${playerData.name}; alerts remain gated`
                    );
                    return;
                }
                const baselineCaptured = this.captureBaselineInventory(
                    playerId,
                    playerData,
                    details,
                    currentHR
                );
                if (baselineCaptured) {
                    this.captureAuthoritativeInventory(
                        playerId,
                        playerData,
                        details,
                        currentHR
                    );
                    playerData.lastCheckedHR = currentHR;
                    playerData.checkpointInitialized = true;
                } else {
                    this.logEvent('warn', 'baseline_identity_snapshot_deferred', {
                        playerId,
                        player: playerData.name,
                        homeRuns: currentHR
                    });
                }
                this.log(`Initialized ${playerData.name}: ${currentHR} HRs`);
            }
        ));
        if (this.shuttingDown) return;
        this.saveState({ throwOnError: true });
    }

    async handleClientReady() {
        if (this.shuttingDown) {
            this.logEvent('info', 'late_ready_ignored_during_shutdown', {});
            return;
        }
        this.log(`Bot logged in as ${this.client.user.tag}`);
        await this.preflightConfiguredChannels();
        if (this.shuttingDown) return;
        const restoredPlayers = new Set(this.startupCatchUpPlayerIds);
        await this.initializeTrackingBaselines(restoredPlayers);
        if (this.shuttingDown) return;
        await this.preflightPython().catch(error => {
            this.analysisAvailable = false;
            this.analysisPermanentlyUnavailable = true;
            this.analysisUnavailableReason = error.message;
            this.log(`Python analysis disabled: ${error.message}`);
        });
        if (this.shuttingDown) return;
        let withdrawalJob;
        withdrawalJob = this.withdrawStaleParkAnalysisDeliveries()
            .catch(error => {
                this.logEvent('error', 'park_analysis_withdrawal_job_failed', {
                    error: error.message
                });
            })
            .finally(() => {
                this.backgroundJobs.delete(withdrawalJob);
            });
        this.backgroundJobs.add(withdrawalJob);
        this.initializationComplete = true;
        this.startMonitoring();
        this.resumePendingEnrichments();
        let profileJob;
        profileJob = this.syncBotProfile().finally(() => {
            this.backgroundJobs.delete(profileJob);
        });
        this.backgroundJobs.add(profileJob);
    }

    async initialize() {
        this.log('Initializing bot...');
        this.log(`Configured to send alerts to ${this.channelIds.length} channel(s): ${this.channelIds.join(', ')}`);

        this.acquireStateLease();
        let restoredPlayers;
        try {
            restoredPlayers = this.loadState();
        } catch (error) {
            this.releaseStateLease();
            throw error;
        }
        this.startupCatchUpPlayerIds = new Set(restoredPlayers);

        let resolveReady;
        let rejectReady;
        let resolveGatewayReady;
        let rejectGatewayReady;
        this.gatewayReadyPromise = new Promise((resolve, reject) => {
            resolveGatewayReady = resolve;
            rejectGatewayReady = reject;
        });
        this.gatewayReadyPromise.catch(() => {});
        this.readyPromise = new Promise((resolve, reject) => {
            resolveReady = resolve;
            rejectReady = reject;
        });
        // The CLI start path awaits this promise. Attaching a rejection handler here also
        // prevents direct initialize() callers from creating an unobserved rejection.
        this.readyPromise.catch(() => {});
        this.client.once(Discord.Events.ClientReady, () => {
            if (this.shuttingDown) {
                this.logEvent('info', 'late_ready_ignored_during_shutdown', {});
                return;
            }
            resolveGatewayReady();
            void this.handleClientReady().then(resolveReady).catch(async error => {
                this.logEvent('fatal', 'ready_initialization_failed', { error: error.message });
                this.processRef.exitCode = 1;
                await this.shutdown('ready-initialization-error');
                rejectReady(error);
            });
        });

        this.client.on(Discord.Events.Error, (error) => {
            this.logEvent('error', 'discord_client_error', {
                error: error.message,
                code: error.code || null
            });
        });

        this.client.on(Discord.Events.MessageCreate, (message) => {
            let commandJob;
            commandJob = this.handleIncomingMessage(message)
                .catch(async error => {
                    this.log(
                        `Command error in guild ${message.guildId || 'DM'}, ` +
                        `channel ${message.channelId || 'unknown'}: ${error.message}`
                    );
                    if (this.shuttingDown ||
                        typeof message.reply !== 'function') {
                        return;
                    }
                    try {
                        await message.reply(
                            'That command could not be completed. The failure was logged; please try again later.'
                        );
                    } catch (replyError) {
                        this.logEvent(
                            'warn',
                            'command_failure_reply_failed',
                            {
                                guildId: message.guildId || null,
                                channelId: message.channelId || null,
                                error: replyError.message
                            }
                        );
                    }
                })
                .finally(() => {
                    this.backgroundJobs.delete(commandJob);
                });
            this.backgroundJobs.add(commandJob);
        });

        try {
            await this.client.login(this.token);
        } catch (error) {
            rejectGatewayReady(error);
            rejectReady(error);
            await this.shutdown('discord-login-failed');
            throw error;
        }
        return this;
    }

    async handleIncomingMessage(message) {
        if (this.shuttingDown || message.author?.bot) return;
        if (!this.isGuildAllowed(message)) return;
        if (!String(message.content || '').trim().startsWith('!')) return;
        if (!this.initializationComplete) {
            await message.reply(
                'The bot is still starting and rebuilding its tracking state. Please try that command again shortly.'
            );
            return;
        }
        await this.handleCommand(message);
    }

    async getPlayerStats(playerId) {
        const requestedSeason = this.currentSeason;
        const normalizedPlayerId = String(playerId);
        const playerData = this.players[normalizedPlayerId];
        const requestSequence =
            (this.statsRequestSequences.get(normalizedPlayerId) || 0) + 1;
        this.statsRequestSequences.set(
            normalizedPlayerId,
            requestSequence
        );
        if (playerData) {
            playerData.lastStatsFetchAttemptAt = this.clock().getTime();
        }
        try {
            const response = await this.httpGet(
                `https://statsapi.mlb.com/api/v1/people/${playerId}/stats?stats=season&season=${requestedSeason}&group=hitting&gameType=R`
            );
            if (requestedSeason !== this.currentSeason) return null;
            const splits = this.getStatsSplits(response, `season stats for ${playerId}`);
            const stat = splits[0]?.stat;
            if (!stat || typeof stat !== 'object') return null;
            if (playerData &&
                this.statsRequestSequences.get(normalizedPlayerId) ===
                    requestSequence) {
                playerData.lastKnownStats = {
                    stats: { ...stat },
                    fetchedAt: this.clock().toISOString()
                };
            }
            return playerData?.lastKnownStats?.stats || stat;
        } catch (error) {
            this.log(`Error fetching stats for player ${playerId}: ${error.message}`);
            return null;
        }
    }

    async getPlayerStatsForDisplay(playerId) {
        const playerData = this.players[String(playerId)];
        const now = this.clock().getTime();
        const cached = playerData?.lastKnownStats;
        const cachedAt = Date.parse(cached?.fetchedAt);
        if (cached?.stats && Number.isFinite(cachedAt) &&
            now - cachedAt <= this.displayStatsCacheTtlMs) {
            return {
                stats: cached.stats,
                stale: false,
                fetchedAt: cached.fetchedAt
            };
        }
        if (Number.isFinite(playerData?.lastStatsFetchAttemptAt) &&
            now - playerData.lastStatsFetchAttemptAt <= this.displayStatsCacheTtlMs) {
            return {
                stats: cached?.stats || null,
                stale: true,
                fetchedAt: cached?.fetchedAt || null
            };
        }
        let fetchPromise = this.displayStatsPromises.get(String(playerId));
        if (!fetchPromise) {
            fetchPromise = this.getPlayerStats(playerId);
            this.displayStatsPromises.set(String(playerId), fetchPromise);
            fetchPromise.finally(() => {
                if (this.displayStatsPromises.get(String(playerId)) === fetchPromise) {
                    this.displayStatsPromises.delete(String(playerId));
                }
            });
        }
        const liveStats = await fetchPromise;
        if (liveStats) {
            return {
                stats: liveStats,
                stale: false,
                fetchedAt: playerData?.lastKnownStats?.fetchedAt || null
            };
        }
        const latestCached = playerData?.lastKnownStats;
        if (latestCached?.stats &&
            typeof latestCached.stats === 'object') {
            return {
                stats: latestCached.stats,
                stale: true,
                fetchedAt: latestCached.fetchedAt || null
            };
        }
        return { stats: null, stale: true, fetchedAt: null };
    }

    formatSnapshotAge(fetchedAt) {
        const timestamp = Date.parse(fetchedAt);
        if (!Number.isFinite(timestamp)) return 'from an unknown time';
        const ageMs = Math.max(0, this.clock().getTime() - timestamp);
        if (ageMs < 60 * 1000) return 'less than a minute old';
        if (ageMs < 60 * 60 * 1000) return `${Math.floor(ageMs / 60000)}m old`;
        if (ageMs < 24 * 60 * 60 * 1000) return `${Math.floor(ageMs / 3600000)}h old`;
        return `${Math.floor(ageMs / 86400000)}d old`;
    }

    formatStatValue(value, fallback = 'N/A') {
        return value === null || value === undefined || value === '' ? fallback : String(value);
    }

    async getPlayerHomeRuns(playerId) {
        return this.getPlayerHomeRunTotal(playerId);
    }

    async getPlayerHomeRunTotal(playerId) {
        const stats = await this.getPlayerStats(playerId);
        if (!stats || stats.homeRuns === null || stats.homeRuns === undefined) {
            return null;
        }
        const total = Number.parseInt(stats.homeRuns, 10);
        return Number.isInteger(total) && total >= 0 ? total : null;
    }

    async getPlayerGameLog(playerId, { force = false } = {}) {
        const cacheKey = `${this.currentSeason}:${playerId}`;
        const cached = this.gameLogCache.get(cacheKey);
        if (!force && cached && cached.expiresAt > this.clock().getTime()) {
            return cached.promise;
        }
        const promise = this.httpGet(
            `https://statsapi.mlb.com/api/v1/people/${playerId}/stats?stats=gameLog&season=${this.currentSeason}&group=hitting&gameType=R`
        ).then(response => this.getStatsSplits(response, `game log for ${playerId}`));
        this.gameLogCache.set(cacheKey, {
            expiresAt: this.clock().getTime() + this.gameLogCacheTtlMs,
            promise
        });
        try {
            return await promise;
        } catch (error) {
            if (this.gameLogCache.get(cacheKey)?.promise === promise) {
                this.gameLogCache.delete(cacheKey);
            }
            throw error;
        }
    }

    async getGamePlays(gameId, { force = false } = {}) {
        const cacheKey = String(gameId);
        const cached = this.playByPlayCache.get(cacheKey);
        if (!force && cached && cached.expiresAt > this.clock().getTime()) {
            return cached.promise;
        }
        const promise = this.httpGet(
            `https://statsapi.mlb.com/api/v1/game/${gameId}/playByPlay`
        ).then(response => this.getAllPlays(response, `play-by-play for game ${gameId}`));
        this.playByPlayCache.set(cacheKey, {
            expiresAt: this.clock().getTime() + this.playByPlayCacheTtlMs,
            promise
        });
        try {
            return await promise;
        } catch (error) {
            if (this.playByPlayCache.get(cacheKey)?.promise === promise) {
                this.playByPlayCache.delete(cacheKey);
            }
            throw error;
        }
    }

    createPendingHomeRunDetail(playerId, gameId, gameDate, gameHomeRunIndex) {
        const detail = this.createHomeRunDetail({
            playerId: String(playerId),
            season: this.currentSeason,
            distance: 'Not yet available',
            rbi: null,
            rbiDescription: 'HR (details pending)',
            detailStatus: 'pending',
            gameId,
            gameDate,
            gameHomeRunIndex
        });
        detail.eventKey = this.buildHomeRunId(detail, playerId);
        return detail;
    }

    async getRecentHomeRunDetails(
        playerId,
        requestedHomeRunCount = 1,
        { force = false } = {}
    ) {
        const targetCount = Math.max(0, Number.parseInt(requestedHomeRunCount, 10) || 0);
        if (targetCount === 0) return [];
        const playerData = this.players[String(playerId)];

        try {
            const splits = await this.getPlayerGameLog(playerId, { force });
            const hrGames = splits
                .filter(game => {
                    const count = Number.parseInt(game?.stat?.homeRuns, 10);
                    return Number.isInteger(count) && count > 0 && game?.game?.gamePk;
                })
                .sort((left, right) =>
                    safeDateTimestamp(right.date) - safeDateTimestamp(left.date) ||
                    Number(right.game.gamePk) - Number(left.game.gamePk)
                );

            const detailsList = [];
            let accountedFor = 0;
            for (const game of hrGames) {
                if (accountedFor >= targetCount) break;
                const gameId = String(game.game.gamePk);
                const gameDateTime = game.game?.gameDate || game.date;
                const gameNumber = Number.parseInt(
                    game.game?.gameNumber ?? game.game?.doubleHeader ?? game.gameNumber,
                    10
                );
                const gameHomeRunCount = Number.parseInt(game.stat.homeRuns, 10);
                const expectedCount = Math.min(
                    gameHomeRunCount,
                    targetCount - accountedFor
                );
                const firstSelectedSlot = gameHomeRunCount - expectedCount + 1;
                const selectedSlots = Array.from(
                    { length: expectedCount },
                    (_, index) => firstSelectedSlot + index
                );
                let matchingPlays = [];
                const cachedGameEvents = (force
                    ? []
                    : Object.values(playerData?.homeRunEvents || {}))
                    .filter(detail =>
                        String(detail?.gameId) === gameId &&
                        detail?.detailStatus === 'confirmed' &&
                        Number.isInteger(detail?.gameHomeRunIndex)
                    )
                    .sort((left, right) => left.gameHomeRunIndex - right.gameHomeRunIndex);
                const cachedBySlot = new Map(
                    cachedGameEvents.map(detail => [detail.gameHomeRunIndex, detail])
                );
                const cacheCoversSelection = selectedSlots.every(slot => cachedBySlot.has(slot));
                if (!cacheCoversSelection) {
                    try {
                        const plays = await this.getGamePlays(gameId, { force });
                        matchingPlays = plays
                            .filter(play => this.isHomeRunByPlayer(play, playerId))
                            .sort((left, right) =>
                                (Number.isInteger(left.about?.atBatIndex) ? left.about.atBatIndex : Number.MAX_SAFE_INTEGER) -
                                (Number.isInteger(right.about?.atBatIndex) ? right.about.atBatIndex : Number.MAX_SAFE_INTEGER)
                            );
                        if (matchingPlays.length !== gameHomeRunCount) {
                            this.logEvent('warn', 'partial_play_by_play_home_run_set', {
                                playerId,
                                gameId,
                                expected: gameHomeRunCount,
                                received: matchingPlays.length
                            });
                            matchingPlays = [];
                        }
                    } catch (error) {
                        this.log(`Could not retrieve plays for game ${gameId}, player ${playerId}: ${error.message}`);
                    }
                }

                for (const slot of selectedSlots) {
                    const cachedDetail = cachedBySlot.get(slot) || null;
                    if (cachedDetail) {
                        detailsList.push({ ...cachedDetail });
                        continue;
                    }
                    const play = matchingPlays[slot - 1];
                    if (!play) {
                        detailsList.push(this.createPendingHomeRunDetail(playerId, gameId, gameDateTime, slot));
                        continue;
                    }
                    const rbiInfo = this.extractRBIInfo(play);
                    const detail = this.createHomeRunDetail({
                        playerId: String(playerId),
                        season: this.currentSeason,
                        distance: this.extractDistanceFromPlay(play),
                        rbi: rbiInfo.rbi,
                        rbiDescription: rbiInfo.rbiDescription,
                        gameId,
                        gameDate: gameDateTime,
                        gameNumber: Number.isInteger(gameNumber) ? gameNumber : null,
                        ...this.buildPlayIdentifiers(play, gameId, gameDateTime, slot, playerId)
                    });
                    detailsList.push(detail);
                }
                accountedFor += expectedCount;
            }

            const pendingIndexes = detailsList
                .map((detail, index) => ({ detail, index }))
                .filter(({ detail }) =>
                    detail.distance === 'Not yet available' || detail.rbi === null
                );
            for (const { detail, index } of pendingIndexes) {
                const statcastDetails = await this.getHomeRunDetailsFromStatcast(
                    playerId,
                    detail.gameId,
                    detail.gameHomeRunIndex
                );
                if (statcastDetails) {
                    detailsList[index] = { ...detail, ...statcastDetails };
                }
            }

            if (detailsList.length < targetCount) {
                return this.createFallbackHomeRunDetails(targetCount, playerId);
            }
            return this.sortHomeRunDetailsChronologically(detailsList);
        } catch (error) {
            this.log(`Error fetching home run details for player ${playerId}: ${error.message}`);
            return this.createFallbackHomeRunDetails(targetCount, playerId);
        }
    }

    isHomeRunByPlayer(play, playerId) {
        const batterId = play.matchup?.batter?.id || play.result?.batter?.id;
        if (batterId?.toString() !== playerId) {
            return false;
        }

        const eventType = String(play.result?.eventType || '').trim().toLowerCase();
        const event = String(play.result?.event || '').trim().toLowerCase();
        const resultType = String(play.result?.type || '').trim().toLowerCase();
        if (eventType) return eventType === 'home_run';
        if (event) return event === 'home run';
        return resultType === 'home_run';
    }

    extractDistanceFromPlay(play) {
        const formatDistance = value => {
            if (value === null || value === undefined || value === '') return null;
            const numeric = Number(value);
            return Number.isFinite(numeric) && numeric >= 100 && numeric <= 600
                ? `${Math.round(numeric)} ft`
                : null;
        };

        if (play.playEvents && Array.isArray(play.playEvents)) {
            for (const event of play.playEvents) {
                const distance = formatDistance(event?.hitData?.totalDistance);
                if (distance) return distance;
            }
        }

        if (play.hitData) {
            const distance =
                formatDistance(play.hitData.totalDistance) ||
                formatDistance(play.hitData.launchDistance);
            if (distance) return distance;
        }

        if (play.result?.description) {
            const patterns = [
                /(\d{3,4})\s*(?:feet|foot|ft)/i,
                /\((\d{3,4})\s*ft\)/i,
                /(\d{3,4})-foot/i,
                /traveled\s*(\d{3,4})/i
            ];

            for (const pattern of patterns) {
                const match = play.result.description.match(pattern);
                const distance = formatDistance(match?.[1]);
                if (distance) return distance;
            }
        }

        return 'Distance not available';
    }

    extractRBIInfo(play) {
        let rbi = Number.parseInt(play?.result?.rbi, 10);
        if (!Number.isInteger(rbi) || rbi < 1 || rbi > 4) {
            rbi = null;
        }

        if (rbi === null && Array.isArray(play?.runners)) {
            const scoringRunnerIds = new Set(
                play.runners
                    .filter(runner => runner?.movement?.end === 'score')
                    .map(runner => String(runner?.details?.runner?.id || runner?.details?.runner?.fullName || ''))
                    .filter(Boolean)
            );
            if (scoringRunnerIds.size >= 1 && scoringRunnerIds.size <= 4) {
                rbi = scoringRunnerIds.size;
            }
        }

        if (rbi === null && play?.result?.description) {
            const desc = play.result.description.toLowerCase();
            if (desc.includes('grand slam')) {
                rbi = 4;
            } else if (/\b(?:3|three)[ -]run\b/.test(desc)) {
                rbi = 3;
            } else if (/\b(?:2|two)[ -]run\b/.test(desc)) {
                rbi = 2;
            } else if (/\bsolo\b/.test(desc)) {
                rbi = 1;
            } else {
                const scored = desc.match(/\b(?:scores|score)\b/gi)?.length;
                rbi = Number.isInteger(scored)
                    ? Math.min(4, 1 + scored)
                    : 1;
            }
        }

        return { rbi, rbiDescription: this.getRbiDescription(rbi) };
    }

    getRbiDescription(rbi) {
        const parsedRbi = Number.parseInt(rbi, 10);
        if (parsedRbi === 1) return 'Solo HR';
        if (parsedRbi === 2) return '2-run HR';
        if (parsedRbi === 3) return '3-run HR';
        if (parsedRbi === 4) return 'Grand Slam!';
        return 'HR (RBI pending)';
    }

    buildSavantHomeRunUrl(playerId, gameId = null) {
        let url = `https://baseballsavant.mlb.com/statcast_search/csv?all=true&hfAB=home%5C.run%7C&hfGT=R%7C&hfSea=${this.currentSeason}%7C&player_type=batter&type=details&batters_lookup%5B%5D=${encodeURIComponent(playerId)}`;
        if (gameId) {
            url += `&game_pk=${encodeURIComponent(gameId)}`;
        }
        return url;
    }

    async getSavantHomeRunRows(playerId, gameId = null) {
        const cacheKey = `savant-csv:${this.currentSeason}:${playerId}:${gameId || 'season'}`;
        const cached = this.statcastCache.get(cacheKey);
        if (cached && cached.expiresAt > this.clock().getTime()) {
            return cached.promise;
        }
        const promise = this.httpGet(
            this.buildSavantHomeRunUrl(playerId, gameId),
            { responseType: 'text' }
        ).then(response => {
            const rows = parse(response.data, {
                columns: true,
                skip_empty_lines: true
            });
            if (!Array.isArray(rows)) {
                throw new Error('Savant CSV did not parse to rows');
            }
            return rows
                .filter(row =>
                    row?.events === 'home_run' &&
                    String(row.batter) === String(playerId) &&
                    (!gameId || String(row.game_pk) === String(gameId))
                )
                .sort((left, right) =>
                    safeDateTimestamp(left.game_date) - safeDateTimestamp(right.game_date) ||
                    (Number.parseInt(left.at_bat_number, 10) || Number.MAX_SAFE_INTEGER) -
                        (Number.parseInt(right.at_bat_number, 10) || Number.MAX_SAFE_INTEGER)
                );
        });
        this.statcastCache.set(cacheKey, {
            expiresAt: this.clock().getTime() + this.statcastCacheTtlMs,
            promise
        });
        try {
            return await promise;
        } catch (error) {
            if (this.statcastCache.get(cacheKey)?.promise === promise) {
                this.statcastCache.delete(cacheKey);
            }
            throw error;
        }
    }

    selectSavantHomeRunRow(rows, hrDetail = {}) {
        if (!Array.isArray(rows) || rows.length === 0) return null;
        if (Number.isInteger(hrDetail.atBatIndex)) {
            const expectedAtBatNumber = hrDetail.atBatIndex + 1;
            return rows.find(
                row => Number.parseInt(row.at_bat_number, 10) === expectedAtBatNumber
            ) || null;
        }
        const ordinal = Number.parseInt(hrDetail.gameHomeRunIndex, 10);
        return Number.isInteger(ordinal) && ordinal >= 1 ? rows[ordinal - 1] || null : null;
    }

    extractSavantRbi(row) {
        const preScore = Number(row?.bat_score);
        const postScore = Number(row?.post_bat_score);
        const scoreDelta = postScore - preScore;
        if (Number.isInteger(scoreDelta) && scoreDelta >= 1 && scoreDelta <= 4) {
            return scoreDelta;
        }
        const baseValues = [row?.on_1b, row?.on_2b, row?.on_3b];
        if (!baseValues.some(value => value !== undefined)) return null;
        const occupiedBases = baseValues.filter(value => {
            const normalized = String(value ?? '').trim().toLowerCase();
            return normalized && !['0', 'null', 'nan', 'none'].includes(normalized);
        }).length;
        return 1 + occupiedBases;
    }

    async getHomeRunDetailsFromStatcast(playerId, gameId = null, gameHomeRunIndex = 1) {
        const cacheKey = `${this.currentSeason}:${playerId}:${gameId || 'any'}:${gameHomeRunIndex}`;
        const cached = this.statcastCache.get(cacheKey);
        if (cached && cached.expiresAt > this.clock().getTime()) {
            return cached.promise;
        }
        const promise = this.fetchHomeRunDetailsFromStatcast(playerId, gameId, gameHomeRunIndex);
        this.statcastCache.set(cacheKey, {
            expiresAt: this.clock().getTime() + this.statcastCacheTtlMs,
            promise
        });
        return promise;
    }

    async fetchHomeRunDetailsFromStatcast(playerId, gameId = null, gameHomeRunIndex = 1) {
        try {
            const rows = await this.getSavantHomeRunRows(playerId, gameId);
            const row = this.selectSavantHomeRunRow(rows, { gameHomeRunIndex });
            if (row) {
                const parsedDistance = Number.parseFloat(row.hit_distance_sc ?? row.hit_distance);
                const distance = Number.isFinite(parsedDistance) &&
                    parsedDistance >= 100 &&
                    parsedDistance <= 600
                    ? `${Math.round(parsedDistance)} ft`
                    : 'Distance not available';
                const rbi = this.extractSavantRbi(row);
                return { distance, rbi, rbiDescription: this.getRbiDescription(rbi) };
            }
            return null;
        } catch (error) {
            this.log(`Error fetching Statcast data: ${error.message}`);
            return null;
        }
    }

    async checkForNewHomeRuns({ force = false } = {}) {
        if (this.checkInProgress) {
            this.logEvent('info', 'poll_reused', {});
            return this.checkInProgress;
        }

        this.checkInProgress = (async () => {
            await this.ensureActiveSeason();
            this.lastCheckTime = this.clock();
            this.metrics.checksStarted++;
            const result = {
                startedAt: this.lastCheckTime.toISOString(),
                force,
                playersChecked: 0,
                playersFailed: 0,
                detected: 0,
                alertsDelivered: 0,
                alertFailures: 0,
                enrichmentsQueued: 0
            };
            this.logEvent('info', 'poll_started', { force, season: this.currentSeason });

            for (const [playerId, playerData] of Object.entries(this.players)) {
                if (this.shuttingDown) break;
                const releasePlayerMutation = await this.acquireKeyedLock(
                    this.playerMutationLocks,
                    playerId
                );
                try {
                    this.ensurePlayerDeliveryState(playerData);
                    const startupCatchUpActive = this.startupCatchUpPlayerIds.has(playerId);
                    const currentHomeRuns = await this.getPlayerHomeRunTotal(playerId);
                    if (currentHomeRuns === null) {
                        result.playersFailed++;
                        this.logEvent('warn', 'player_total_unavailable', {
                            playerId,
                            player: playerData.name,
                            checkpoint: playerData.lastCheckedHR
                        });
                        continue;
                    }
                    result.playersChecked++;

                    if (!playerData.checkpointInitialized) {
                        const baselineDetails =
                            await this.getStableHomeRunInventory(
                                playerId,
                                currentHomeRuns
                            );
                        if (!baselineDetails ||
                            !this.captureBaselineInventory(
                            playerId,
                            playerData,
                            baselineDetails,
                            currentHomeRuns
                        )) {
                            this.logEvent('warn', 'player_baseline_deferred', {
                                playerId,
                                player: playerData.name,
                                homeRuns: currentHomeRuns
                            });
                            continue;
                        }
                        this.captureAuthoritativeInventory(
                            playerId,
                            playerData,
                            baselineDetails,
                            currentHomeRuns
                        );
                        playerData.lastCheckedHR = currentHomeRuns;
                        playerData.checkpointInitialized = true;
                        playerData.lowerTotalObservation = null;
                        this.saveState({ throwOnError: true });
                        this.logEvent('info', 'player_baseline_established', {
                            playerId,
                            player: playerData.name,
                            homeRuns: currentHomeRuns
                        });
                        continue;
                    }

                    const previousCheckpoint = Math.max(0, Number.parseInt(playerData.lastCheckedHR, 10) || 0);
                    if (currentHomeRuns < previousCheckpoint) {
                        const previousObservation = playerData.lowerTotalObservation;
                        const observation = previousObservation?.value === currentHomeRuns
                            ? { value: currentHomeRuns, count: previousObservation.count + 1 }
                            : { value: currentHomeRuns, count: 1 };
                        playerData.lowerTotalObservation = observation;
                        if (observation.count >= 2) {
                            const correctionReconciled =
                                await this.reconcileDownwardCorrection(
                                playerId,
                                playerData,
                                currentHomeRuns
                            );
                            if (!correctionReconciled) {
                                this.logEvent('warn', 'official_total_correction_deferred', {
                                    playerId,
                                    player: playerData.name,
                                    previousCheckpoint,
                                    correctedTotal: currentHomeRuns
                                });
                                this.saveState({ throwOnError: true });
                                continue;
                            }
                            playerData.lastCheckedHR = currentHomeRuns;
                            playerData.lowerTotalObservation = null;
                            this.logEvent('warn', 'official_total_correction_applied', {
                                playerId,
                                player: playerData.name,
                                previousCheckpoint,
                                correctedTotal: currentHomeRuns
                            });
                        } else {
                            this.logEvent('warn', 'lower_total_waiting_for_confirmation', {
                                playerId,
                                player: playerData.name,
                                previousCheckpoint,
                                observedTotal: currentHomeRuns
                            });
                        }
                        this.saveState({ throwOnError: true });
                        continue;
                    }
                    playerData.lowerTotalObservation = null;

                    if (currentHomeRuns === previousCheckpoint &&
                        !playerData.baselineSnapshotInitialized) {
                        const baselineDetails =
                            await this.getStableHomeRunInventory(
                                playerId,
                                currentHomeRuns
                            );
                        if (baselineDetails && this.captureBaselineInventory(
                            playerId,
                            playerData,
                            baselineDetails,
                            currentHomeRuns
                        )) {
                            this.captureAuthoritativeInventory(
                                playerId,
                                playerData,
                                baselineDetails,
                                currentHomeRuns
                            );
                            this.saveState({ throwOnError: true });
                            this.logEvent('info', 'baseline_identity_snapshot_captured', {
                                playerId,
                                homeRuns: currentHomeRuns
                            });
                        }
                    }

                    const authoritativeSnapshotAge = this.clock().getTime() -
                        Date.parse(playerData.authoritativeSnapshotCapturedAt);
                    const authoritativeDeliveryPending =
                        playerData.authoritativeSnapshotInitialized &&
                        [...playerData.authoritativeHomeRunIds].some(eventId =>
                            !playerData.baselineHomeRunIds.has(eventId) &&
                            this.getPendingChannelIdsForHomeRun(
                                playerData,
                                eventId
                            ).length > 0
                        );
                    const inventoryRefreshDue =
                        currentHomeRuns === previousCheckpoint &&
                        playerData.authoritativeSnapshotInitialized &&
                        (
                            force ||
                            authoritativeDeliveryPending ||
                            !Number.isFinite(authoritativeSnapshotAge) ||
                            authoritativeSnapshotAge >=
                                this.authoritativeReconciliationIntervalMs
                        );

                    if (currentHomeRuns > previousCheckpoint || inventoryRefreshDue) {
                        const allHomeRunDetails = this.sortHomeRunDetailsChronologically(
                            await this.getRecentHomeRunDetails(
                                playerId,
                                currentHomeRuns,
                                { force: true }
                            )
                        );
                        const confirmedSnapshotTotal = await this.getPlayerHomeRunTotal(playerId);
                        if (confirmedSnapshotTotal === null || confirmedSnapshotTotal !== currentHomeRuns) {
                            this.logEvent('warn', 'aggregate_detail_snapshot_changed', {
                                playerId,
                                originalTotal: currentHomeRuns,
                                confirmedTotal: confirmedSnapshotTotal
                            });
                            continue;
                        }
                        if (!playerData.baselineSnapshotInitialized &&
                            !this.captureBaselineInventory(
                                playerId,
                                playerData,
                                allHomeRunDetails,
                                previousCheckpoint
                            )) {
                            this.logEvent('warn', 'baseline_identity_snapshot_unavailable', {
                                playerId,
                                checkpoint: previousCheckpoint,
                                currentHomeRuns
                            });
                            continue;
                        }
                        const previousAuthoritativeIds = new Set(
                            playerData.authoritativeHomeRunIds
                        );
                        const hadAuthoritativeSnapshot =
                            playerData.authoritativeSnapshotInitialized;
                        const reconciledInventory =
                            await this.reconcileAuthoritativeInventory(
                                playerId,
                                playerData,
                                allHomeRunDetails,
                                currentHomeRuns,
                                {
                                    requireCorrectionConfirmation:
                                        true
                                }
                            );
                        if (!reconciledInventory) {
                            continue;
                        }
                        const reconciledIdSet =
                            new Set(reconciledInventory);
                        const identityCorrectionApplied =
                            hadAuthoritativeSnapshot &&
                            [...previousAuthoritativeIds].some(
                                eventId => !reconciledIdSet.has(eventId)
                            );

                        const unseenHomeRuns = [];
                        for (let index = 0; index < allHomeRunDetails.length; index++) {
                            const hrDetail = allHomeRunDetails[index];
                            const hrId = this.reconcileHomeRunAliases(playerId, playerData, hrDetail);
                            const totalHomeRuns = index + 1;
                            if (playerData.baselineHomeRunIds.has(hrId) ||
                                this.pendingNotifications.has(hrId)) {
                                continue;
                            }
                            const pendingChannelIds = this.getPendingChannelIdsForHomeRun(playerData, hrId);
                            if (pendingChannelIds.length > 0) {
                                unseenHomeRuns.push({ hrDetail, hrId, pendingChannelIds, totalHomeRuns });
                            }
                        }

                        let checkpointFloor = previousCheckpoint;

                        const dispatchable = unseenHomeRuns.filter(
                            ({ hrDetail }) => !this.isFallbackHomeRunDetail(hrDetail)
                        );
                        if (dispatchable.length > 0) {
                            result.detected += dispatchable.length;
                            this.metrics.detected += dispatchable.length;
                            this.logEvent('info', 'home_runs_detected', {
                                playerId,
                                player: playerData.name,
                                previousCheckpoint,
                                currentHomeRuns,
                                aggregateIncrease:
                                    currentHomeRuns - previousCheckpoint,
                                eventIdentities: dispatchable.map(({ hrId }) => hrId)
                            });
                        }
                        const missingContext = unseenHomeRuns.length - dispatchable.length;
                        if (missingContext > 0) {
                            this.logEvent('warn', 'home_runs_missing_game_context', {
                                playerId,
                                count: missingContext
                            });
                        }

                        for (const { hrDetail, hrId, pendingChannelIds, totalHomeRuns } of dispatchable) {
                            if (this.shuttingDown) break;
                            this.pendingNotifications.add(hrId);
                            try {
                                const pendingBefore = this.pendingEnrichments.size;
                                const delivery = await this.sendInitialAlert(
                                    playerId,
                                    playerData,
                                    totalHomeRuns,
                                    hrDetail,
                                    hrId,
                                    pendingChannelIds
                                );
                                result.alertsDelivered += delivery.successChannelIds.length;
                                result.alertFailures += delivery.failedChannelIds.length;
                                if (this.pendingEnrichments.size > pendingBefore) result.enrichmentsQueued++;
                            } finally {
                                this.pendingNotifications.delete(hrId);
                            }
                        }

                        playerData.lastCheckedHR = Math.min(
                            currentHomeRuns,
                            Math.max(
                                identityCorrectionApplied
                                    ? 0
                                    : previousCheckpoint,
                                this.countContiguousDeliveredHomeRuns(
                                    playerId,
                                    playerData,
                                    allHomeRunDetails,
                                    checkpointFloor
                                )
                            )
                        );
                        if (playerData.lastCheckedHR < currentHomeRuns) {
                            this.logEvent('warn', 'checkpoint_pending_delivery', {
                                playerId,
                                checkpoint: playerData.lastCheckedHR,
                                currentHomeRuns
                            });
                        }
                        this.saveState({ throwOnError: true });
                    }

                    if (startupCatchUpActive && currentHomeRuns <= playerData.lastCheckedHR) {
                        this.startupCatchUpPlayerIds.delete(playerId);
                        this.logEvent('info', 'startup_catchup_complete', { playerId });
                    }
                } catch (error) {
                    result.playersFailed++;
                    this.logEvent('error', 'player_poll_failed', {
                        playerId,
                        player: playerData.name,
                        error: error.message
                    });
                } finally {
                    releasePlayerMutation();
                }
            }

            this.saveState({ throwOnError: true });
            result.cancelled = this.shuttingDown;
            if (!result.cancelled && result.playersChecked > 0 && result.playersFailed === 0) {
                this.lastSuccessfulPollAt = this.clock();
                this.metrics.checksSucceeded++;
            } else {
                this.metrics.checksFailed++;
            }
            result.completedAt = this.clock().toISOString();
            result.pendingEnrichments = this.pendingEnrichments.size;
            this.logEvent(result.playersFailed === 0 ? 'info' : 'warn', 'poll_completed', result);
            this.resumePendingEnrichments();
            return result;
        })();

        try {
            return await this.checkInProgress;
        } finally {
            this.checkInProgress = null;
        }
    }

    buildInitialAlertFields(playerData, totalHomeRuns, hrType, distance) {
        const compactDistance = String(distance).replace(/(\d+)\s*ft/i, '$1ft');

        return [
            { name: 'Type', value: hrType, inline: true },
            { name: 'Distance', value: compactDistance, inline: true },
            { name: 'Player', value: `${playerData.name} (#${playerData.number})`, inline: true },
            { name: 'Team', value: playerData.team, inline: true },
            {
                name: 'Season total at alert time',
                value: `${totalHomeRuns}`,
                inline: false
            }
        ];
    }

    getAnalysisCounts(analysisResult) {
        const cleared = Number(analysisResult?.total_dongs ?? analysisResult?.parks_cleared);
        const evaluated = Number(
            analysisResult?.parks_evaluated ??
            analysisResult?.parks_expected ??
            analysisResult?.total_parks
        );
        return {
            cleared: Number.isFinite(cleared) ? cleared : null,
            evaluated: Number.isFinite(evaluated) && evaluated > 0 ? evaluated : null
        };
    }

    buildCombinedFollowUpFields(analysisResult) {
        const { cleared, evaluated } = this.getAnalysisCounts(analysisResult);
        return [
            {
                name: 'Parks Cleared',
                value: cleared !== null && evaluated !== null ? `${cleared}/${evaluated}` : 'Unavailable',
                inline: true
            }
        ];
    }

    getHomeRunAlertPresentation(playerData, details, statcastData = null) {
        const primaryDetails = Array.isArray(details) ? details[0] : details;
        const hrType =
            statcastData?.rbi_description ||
            primaryDetails?.rbiDescription ||
            primaryDetails?.rbi_description ||
            'Home Run';
        const distanceText = Number.isFinite(Number(statcastData?.hit_distance_sc))
            ? `${Math.round(statcastData.hit_distance_sc)} ft`
            : (primaryDetails?.distance || 'Distance not available');

        let isNuke = false;
        if (distanceText && distanceText !== 'Not yet available' && distanceText !== 'Distance not available') {
            const match = String(distanceText).match(/(\d+)/);
            if (match) {
                const distanceNum = parseInt(match[1], 10);
                isNuke = distanceNum > 440;
            }
        }

        const titleText = hrType === 'Grand Slam!'
            ? `${playerData.name.toUpperCase()} GRAND SLAM!`
            : (hrType.includes('pending') || hrType === 'Home Run'
                ? `${playerData.name.toUpperCase()} HOME RUN!`
                : `${playerData.name.toUpperCase()} ${hrType.toUpperCase().replace(' HR', ' HOME RUN')}!`);
        const description = isNuke
            ? `${playerData.name} just launched a massive home run!`
            : `${playerData.name} just hit a home run!`;

        return {
            primaryDetails,
            hrType,
            distanceText,
            titleText,
            description
        };
    }

    getAnalysisEmbedColor(analysisResult) {
        const { cleared, evaluated } = this.getAnalysisCounts(analysisResult);
        const ratio = cleared !== null && evaluated ? cleared / evaluated : 0;
        if (ratio >= 0.8) {
            return '#FF2222';
        }

        if (ratio >= 0.5) {
            return '#FFD700';
        }

        return '#888888';
    }

    buildAlertMessageOptions(playerId, playerData, totalHomeRuns, details, options = {}) {
        const {
            statcastData = null,
            analysisResult = null,
            footerText = null
        } = options;
        const {
            primaryDetails,
            hrType,
            distanceText,
            titleText,
            description
        } = this.getHomeRunAlertPresentation(playerData, details, statcastData);

        const embed = new Discord.EmbedBuilder()
            .setTitle(titleText)
            .setDescription(description)
            .addFields(this.buildInitialAlertFields(
                playerData,
                totalHomeRuns,
                hrType,
                distanceText
            ))
            .setColor(analysisResult ? this.getAnalysisEmbedColor(analysisResult) : '#132448')
            .setTimestamp();

        if (analysisResult) {
            embed.addFields(this.buildCombinedFollowUpFields(analysisResult));
        }
        if (statcastData) {
            const pitcherDisplay = statcastData.pitcher_team
                ? `${statcastData.pitcher_name || 'Unknown'} (${statcastData.pitcher_team})`
                : (statcastData.pitcher_name || 'Unknown');
            embed.addFields(
                {
                    name: 'Exit Velocity',
                    value: Number.isFinite(Number(statcastData.launch_speed))
                        ? `${Number(statcastData.launch_speed).toFixed(1)} mph`
                        : 'Unavailable',
                    inline: true
                },
                {
                    name: 'Launch Angle',
                    value: Number.isFinite(Number(statcastData.launch_angle))
                        ? `${Math.round(Number(statcastData.launch_angle))}°`
                        : 'Unavailable',
                    inline: true
                },
                { name: 'Off Pitcher', value: pitcherDisplay, inline: true }
            );
        }

        if (footerText) {
            embed.setFooter({ text: footerText });
        } else if (primaryDetails?.rbi === null || primaryDetails?.detailStatus === 'pending') {
            embed.setFooter({ text: 'Details may update soon—check back.' });
        }

        const alertThumbnail = this.getPlayerHeadshotUrlById(playerId);
        if (alertThumbnail) {
            embed.setThumbnail(alertThumbnail);
        }

        const messageOptions = { embeds: [embed] };
        if (analysisResult?.image_path && this.fileSystem.existsSync(analysisResult.image_path)) {
            const attachment = new Discord.AttachmentBuilder(analysisResult.image_path, { name: 'ballpark_overlay.png' });
            embed.setImage('attachment://ballpark_overlay.png');
            messageOptions.files = [attachment];
        }

        return messageOptions;
    }

    async getGameMetadata(gameId) {
        const cacheKey = String(gameId);
        const cached = this.gameMetadataCache.get(cacheKey);
        if (cached && cached.expiresAt > this.clock().getTime()) {
            return cached.promise;
        }
        const promise = this.httpGet(
            `https://statsapi.mlb.com/api/v1.1/game/${gameId}/feed/live`
        ).then(response => {
            const gameData = response?.data?.gameData;
            const venueId = Number.parseInt(gameData?.venue?.id, 10);
            const venueName = String(gameData?.venue?.name || '').trim();
            const homeTeam = String(gameData?.teams?.home?.abbreviation || '').trim();
            const awayTeam = String(gameData?.teams?.away?.abbreviation || '').trim();
            if (!Number.isInteger(venueId) || !venueName || !homeTeam || !awayTeam) {
                throw new Error(`game ${gameId} metadata lacks authoritative venue/team identity`);
            }
            return { venueId, venueName, homeTeam, awayTeam };
        });
        this.gameMetadataCache.set(cacheKey, {
            expiresAt: this.clock().getTime() + this.gameMetadataCacheTtlMs,
            promise
        });
        try {
            return await promise;
        } catch (error) {
            if (this.gameMetadataCache.get(cacheKey)?.promise === promise) {
                this.gameMetadataCache.delete(cacheKey);
            }
            throw error;
        }
    }

    async getFullStatcastDataFromSavant(playerId, hrDetail, metadata, selectedPlay) {
        const rows = await this.getSavantHomeRunRows(playerId, hrDetail.gameId);
        const row = this.selectSavantHomeRunRow(rows, hrDetail);
        if (!row) return null;
        const boundedNumber = (value, minimum, maximum) => {
            if (value === null || value === undefined || value === '') return null;
            const numeric = Number(value);
            return Number.isFinite(numeric) && numeric >= minimum && numeric <= maximum
                ? numeric
                : null;
        };
        const numericFields = {
            launch_speed: boundedNumber(row.launch_speed, 20, 130),
            launch_angle: boundedNumber(row.launch_angle, -89.9, 89.9),
            hit_distance_sc: boundedNumber(row.hit_distance_sc ?? row.hit_distance, 100, 600),
            hc_x: boundedNumber(row.hc_x, -1000, 1000),
            hc_y: boundedNumber(row.hc_y, -1000, 1000),
            plate_z: boundedNumber(row.plate_z, 0, 20)
        };
        if (Object.values(numericFields).some(value => value === null)) return null;

        const halfInning = String(
            selectedPlay?.about?.halfInning || row.inning_topbot || ''
        ).toLowerCase();
        const pitcherTeam = halfInning === 'top'
            ? metadata.homeTeam
            : (['bottom', 'bot'].includes(halfInning) ? metadata.awayTeam : '');
        const rbi = this.extractSavantRbi(row);
        return {
            ...numericFields,
            game_pk: String(hrDetail.gameId),
            game_date: row.game_date || hrDetail.gameDate || null,
            home_team: metadata.homeTeam,
            venue_id: metadata.venueId,
            venue_name: metadata.venueName,
            pitcher_name: selectedPlay?.matchup?.pitcher?.fullName || 'Unknown',
            pitcher_team: pitcherTeam,
            rbi,
            rbi_description: this.getRbiDescription(rbi),
            statcast_source: 'baseball-savant-csv'
        };
    }

    async getStatcastDataForHR(playerId, hrDetail) {
        const eventId = this.buildHomeRunId(hrDetail, playerId);
        const cached = this.statcastCache.get(`play:${eventId}`);
        if (cached && cached.expiresAt > this.clock().getTime()) {
            return cached.promise;
        }

        const promise = (async () => {
            try {
                const gameId = hrDetail?.gameId;
                if (!gameId) return null;
                const [plays, metadata] = await Promise.all([
                    this.getGamePlays(gameId).catch(error => {
                        this.logEvent('warn', 'live_feed_plays_unavailable_using_savant', {
                            playerId,
                            gameId,
                            eventId,
                            error: error.message
                        });
                        return [];
                    }),
                    this.getGameMetadata(gameId)
                ]);
                const matchingHomeRuns = plays
                    .filter(play => this.isHomeRunByPlayer(play, playerId))
                    .sort((left, right) =>
                        (Number.isInteger(left.about?.atBatIndex) ? left.about.atBatIndex : Number.MAX_SAFE_INTEGER) -
                        (Number.isInteger(right.about?.atBatIndex) ? right.about.atBatIndex : Number.MAX_SAFE_INTEGER)
                    );
                let selectedPlay = null;
                if (Number.isInteger(hrDetail?.atBatIndex)) {
                    selectedPlay = matchingHomeRuns.find(
                        play => play.about?.atBatIndex === hrDetail.atBatIndex
                    ) || null;
                }
                if (!selectedPlay && Number.isInteger(hrDetail?.gameHomeRunIndex)) {
                    selectedPlay = matchingHomeRuns[hrDetail.gameHomeRunIndex - 1] || null;
                }
                if (!selectedPlay) {
                    return this.getFullStatcastDataFromSavant(
                        playerId,
                        hrDetail,
                        metadata,
                        null
                    );
                }

                let hitData = null;
                let plateZ = null;
                for (const event of (selectedPlay.playEvents || [])) {
                    if (event?.hitData) hitData = event.hitData;
                    const candidatePlateZ = Number(event?.pitchData?.coordinates?.pZ);
                    if (Number.isFinite(candidatePlateZ)) plateZ = candidatePlateZ;
                }
                const requiredNumber = (value, minimum, maximum) => {
                    if (value === null || value === undefined || value === '') return null;
                    const numeric = Number(value);
                    return Number.isFinite(numeric) && numeric >= minimum && numeric <= maximum
                        ? numeric
                        : null;
                };
                const numericFields = {
                    launch_speed: requiredNumber(hitData?.launchSpeed, 20, 130),
                    launch_angle: requiredNumber(hitData?.launchAngle, -89.9, 89.9),
                    hit_distance_sc: requiredNumber(hitData?.totalDistance, 100, 600),
                    hc_x: requiredNumber(hitData?.coordinates?.coordX, -1000, 1000),
                    hc_y: requiredNumber(hitData?.coordinates?.coordY, -1000, 1000),
                    plate_z: requiredNumber(plateZ, 0, 20)
                };
                if (Object.values(numericFields).some(value => value === null)) {
                    const savantData = await this.getFullStatcastDataFromSavant(
                        playerId,
                        hrDetail,
                        metadata,
                        selectedPlay
                    );
                    if (savantData) {
                        this.logEvent('info', 'statcast_savant_fallback_used', {
                            playerId,
                            gameId,
                            eventId
                        });
                    }
                    return savantData;
                }

                const rbiInfo = this.extractRBIInfo(selectedPlay);
                const halfInning = String(selectedPlay?.about?.halfInning || '').toLowerCase();
                const pitcherTeam = halfInning === 'top'
                    ? metadata.homeTeam
                    : (halfInning === 'bottom' ? metadata.awayTeam : '');
                return {
                    ...numericFields,
                    game_pk: String(gameId),
                    game_date: hrDetail.gameDate || null,
                    home_team: metadata.homeTeam,
                    venue_id: metadata.venueId,
                    venue_name: metadata.venueName,
                    pitcher_name: selectedPlay.matchup?.pitcher?.fullName || 'Unknown',
                    pitcher_team: pitcherTeam,
                    rbi: rbiInfo.rbi,
                    rbi_description: rbiInfo.rbiDescription,
                    statcast_source: 'mlb-live-feed'
                };
            } catch (error) {
                this.logEvent('warn', 'statcast_fetch_failed', {
                    playerId,
                    gameId: hrDetail?.gameId || null,
                    eventId,
                    error: error.message
                });
                return null;
            }
        })();
        this.statcastCache.set(`play:${eventId}`, {
            expiresAt: this.clock().getTime() + this.statcastCacheTtlMs,
            promise
        });
        return promise;
    }

    execFileAsync(command, args, options = {}) {
        if (this.pythonRunner) {
            return Promise.resolve(this.pythonRunner(command, args, options));
        }
        return new Promise((resolve, reject) => {
            execFile(command, args, options, (error, stdout, stderr) => {
                if (error) {
                    error.stdout = stdout;
                    error.stderr = stderr;
                    reject(error);
                    return;
                }
                resolve({ stdout, stderr });
            });
        });
    }

    getPythonEnvironment() {
        const environment = {
            ...process.env,
            PYTHONDONTWRITEBYTECODE: '1'
        };
        for (const name of Object.keys(environment)) {
            if (name.toUpperCase() === 'BOT_TOKEN') {
                delete environment[name];
            }
        }
        return environment;
    }

    async preflightPython() {
        if (this.pythonPreflightPromise) return this.pythonPreflightPromise;
        this.pythonPreflightPromise = (async () => {
            const requiredFiles = [
                path.join(__dirname, 'scripts', 'hr_analysis.py'),
                path.join(__dirname, 'data', 'fences.json'),
                path.join(__dirname, 'data', 'stadium_paths.json'),
                path.join(__dirname, 'data', 'ballpark_metadata.json')
            ];
            const missingFiles = requiredFiles.filter(file => !this.fileSystem.existsSync(file));
            if (missingFiles.length > 0) {
                throw new Error(`required analysis files are missing: ${missingFiles.map(path.basename).join(', ')}`);
            }
            let ballparkMetadata;
            try {
                ballparkMetadata = JSON.parse(this.fileSystem.readFileSync(requiredFiles[3], 'utf8'));
            } catch (error) {
                throw new Error(`ballpark_metadata.json is invalid: ${error.message}`);
            }
            const declaredGeometryHashes = ballparkMetadata?.geometry_files_sha256;
            for (const geometryFile of requiredFiles.slice(1, 3)) {
                const fileName = path.basename(geometryFile);
                const declaredHash = declaredGeometryHashes?.[fileName];
                if (!/^[a-f0-9]{64}$/i.test(String(declaredHash || ''))) {
                    throw new Error(`ballpark metadata is missing a valid SHA-256 pin for ${fileName}`);
                }
                const actualHash = crypto.createHash('sha256')
                    .update(this.fileSystem.readFileSync(geometryFile))
                    .digest('hex');
                if (actualHash.toLowerCase() !== String(declaredHash).toLowerCase()) {
                    throw new Error(`${fileName} does not match its ballpark metadata SHA-256 pin`);
                }
            }
            const versionHash = crypto.createHash('sha256');
            for (const file of requiredFiles) {
                versionHash.update(this.fileSystem.readFileSync(file));
            }
            this.ballparkDataVersion = versionHash.digest('hex').slice(0, 16);
            this.ballparkMetadataVersion = String(
                ballparkMetadata?.data_version || ''
            ).trim() || null;
            if (!this.ballparkMetadataVersion) {
                throw new Error('ballpark metadata has no data_version');
            }
            const requirementsPath = path.join(
                __dirname,
                'requirements.txt'
            );
            if (!this.fileSystem.existsSync(requirementsPath)) {
                throw new Error('requirements.txt is missing');
            }
            const pinnedVersions = {};
            for (const line of this.fileSystem
                .readFileSync(requirementsPath, 'utf8')
                .split(/\r?\n/)) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#')) continue;
                const match = trimmed.match(
                    /^([A-Za-z0-9_.-]+)==([^\s;]+)$/
                );
                if (!match) {
                    throw new Error(
                        `requirements.txt contains a non-exact pin: ${trimmed}`
                    );
                }
                pinnedVersions[
                    match[1].toLowerCase().replace(/[-_.]+/g, '-')
                ] = match[2];
            }
            for (const dependency of [
                'matplotlib',
                'numpy',
                'pillow'
            ]) {
                if (!pinnedVersions[dependency]) {
                    throw new Error(
                        `requirements.txt has no exact ${dependency} pin`
                    );
                }
            }
            if (ballparkMetadata?.advanced_analysis_enabled !== true) {
                const reason = String(
                    ballparkMetadata?.analysis_disabled_reason ||
                    'advanced park analysis is disabled by ballpark metadata'
                ).trim();
                throw new Error(reason);
            }
            const release = ballparkMetadata?.analysis_release;
            if (!release ||
                release.status !== 'verified' ||
                release.source_revisions_recorded !== true ||
                release.calibration_complete !== true ||
                release.calculation_rendering_walls_aligned !== true) {
                throw new Error(
                    'enabled park analysis lacks a complete verified release attestation'
                );
            }

            const compatiblePythonVersions = ['3.13', '3.12', '3.11', '3.10'];
            const discoveredCandidates = [
                { command: path.join(__dirname, 'venv', 'Scripts', 'python.exe'), argsPrefix: [] },
                { command: path.join(__dirname, '.venv', 'Scripts', 'python.exe'), argsPrefix: [] },
                { command: path.join(__dirname, 'venv', 'bin', 'python'), argsPrefix: [] },
                { command: path.join(__dirname, '.venv', 'bin', 'python'), argsPrefix: [] },
                ...compatiblePythonVersions.map(version => ({
                    command: `python${version}`,
                    argsPrefix: []
                })),
                { command: 'python3', argsPrefix: [] },
                { command: 'python', argsPrefix: [] },
                ...(process.platform === 'win32'
                    ? compatiblePythonVersions.map(version => ({
                        command: 'py',
                        argsPrefix: [`-${version}`]
                    }))
                    : [])
            ];
            const candidates = this.pythonPath
                ? [{ command: this.pythonPath, argsPrefix: [] }]
                : discoveredCandidates;
            const probe = [
                '-c',
                'import sys; ' +
                    'exec("if not ((3, 10) <= sys.version_info[:2] <= (3, 13)):\\n raise RuntimeError(\'Python 3.10 through 3.13 is required\')"); ' +
                    'import matplotlib, numpy, PIL; ' +
                    `expected = ${JSON.stringify({
                        matplotlib: pinnedVersions.matplotlib,
                        numpy: pinnedVersions.numpy,
                        pillow: pinnedVersions.pillow
                    })}; ` +
                    'actual = {"matplotlib": matplotlib.__version__, "numpy": numpy.__version__, "pillow": PIL.__version__}; ' +
                    'exec("if actual != expected:\\n raise RuntimeError(f\'Python dependency versions {actual} do not match {expected}\')"); ' +
                    'print(sys.version)'
            ];
            if (this.pythonRunner) {
                this.pythonCommand =
                    this.pythonPath || 'injected-python';
                this.pythonArgsPrefix = [];
                await this.execFileAsync(
                    this.pythonCommand,
                    probe,
                    {
                        timeout: 10000,
                        windowsHide: true,
                        maxBuffer: 256 * 1024,
                        env: this.getPythonEnvironment()
                    }
                );
                this.analysisAvailable = true;
                this.analysisPermanentlyUnavailable = false;
                this.analysisUnavailableReason = null;
                return this.pythonCommand;
            }
            let configuredError = null;
            for (const candidate of candidates) {
                if (path.isAbsolute(candidate.command) && !this.fileSystem.existsSync(candidate.command)) {
                    configuredError = new Error(`${candidate.command} does not exist`);
                    continue;
                }
                try {
                    await this.execFileAsync(candidate.command, [...candidate.argsPrefix, ...probe], {
                        timeout: 10000,
                        windowsHide: true,
                        maxBuffer: 256 * 1024,
                        env: this.getPythonEnvironment()
                    });
                    this.pythonCommand = candidate.command;
                    this.pythonArgsPrefix = candidate.argsPrefix;
                    this.analysisAvailable = true;
                    this.analysisPermanentlyUnavailable = false;
                    this.analysisUnavailableReason = null;
                    return candidate.command;
                } catch (error) {
                    configuredError = error;
                    if (this.pythonPath) break;
                }
            }
            if (this.pythonPath) {
                throw new Error(`configured PYTHON_BIN failed dependency preflight: ${configuredError?.message || 'unknown error'}`);
            }
            throw new Error('no Python 3.10-3.13 interpreter with matplotlib, numpy, and Pillow was found');
        })().catch(error => {
            this.analysisAvailable = false;
            this.analysisPermanentlyUnavailable = true;
            this.analysisUnavailableReason = error.message;
            throw error;
        });
        return this.pythonPreflightPromise;
    }

    async withAnalysisSlot(task) {
        if (this.shuttingDown) {
            throw new Error('Bot is shutting down');
        }
        if (this.analysisActive >= this.maxAnalysisConcurrency) {
            await new Promise(resolve => this.analysisQueue.push(resolve));
        }
        if (this.shuttingDown) {
            throw new Error('Bot is shutting down');
        }
        this.analysisActive++;
        try {
            return await task();
        } finally {
            this.analysisActive--;
            this.analysisQueue.shift()?.();
        }
    }

    isUsableAnalysisResult(result, statcastData) {
        if (!this.analysisAvailable ||
            this.analysisPermanentlyUnavailable ||
            !this.ballparkDataVersion ||
            !this.ballparkMetadataVersion) {
            return false;
        }
        if (!result || typeof result !== 'object') return false;
        if (result.source_data_hash !== this.ballparkDataVersion ||
            result.ballpark_data_version !== this.ballparkMetadataVersion) {
            return false;
        }
        const status = result.analysis_status || (result.success ? 'ok' : 'error');
        if (!['ok', 'partial'].includes(status)) return false;
        const { cleared, evaluated } = this.getAnalysisCounts(result);
        if (cleared === null || evaluated === null || cleared < 0 || cleared > evaluated) return false;
        const returnedVenueId = Number.parseInt(result.venue_id, 10);
        const requestedVenueId = Number.parseInt(statcastData?.venue_id, 10);
        return Number.isInteger(returnedVenueId) &&
            Number.isInteger(requestedVenueId) &&
            returnedVenueId === requestedVenueId;
    }

    buildParkAnalysisRecord(result, statcastData) {
        const { cleared, evaluated } = this.getAnalysisCounts(result);
        return {
            parksCleared: cleared,
            parksEvaluated: evaluated,
            parksExpected: Number.isFinite(Number(result.parks_expected))
                ? Number(result.parks_expected)
                : evaluated,
            analysisStatus: result.analysis_status || 'ok',
            analysisWarnings: Array.isArray(result.analysis_warnings) ? result.analysis_warnings : [],
            ballparkDataVersion: result.ballpark_data_version || null,
            sourceDataHash: this.ballparkDataVersion,
            venueId: Number(statcastData.venue_id),
            venueName: statcastData.venue_name,
            geometryTeam: result.geometry_team || null,
            inputs: {
                launchSpeed: statcastData.launch_speed,
                launchAngle: statcastData.launch_angle,
                hitDistance: statcastData.hit_distance_sc,
                hcX: statcastData.hc_x,
                hcY: statcastData.hc_y,
                plateZ: statcastData.plate_z
            },
            analyzedAt: this.clock().toISOString()
        };
    }

    async runHRAnalysis(statcastData, playerName, playerId = null, eventId = null) {
        if (!Number.isInteger(Number.parseInt(statcastData?.venue_id, 10)) ||
            !String(statcastData?.venue_name || '').trim() ||
            !String(statcastData?.home_team || '').trim()) {
            this.logEvent('warn', 'analysis_skipped_unknown_venue', {
                playerId,
                eventId,
                venueId: statcastData?.venue_id || null
            });
            return null;
        }
        const identityKey = eventId || crypto.createHash('sha256')
            .update(JSON.stringify(statcastData))
            .digest('hex');
        const cacheKey = `${this.ballparkDataVersion || 'unversioned'}:${identityKey}`;
        if (this.analysisCache.has(cacheKey)) {
            return this.analysisCache.get(cacheKey);
        }

        const promise = this.withAnalysisSlot(async () => {
            await this.preflightPython();
            this.fileSystem.mkdirSync(this.tempRoot, { recursive: true });
            const assetCacheDirectory = path.join(this.tempRoot, 'asset-cache');
            this.fileSystem.mkdirSync(assetCacheDirectory, { recursive: true });
            const tempDirectory = this.fileSystem.mkdtempSync(path.join(this.tempRoot, 'analysis-'));
            this.activeTempDirectories.add(tempDirectory);
            const outputImage = path.join(tempDirectory, 'ballpark_overlay.png');
            const args = [
                path.join(__dirname, 'scripts', 'hr_analysis.py'),
                '--launch_speed', String(statcastData.launch_speed),
                '--launch_angle', String(statcastData.launch_angle),
                '--hit_distance', String(statcastData.hit_distance_sc),
                '--hc_x', String(statcastData.hc_x),
                '--hc_y', String(statcastData.hc_y),
                '--plate_z', String(statcastData.plate_z),
                '--home_team', statcastData.home_team,
                '--venue_id', String(statcastData.venue_id),
                '--player_name', playerName,
                '--player_id', playerId ? String(playerId) : '',
                '--pitcher_name', statcastData.pitcher_name || 'Unknown',
                '--output_image', outputImage,
                '--asset_cache_dir', assetCacheDirectory,
                '--fences_path', path.join(__dirname, 'data', 'fences.json'),
                '--stadium_paths', path.join(__dirname, 'data', 'stadium_paths.json')
            ];
            try {
                const execution = await this.execFileAsync(
                    this.pythonCommand,
                    [...this.pythonArgsPrefix, ...args],
                    {
                        timeout: 60000,
                        windowsHide: true,
                        maxBuffer: 1024 * 1024,
                        env: this.getPythonEnvironment()
                    }
                );
                const stdout = typeof execution === 'string' ? execution : execution?.stdout;
                const result = JSON.parse(String(stdout || '').trim());
                result.analysis_status = result.analysis_status || (result.success ? 'ok' : 'error');
                result.source_data_hash = this.ballparkDataVersion;
                result.image_path = result.image_status === 'ok' && this.fileSystem.existsSync(outputImage)
                    ? outputImage
                    : null;
                result.temp_directory = tempDirectory;
                return result;
            } catch (error) {
                let structuredError = null;
                try {
                    const parsed = JSON.parse(String(error.stdout || '').trim());
                    if (parsed && typeof parsed === 'object' &&
                        (parsed.analysis_status === 'error' || parsed.success === false)) {
                        structuredError = {
                            ...parsed,
                            analysis_status: 'error',
                            success: false,
                            permanent_error: true,
                            image_path: null,
                            temp_directory: tempDirectory
                        };
                    }
                } catch {}
                if (structuredError) {
                    this.logEvent('warn', 'analysis_degraded', {
                        playerId,
                        eventId,
                        gameId: statcastData.game_pk || null,
                        venueId: statcastData.venue_id,
                        error: structuredError.analysis_error || 'analysis returned a structured error'
                    });
                    return structuredError;
                }
                this.logEvent('error', 'analysis_failed', {
                    playerId,
                    eventId,
                    gameId: statcastData.game_pk || null,
                    venueId: statcastData.venue_id,
                    error: error.message,
                    stderr: error.stderr ? String(error.stderr).slice(0, 1000) : undefined
                });
                this.cleanupAnalysisArtifacts(tempDirectory);
                return null;
            }
        });
        this.analysisCache.set(cacheKey, promise);
        void promise.then(
            result => {
                if (!result && this.analysisCache.get(cacheKey) === promise) {
                    this.analysisCache.delete(cacheKey);
                }
            },
            () => {
                if (this.analysisCache.get(cacheKey) === promise) {
                    this.analysisCache.delete(cacheKey);
                }
            }
        );
        return promise;
    }

    cleanupAnalysisArtifacts(targetPath) {
        if (!targetPath) return;
        let candidateDirectory;
        try {
            if (!this.fileSystem.existsSync(targetPath)) {
                this.activeTempDirectories.delete(path.resolve(targetPath));
                return;
            }
            candidateDirectory = this.fileSystem.statSync(targetPath).isDirectory()
                ? targetPath
                : path.dirname(targetPath);
        } catch (error) {
            if (error?.code === 'ENOENT') {
                this.activeTempDirectories.delete(path.resolve(targetPath));
                return;
            }
            this.logEvent('warn', 'analysis_cleanup_inspection_failed', {
                targetPath,
                error: error.message
            });
            return;
        }
        const resolvedRoot = path.resolve(this.tempRoot);
        const resolvedDirectory = path.resolve(candidateDirectory);
        if (!resolvedDirectory.startsWith(`${resolvedRoot}${path.sep}`)) {
            this.logEvent('warn', 'cleanup_refused_outside_temp_root', { targetPath });
            return;
        }
        if (path.dirname(resolvedDirectory) !== resolvedRoot ||
            !path.basename(resolvedDirectory).startsWith('analysis-')) {
            this.logEvent('warn', 'cleanup_refused_non_analysis_directory', { targetPath });
            return;
        }
        try {
            this.fileSystem.rmSync(resolvedDirectory, { recursive: true, force: true });
            this.activeTempDirectories.delete(resolvedDirectory);
        } catch (error) {
            this.logEvent('warn', 'analysis_cleanup_failed', { targetPath, error: error.message });
        }
    }

    async sendInitialAlert(playerId, playerData, totalHomeRuns, hrDetail, hrId, channelIds) {
        const successChannelIds = [];
        const failedChannelIds = [];
        for (const channelId of channelIds) {
            if (this.shuttingDown) break;
            try {
                const channel = await this.client.channels.fetch(channelId);
                if (this.shuttingDown) break;
                const messageOptions = this.buildAlertMessageOptions(
                    playerId,
                    playerData,
                    totalHomeRuns,
                    hrDetail,
                    { footerText: 'Statcast analysis is pending.' }
                );
                messageOptions.nonce = this.buildDiscordNonce(
                    'home-run',
                    channelId,
                    hrId
                );
                messageOptions.enforceNonce = true;
                const sentMessage = await channel.send(messageOptions);
                this.markHomeRunSentToChannels(playerData, hrId, [channelId], {
                    messageId: sentMessage?.id ? String(sentMessage.id) : null,
                    deliveryMode: 'basic-alert',
                    playerId: String(playerId),
                    season: this.currentSeason,
                    hrId,
                    totalHomeRuns,
                    hrDetail,
                    enrichedAt: null,
                    enrichmentDeliveryMode: null,
                    enrichmentMessageId: null,
                    imageDelivered: false,
                    retractedAt: null,
                    correctionMessageId: null
                });
                successChannelIds.push(channelId);
                this.metrics.delivered++;
                try {
                    this.saveState({ throwOnError: true });
                } catch (persistenceError) {
                    const pendingRecord = {
                        playerId: String(playerId),
                        season: this.currentSeason,
                        hrId,
                        totalHomeRuns,
                        hrDetail,
                        channelIds: [...successChannelIds],
                        createdAt: this.clock().toISOString(),
                        attempts: 0
                    };
                    this.queueEnrichment(pendingRecord, { persist: false });
                    this.logEvent('fatal', 'delivery_ack_persistence_failed', {
                        playerId,
                        gameId: hrDetail.gameId,
                        eventId: hrId,
                        channelId,
                        messageId: sentMessage?.id || null,
                        error: persistenceError.message
                    });
                    this.scheduleFatalShutdown('delivery-ack-persistence-failed', persistenceError);
                    persistenceError.deliveryAcknowledged = true;
                    throw persistenceError;
                }
                this.logEvent('info', 'basic_alert_delivered', {
                    playerId,
                    gameId: hrDetail.gameId,
                    eventId: hrId,
                    channelId,
                    messageId: sentMessage?.id || null
                });
            } catch (error) {
                if (error.deliveryAcknowledged) {
                    throw error;
                }
                failedChannelIds.push(channelId);
                this.metrics.failed++;
                this.logEvent('error', 'basic_alert_failed', {
                    playerId,
                    gameId: hrDetail.gameId,
                    eventId: hrId,
                    channelId,
                    error: error.message
                });
            }
        }
        if (successChannelIds.length > 0) {
            this.queueEnrichment({
                playerId,
                season: this.currentSeason,
                hrId,
                totalHomeRuns,
                hrDetail,
                channelIds: successChannelIds,
                createdAt: this.clock().toISOString(),
                attempts: 0
            });
        }
        return { successChannelIds, failedChannelIds };
    }

    mergeEnrichmentRecord(target, incoming) {
        if (!target || !incoming || target === incoming) return target || incoming;
        if (!Array.isArray(target.channelIds)) target.channelIds = [];
        for (const channelId of incoming.channelIds || []) {
            const normalized = String(channelId);
            if (!target.channelIds.includes(normalized)) {
                target.channelIds.push(normalized);
            }
        }
        target.playerId = String(incoming.playerId ?? target.playerId);
        target.season = Number(incoming.season ?? target.season);
        target.hrId = String(incoming.hrId ?? target.hrId);
        if (incoming.totalHomeRuns !== undefined &&
            incoming.totalHomeRuns !== null) {
            target.totalHomeRuns = incoming.totalHomeRuns;
        }
        target.hrDetail = {
            ...(target.hrDetail || {}),
            ...(incoming.hrDetail || {})
        };
        const createdAtCandidates = [target.createdAt, incoming.createdAt]
            .filter(value => Number.isFinite(Date.parse(value)))
            .sort((left, right) => Date.parse(left) - Date.parse(right));
        target.createdAt = createdAtCandidates[0] ||
            target.createdAt ||
            incoming.createdAt;
        target.previousHrIds = [...new Set([
            ...(target.previousHrIds || []),
            ...(incoming.previousHrIds || [])
        ].map(String))].filter(id => id !== target.hrId);
        if (incoming.cancelledReason && !target.cancelledReason) {
            target.cancelledReason = incoming.cancelledReason;
        }
        const nextAttemptCandidates = [target.nextAttemptAt, incoming.nextAttemptAt]
            .filter(value => Number.isFinite(Date.parse(value)))
            .sort((left, right) => Date.parse(left) - Date.parse(right));
        if (nextAttemptCandidates.length > 0) {
            target.nextAttemptAt = nextAttemptCandidates[0];
        }
        const lastAttemptCandidates = [target.lastAttemptAt, incoming.lastAttemptAt]
            .filter(value => Number.isFinite(Date.parse(value)))
            .sort((left, right) => Date.parse(right) - Date.parse(left));
        if (lastAttemptCandidates.length > 0) {
            target.lastAttemptAt = lastAttemptCandidates[0];
        }
        for (const field of [
            'statcastData',
            'analysisResult',
            'imageStatus',
            'terminalReason',
            'terminalLoggedAt',
        ]) {
            if (target[field] === undefined && incoming[field] !== undefined) {
                target[field] = incoming[field];
            }
        }
        for (const field of [
            'attempts',
            'dataAttempts',
            'analysisAttempts',
            'deliveryAttempts',
            'imageRegenerationAttempts',
        ]) {
            target[field] = Math.max(
                Number(target[field]) || 0,
                Number(incoming[field]) || 0
            );
        }
        return target;
    }

    isEnrichmentRecordActive(record) {
        return [...this.activeEnrichmentRecords.values()]
            .some(activeRecord => activeRecord === record);
    }

    getPendingEnrichmentKey(record, fallbackKey = null) {
        const canonicalKey =
            `${record.season}:${record.playerId}:${record.hrId}`;
        if (this.pendingEnrichments.get(canonicalKey) === record) {
            return canonicalKey;
        }
        if (fallbackKey && this.pendingEnrichments.get(fallbackKey) === record) {
            return fallbackKey;
        }
        const matchingEntry = [...this.pendingEnrichments.entries()]
            .find(([, candidate]) => candidate === record);
        return matchingEntry?.[0] || canonicalKey;
    }

    queueEnrichment(record, { persist = true } = {}) {
        const jobKey = `${record.season}:${record.playerId}:${record.hrId}`;
        const existing = this.pendingEnrichments.get(jobKey);
        const merged = existing
            ? this.mergeEnrichmentRecord(existing, record)
            : {
                ...record,
                channelIds: [...new Set((record.channelIds || []).map(String))]
            };
        this.pendingEnrichments.set(jobKey, merged);
        if (persist) {
            this.saveState({ throwOnError: true });
        }
        if (!this.isEnrichmentRecordActive(merged) &&
            !this.enrichmentQueue.includes(jobKey)) {
            this.enrichmentQueue.push(jobKey);
            this.metrics.queued++;
            this.pumpEnrichmentQueue();
        }
    }

    resumePendingEnrichments() {
        const now = this.clock().getTime();
        for (const [jobKey, record] of this.pendingEnrichments) {
            if (record.nextAttemptAt && Date.parse(record.nextAttemptAt) > now) continue;
            if (!this.isEnrichmentRecordActive(record) &&
                !this.activeEnrichmentJobs.has(jobKey) &&
                !this.enrichmentQueue.includes(jobKey)) {
                this.enrichmentQueue.push(jobKey);
            }
        }
        this.pumpEnrichmentQueue();
        this.scheduleEnrichmentWake();
    }

    scheduleEnrichmentWake() {
        if (this.enrichmentWakeTimer) {
            clearTimeout(this.enrichmentWakeTimer);
            this.enrichmentWakeTimer = null;
        }
        if (this.shuttingDown || this.pendingEnrichments.size === 0) return;
        const now = this.clock().getTime();
        const queuedKeys = new Set(this.enrichmentQueue);
        const nextDueTimes = [...this.pendingEnrichments.entries()]
            .filter(([jobKey, record]) =>
                !queuedKeys.has(jobKey) &&
                !this.isEnrichmentRecordActive(record)
            )
            .map(([, record]) =>
                record.nextAttemptAt ? Date.parse(record.nextAttemptAt) : now
            )
            .filter(Number.isFinite);
        if (nextDueTimes.length === 0) return;
        const nextDue = Math.min(...nextDueTimes);
        const delay = Math.max(0, nextDue - now);
        this.enrichmentWakeTimer = setTimeout(() => {
            this.enrichmentWakeTimer = null;
            this.resumePendingEnrichments();
        }, Math.min(delay, 0x7fffffff));
    }

    pumpEnrichmentQueue() {
        while (!this.shuttingDown &&
            this.enrichmentActive < this.maxEnrichmentConcurrency &&
            this.enrichmentQueue.length > 0) {
            const jobKey = this.enrichmentQueue.shift();
            const record = this.pendingEnrichments.get(jobKey);
            if (!record ||
                this.activeEnrichmentJobs.has(jobKey) ||
                this.isEnrichmentRecordActive(record)) {
                continue;
            }
            if (record.nextAttemptAt && Date.parse(record.nextAttemptAt) > this.clock().getTime()) {
                continue;
            }
            this.enrichmentActive++;
            const job = this.processEnrichment(jobKey, record)
                .catch(error => {
                    this.logEvent('error', 'enrichment_job_failed', {
                        jobId: jobKey,
                        playerId: record.playerId,
                        eventId: record.hrId,
                        error: error.message
                    });
                })
                .finally(() => {
                    this.enrichmentActive--;
                    this.activeEnrichmentJobs.delete(jobKey);
                    this.activeEnrichmentRecords.delete(jobKey);
                    this.backgroundJobs.delete(job);
                    this.pumpEnrichmentQueue();
                    this.scheduleEnrichmentWake();
                });
            this.activeEnrichmentJobs.set(jobKey, job);
            this.activeEnrichmentRecords.set(jobKey, record);
            this.backgroundJobs.add(job);
        }
    }

    async updateEnrichedAlert(
        playerId,
        playerData,
        record,
        channelId,
        statcastData,
        analysisResult,
        footerText
    ) {
        const releaseEventMutation =
            await this.acquireKeyedLock(
                this.discordEventMutationLocks,
                `${channelId}:${record.hrId}`
            );
        try {
            return await this.updateEnrichedAlertCore(
                playerId,
                playerData,
                record,
                channelId,
                statcastData,
                analysisResult,
                footerText
            );
        } finally {
            releaseEventMutation();
        }
    }

    async updateEnrichedAlertCore(playerId, playerData, record, channelId, statcastData, analysisResult, footerText) {
        if (this.shuttingDown || record.cancelledReason) {
            throw new Error('Enrichment delivery was cancelled');
        }
        let deliveryRecord = this.getAlertDeliveryRecord(
            playerData,
            channelId,
            record.hrId
        );
        if (!deliveryRecord) {
            throw new Error(
                `No basic-alert delivery record exists for ${record.hrId} in ${channelId}`
            );
        }
        if (deliveryRecord.retractedAt ||
            deliveryRecord.retractionInProgress) {
            record.cancelledReason = record.cancelledReason || 'official-correction';
            throw new Error('Cannot enrich an alert that MLB has retracted');
        }
        if (deliveryRecord.enrichmentFailedAt) {
            throw new Error('Enrichment delivery is already terminal');
        }
        if (deliveryRecord.enrichedAt) return true;
        const channel = await this.client.channels.fetch(channelId);
        deliveryRecord = this.getAlertDeliveryRecord(
            playerData,
            channelId,
            record.hrId
        );
        if (!deliveryRecord) {
            throw new Error(
                `Basic-alert delivery disappeared for ${record.hrId} in ${channelId}`
            );
        }
        if (deliveryRecord.retractedAt ||
            deliveryRecord.retractionInProgress) {
            record.cancelledReason = record.cancelledReason || 'official-correction';
            throw new Error('Cannot enrich an alert that MLB has retracted');
        }
        if (deliveryRecord.enrichmentFailedAt) {
            throw new Error('Enrichment delivery is already terminal');
        }
        const messageOptions = this.buildAlertMessageOptions(
            playerId,
            playerData,
            record.totalHomeRuns,
            record.hrDetail,
            { statcastData, analysisResult, footerText }
        );
        let deliveryMode = 'follow-up';
        let deliveredMessageId = null;
        let releaseEditedMessageMutation = null;
        if (deliveryRecord.messageId && channel.messages?.fetch) {
            const basicMessageId = deliveryRecord.messageId;
            const releaseMessageMutation =
                await this.acquireKeyedLock(
                    this.discordMessageMutationLocks,
                    `${channelId}:${basicMessageId}`
                );
            try {
                deliveryRecord = this.getAlertDeliveryRecord(
                    playerData,
                    channelId,
                    record.hrId
                );
                if (!deliveryRecord ||
                    deliveryRecord.retractedAt ||
                    deliveryRecord.retractionInProgress ||
                    deliveryRecord.enrichmentFailedAt ||
                    this.shuttingDown ||
                    record.cancelledReason) {
                    record.cancelledReason =
                        record.cancelledReason ||
                        (deliveryRecord?.retractedAt ||
                            deliveryRecord?.retractionInProgress
                            ? 'official-correction'
                            : 'delivery-unavailable');
                    const error = new Error(
                        'Enrichment delivery was cancelled'
                    );
                    error.enrichmentCancelled = true;
                    throw error;
                }
                const existingMessage =
                    await channel.messages.fetch(basicMessageId);
                if (this.shuttingDown || record.cancelledReason) {
                    const error = new Error(
                        'Enrichment delivery was cancelled'
                    );
                    error.enrichmentCancelled = true;
                    throw error;
                }
                const edited = await existingMessage.edit(messageOptions);
                deliveryMode = 'edited';
                deliveredMessageId =
                    edited?.id || basicMessageId;
                releaseEditedMessageMutation = releaseMessageMutation;
            } catch (error) {
                if (error.enrichmentCancelled) throw error;
                this.logEvent('warn', 'alert_edit_failed_using_followup', {
                    playerId,
                    eventId: record.hrId,
                    channelId,
                    messageId: basicMessageId,
                    error: error.message
                });
            } finally {
                if (releaseEditedMessageMutation !==
                    releaseMessageMutation) {
                    releaseMessageMutation();
                }
            }
        }
        try {
            if (deliveryMode === 'follow-up') {
                if (this.shuttingDown || record.cancelledReason) {
                    throw new Error('Enrichment delivery was cancelled');
                }
                messageOptions.nonce = this.buildDiscordNonce(
                    'enrichment',
                    channelId,
                    record.hrId
                );
                messageOptions.enforceNonce = true;
                const followUp = await channel.send(messageOptions);
                deliveredMessageId = followUp?.id || null;
            }
            deliveryRecord = this.getAlertDeliveryRecord(
                playerData,
                channelId,
                record.hrId
            );
            if (!deliveryRecord) {
                throw new Error(
                    `Basic-alert delivery disappeared for ${record.hrId} in ${channelId}`
                );
            }
            if (deliveryMode === 'follow-up' && deliveredMessageId) {
                Object.assign(deliveryRecord, {
                    enrichmentDeliveryMode: deliveryMode,
                    enrichmentMessageId: deliveredMessageId,
                    imageDelivered: Boolean(messageOptions.files?.length)
                });
            }
            Object.assign(deliveryRecord, {
                enrichedAt: this.clock().toISOString(),
                enrichmentDeliveryMode: deliveryMode,
                enrichmentMessageId: deliveredMessageId,
                imageDelivered: Boolean(messageOptions.files?.length),
                parkAnalysisDelivered: Boolean(analysisResult),
                analysisSourceDataHash: analysisResult
                    ? this.ballparkDataVersion
                    : null,
                analysisMetadataVersion: analysisResult
                    ? this.ballparkMetadataVersion
                    : null
            });
            record.channelIds = [
                ...new Set((record.channelIds || []).map(String))
            ].filter(candidateChannelId =>
                candidateChannelId !== String(channelId)
            );
            const pendingEntries = [
                ...this.pendingEnrichments.entries()
            ].filter(([, candidate]) => candidate === record);
            if (pendingEntries.length > 0) {
                for (const [pendingKey] of pendingEntries) {
                    this.pendingEnrichments.delete(pendingKey);
                }
                if (record.channelIds.length > 0) {
                    this.pendingEnrichments.set(
                        `${record.season}:${record.playerId}:${record.hrId}`,
                        record
                    );
                }
            }
            try {
                this.saveState({ throwOnError: true });
            } catch (error) {
                this.logEvent('fatal', 'enrichment_ack_persistence_failed', {
                    playerId,
                    eventId: record.hrId,
                    channelId,
                    messageId: deliveredMessageId,
                    error: error.message
                });
                this.scheduleFatalShutdown(
                    'enrichment-ack-persistence-failed',
                    error
                );
                throw error;
            }
            if (this.shuttingDown || record.cancelledReason) {
                throw new Error(
                    'Enrichment delivery was cancelled after Discord accepted it'
                );
            }
            return true;
        } finally {
            if (releaseEditedMessageMutation) {
                releaseEditedMessageMutation();
            }
        }
    }

    async withdrawStaleParkAnalysisDeliveries() {
        let reviewed = 0;
        let withdrawn = 0;
        let deferred = 0;
        for (const [playerId, playerData] of Object.entries(this.players)) {
            for (const channelId of this.channelIds) {
                const records =
                    playerData.alertMessagesByChannel?.[channelId] || {};
                for (const [eventId, delivery] of Object.entries(records)) {
                    if (this.shuttingDown || !delivery?.enrichedAt ||
                        delivery.parkAnalysisDelivered === false ||
                        delivery.parkAnalysisWithdrawnAt) {
                        continue;
                    }
                    const currentVersion =
                        this.analysisAvailable &&
                        !this.analysisPermanentlyUnavailable &&
                        delivery.analysisSourceDataHash ===
                            this.ballparkDataVersion &&
                        delivery.analysisMetadataVersion ===
                            this.ballparkMetadataVersion;
                    if (delivery.parkAnalysisDelivered === true &&
                        currentVersion) {
                        continue;
                    }

                    reviewed++;
                    const mutationEventId =
                        playerData.eventAliases?.[eventId] ||
                        delivery.hrId ||
                        eventId;
                    const releaseEventMutation =
                        await this.acquireKeyedLock(
                            this.discordEventMutationLocks,
                            `${channelId}:${mutationEventId}`
                        );
                    try {
                        if (delivery.parkAnalysisDelivered === false ||
                            delivery.parkAnalysisWithdrawnAt) {
                            continue;
                        }
                        const messageId =
                            delivery.enrichmentMessageId ||
                            delivery.messageId;
                        if (!messageId) {
                            deferred++;
                            this.logEvent(
                                'warn',
                                'park_analysis_withdrawal_missing_message',
                                { playerId, eventId, channelId }
                            );
                            continue;
                        }
                        const channel = await this.client.channels.fetch(
                            channelId
                        );
                        const releaseMessageMutation =
                            await this.acquireKeyedLock(
                                this.discordMessageMutationLocks,
                                `${channelId}:${messageId}`
                            );
                        try {
                            if (delivery.parkAnalysisDelivered === false ||
                                delivery.parkAnalysisWithdrawnAt) {
                                continue;
                            }
                            const nowCurrentVersion =
                                this.analysisAvailable &&
                                !this.analysisPermanentlyUnavailable &&
                                delivery.analysisSourceDataHash ===
                                    this.ballparkDataVersion &&
                                delivery.analysisMetadataVersion ===
                                    this.ballparkMetadataVersion;
                            if (delivery.parkAnalysisDelivered === true &&
                                nowCurrentVersion) {
                                continue;
                            }
                            const message = await channel.messages.fetch(
                                messageId
                            );
                            if (!message?.embeds?.[0]) {
                                throw new Error(
                                    'enriched alert has no editable embed'
                                );
                            }
                            const embedData =
                                typeof message.embeds[0].toJSON === 'function'
                                    ? message.embeds[0].toJSON()
                                    : structuredClone(message.embeds[0].data ||
                                        message.embeds[0]);
                            const fields = Array.isArray(embedData.fields)
                                ? embedData.fields
                                : [];
                            const retainedFields = fields.filter(field =>
                                String(field?.name || '')
                                    .trim()
                                    .toLowerCase() !== 'parks cleared'
                            );
                            const hasParkField =
                                retainedFields.length !== fields.length;
                            const hasOverlayImage =
                                delivery.imageDelivered === true ||
                                String(embedData.image?.url || '')
                                    .includes('ballpark_overlay');
                            if (hasParkField || hasOverlayImage) {
                                const existingFooter =
                                    String(embedData.footer?.text || '').trim();
                                const withdrawalNotice =
                                    'Prior park projection withdrawn after a geometry calibration review; Statcast details are retained.';
                                const footerText = existingFooter
                                    ? `${existingFooter} ${withdrawalNotice}`
                                    : withdrawalNotice;
                                const revisedData = {
                                    ...embedData,
                                    fields: retainedFields,
                                    color: 0x747f8d,
                                    footer: {
                                        ...(embedData.footer || {}),
                                        text: footerText.slice(0, 2048)
                                    }
                                };
                                delete revisedData.image;
                                const revisedEmbed =
                                    Discord.EmbedBuilder.from(revisedData);
                                await message.edit({
                                    embeds: [revisedEmbed],
                                    attachments: []
                                });
                                delivery.parkAnalysisWithdrawnAt =
                                    this.clock().toISOString();
                                withdrawn++;
                            }
                            delivery.parkAnalysisDelivered = false;
                            delivery.imageDelivered = false;
                            delivery.analysisSourceDataHash = null;
                            delivery.analysisMetadataVersion = null;
                            try {
                                this.saveState({ throwOnError: true });
                            } catch (error) {
                                this.scheduleFatalShutdown(
                                    'park-analysis-withdrawal-persistence-failed',
                                    error
                                );
                                throw error;
                            }
                        } finally {
                            releaseMessageMutation();
                        }
                    } catch (error) {
                        deferred++;
                        this.logEvent(
                            'warn',
                            'park_analysis_withdrawal_deferred',
                            {
                                playerId,
                                eventId,
                                channelId,
                                messageId,
                                error: error.message
                            }
                        );
                    } finally {
                        releaseEventMutation();
                    }
                }
            }
        }
        this.logEvent('info', 'park_analysis_withdrawal_completed', {
            reviewed,
            withdrawn,
            deferred
        });
        return { reviewed, withdrawn, deferred };
    }

    async processEnrichment(jobKey, record) {
        try {
            return await this.processEnrichmentCore(jobKey, record);
        } finally {
            const eventIds = new Set([
                String(record.hrId),
                ...(record.previousHrIds || []).map(String)
            ]);
            const matchingCacheKeys = [...this.analysisCache.keys()]
                .filter(key => [...eventIds].some(eventId =>
                    key.endsWith(`:${eventId}`) ||
                    key.includes(`:${eventId}:artifact:`)
                ));
            for (const analysisCacheKey of matchingCacheKeys) {
                const cachedAnalysis = this.analysisCache.get(analysisCacheKey);
                try {
                    const result = await Promise.resolve(cachedAnalysis);
                    if (result?.temp_directory) {
                        this.cleanupAnalysisArtifacts(result.temp_directory);
                    }
                } catch {}
                this.analysisCache.delete(analysisCacheKey);
            }
        }
    }

    deferEnrichment(jobKey, record, delayMs, { kind = 'data' } = {}) {
        jobKey = this.getPendingEnrichmentKey(record, jobKey);
        record.attempts = (record.attempts || 0) + 1;
        if (kind === 'delivery') {
            record.deliveryAttempts = (record.deliveryAttempts || 0) + 1;
        } else if (kind === 'analysis') {
            record.analysisAttempts = (record.analysisAttempts || 0) + 1;
        } else {
            record.dataAttempts = (record.dataAttempts || 0) + 1;
        }
        record.lastAttemptAt = this.clock().toISOString();
        record.nextAttemptAt = new Date(this.clock().getTime() + delayMs).toISOString();
        this.pendingEnrichments.set(jobKey, record);
        this.saveState({ throwOnError: true });
    }

    async processEnrichmentCore(jobKey, record) {
        jobKey = this.getPendingEnrichmentKey(record, jobKey);
        const playerId = String(record.playerId);
        const playerData = this.players[playerId];
        if (!playerData ||
            record.season !== this.currentSeason ||
            record.cancelledReason) {
            this.pendingEnrichments.delete(jobKey);
            this.saveState({ throwOnError: true });
            return;
        }
        record.channelIds = (record.channelIds || []).filter(channelId => {
            const delivery = this.getAlertDeliveryRecord(
                playerData,
                channelId,
                record.hrId
            );
            return delivery?.basicSentAt &&
                !delivery.enrichedAt &&
                !delivery.retractedAt &&
                !delivery.enrichmentFailedAt;
        });
        if (record.channelIds.length === 0) {
            this.pendingEnrichments.delete(jobKey);
            this.saveState({ throwOnError: true });
            return;
        }

        let attemptsThisRun = 0;
        let statcastData = record.statcastData || null;
        let analysisResult = record.analysisResult || null;
        let analysisError = null;
        const createdAt = Date.parse(record.createdAt);
        const ageMs = Number.isFinite(createdAt)
            ? Math.max(0, this.clock().getTime() - createdAt)
            : 0;
        const dataAttempts = Number(record.dataAttempts ?? record.attempts ?? 0);
        const analysisAttempts = Number(record.analysisAttempts || 0);
        let terminalStatcastFailure = record.terminalReason === 'statcast-unavailable' ||
            ageMs >= this.enrichmentMaxAgeMs ||
            dataAttempts >= this.enrichmentMaxDataAttempts;
        const terminalAnalysisFailure =
            record.terminalReason === 'analysis-unavailable' ||
            ageMs >= this.enrichmentMaxAgeMs ||
            analysisAttempts >= this.enrichmentMaxDataAttempts;

        while (!this.shuttingDown &&
            !terminalStatcastFailure &&
            !terminalAnalysisFailure &&
            !this.isUsableAnalysisResult(analysisResult, statcastData) &&
            attemptsThisRun < 2) {
            attemptsThisRun++;
            statcastData = await this.getStatcastDataForHR(playerId, record.hrDetail);
            if (!statcastData) break;
            if (statcastData) {
                if (this.analysisPermanentlyUnavailable) {
                    analysisError = 'Statcast is available; park analysis is unavailable on this bot instance.';
                    break;
                }
                try {
                    analysisResult = await this.runHRAnalysis(
                        statcastData,
                        playerData.name,
                        playerId,
                        record.hrId
                    );
                } catch (error) {
                    if (this.analysisPermanentlyUnavailable) {
                        analysisError = 'Statcast is available; park analysis is unavailable on this bot instance.';
                        break;
                    }
                    this.logEvent('warn', 'analysis_retryable_failure', {
                        jobId: jobKey,
                        playerId,
                        eventId: record.hrId,
                        error: error.message
                    });
                    if (attemptsThisRun < 2) {
                        await this.sleep(30000);
                    }
                    continue;
                }
                if (this.isUsableAnalysisResult(analysisResult, statcastData)) {
                    playerData.homeRunParks[record.hrId] =
                        this.buildParkAnalysisRecord(analysisResult, statcastData);
                    record.statcastData = statcastData;
                    record.analysisResult = {
                        ...analysisResult,
                        image_path: null,
                        temp_directory: null
                    };
                    jobKey = this.getPendingEnrichmentKey(record, jobKey);
                    this.pendingEnrichments.set(jobKey, record);
                    this.saveState({ throwOnError: true });
                    break;
                }
                if (analysisResult?.analysis_status === 'error' || analysisResult?.permanent_error) {
                    analysisError = analysisResult.analysis_error || 'Park analysis is unavailable for this venue.';
                    analysisResult = null;
                    break;
                }
            }
            if (attemptsThisRun < 2) {
                await this.sleep(30000);
            }
        }

        if (record.season !== this.currentSeason) {
            this.logEvent('info', 'enrichment_abandoned_after_season_rollover', {
                jobId: jobKey,
                recordSeason: record.season,
                activeSeason: this.currentSeason
            });
            return;
        }
        if (this.shuttingDown || record.cancelledReason) {
            return;
        }

        if (!statcastData) {
            if (!terminalStatcastFailure) {
                this.deferEnrichment(jobKey, record, 15 * 60 * 1000);
                return;
            }
            record.terminalReason = 'statcast-unavailable';
            analysisError = 'Statcast details remained unavailable; no further data retries will run.';
            if (!record.terminalLoggedAt) {
                record.terminalLoggedAt = this.clock().toISOString();
                this.metrics.enrichmentsTerminal++;
                this.logEvent('warn', 'enrichment_data_terminal', {
                    jobId: jobKey,
                    playerId,
                    gameId: record.hrDetail?.gameId || null,
                    eventId: record.hrId,
                    ageMs,
                    dataAttempts
                });
            }
        }

        let usableAnalysis = this.isUsableAnalysisResult(analysisResult, statcastData)
            ? analysisResult
            : null;
        if (statcastData &&
            !usableAnalysis &&
            !analysisError &&
            !this.analysisPermanentlyUnavailable) {
            if (!terminalAnalysisFailure) {
                record.statcastData = statcastData;
                this.deferEnrichment(
                    jobKey,
                    record,
                    15 * 60 * 1000,
                    { kind: 'analysis' }
                );
                return;
            }
            record.terminalReason = 'analysis-unavailable';
            analysisError =
                'Park analysis remained unavailable; no further analysis retries will run.';
            if (!record.terminalLoggedAt) {
                record.terminalLoggedAt = this.clock().toISOString();
                this.metrics.enrichmentsTerminal++;
                this.logEvent('warn', 'enrichment_analysis_terminal', {
                    jobId: jobKey,
                    playerId,
                    eventId: record.hrId,
                    ageMs,
                    analysisAttempts
                });
            }
        }
        let imageFooter = null;
        if (usableAnalysis) {
            const needsPersistedArtifact = !usableAnalysis.image_path &&
                record.imageStatus === 'available';
            const canRetryInitialImage = !usableAnalysis.image_path &&
                record.imageStatus !== 'unavailable' &&
                (record.imageRegenerationAttempts || 0) < 1;
            if ((needsPersistedArtifact || canRetryInitialImage) &&
                !this.analysisPermanentlyUnavailable) {
                if (canRetryInitialImage) {
                    record.imageRegenerationAttempts =
                        (record.imageRegenerationAttempts || 0) + 1;
                }
                try {
                    const regenerated = await this.runHRAnalysis(
                        statcastData,
                        playerData.name,
                        playerId,
                        `${record.hrId}:artifact:${record.deliveryAttempts || 0}:${record.imageRegenerationAttempts || 0}`
                    );
                    if (this.isUsableAnalysisResult(regenerated, statcastData) &&
                        regenerated.image_path) {
                        usableAnalysis = regenerated;
                        analysisResult = regenerated;
                        record.imageStatus = 'available';
                    } else {
                        record.imageStatus = 'unavailable';
                        imageFooter = 'The park counts are available, but the overlay image could not be generated.';
                        this.logEvent('warn', 'analysis_image_unavailable', {
                            jobId: jobKey,
                            playerId,
                            eventId: record.hrId,
                            error: regenerated?.image_error || regenerated?.analysis_error || null
                        });
                    }
                } catch (error) {
                    record.imageStatus = 'unavailable';
                    imageFooter = 'The park counts are available, but the overlay image could not be generated.';
                    this.logEvent('warn', 'analysis_image_regeneration_failed', {
                        jobId: jobKey,
                        playerId,
                        eventId: record.hrId,
                        error: error.message
                    });
                }
            } else if (!usableAnalysis.image_path && record.imageStatus === 'unavailable') {
                imageFooter = 'The park counts are available, but the overlay image is unavailable.';
            } else if (usableAnalysis.image_path) {
                record.imageStatus = 'available';
            } else {
                imageFooter = 'The park counts are available, but the overlay image is unavailable.';
            }
            record.analysisResult = {
                ...usableAnalysis,
                image_path: null,
                temp_directory: null
            };
            record.statcastData = statcastData;
        }
        const footerParts = [];
        if (usableAnalysis?.analysis_status === 'partial') {
            footerParts.push('Park analysis is partial; unsupported parks were excluded.');
        }
        if (imageFooter) footerParts.push(imageFooter);
        if (!usableAnalysis) {
            footerParts.push(
                analysisError ||
                (statcastData
                    ? 'Statcast is available, but park analysis is unavailable.'
                    : 'Statcast details are unavailable.')
            );
        }
        const footerText = footerParts.join(' ');
        const remainingChannels = [];
        for (const channelId of [...record.channelIds]) {
            if (this.shuttingDown || record.cancelledReason) break;
            try {
                await this.updateEnrichedAlert(
                    playerId,
                    playerData,
                    record,
                    channelId,
                    statcastData,
                    usableAnalysis,
                    footerText
                );
                this.logEvent('info', 'alert_enriched', {
                    jobId: jobKey,
                    playerId,
                    gameId: record.hrDetail.gameId,
                    eventId: record.hrId,
                    channelId
                });
            } catch (error) {
                remainingChannels.push(channelId);
                this.logEvent('error', 'alert_enrichment_delivery_failed', {
                    jobId: jobKey,
                    playerId,
                    eventId: record.hrId,
                    channelId,
                    error: error.message
                });
            }
        }
        if (record.cancelledReason) {
            for (const [candidateKey, candidate] of [...this.pendingEnrichments]) {
                if (candidate === record) {
                    this.pendingEnrichments.delete(candidateKey);
                }
            }
            return;
        }
        if (this.shuttingDown) {
            return;
        }

        jobKey = this.getPendingEnrichmentKey(record, jobKey);
        const latestRecord = this.pendingEnrichments.get(jobKey);
        if (latestRecord && latestRecord !== record) {
            this.mergeEnrichmentRecord(record, latestRecord);
            this.pendingEnrichments.set(jobKey, record);
        }
        const pendingChannelIds = [...new Set([
            ...remainingChannels,
            ...(record.channelIds || []).filter(channelId => {
                const delivery = this.getAlertDeliveryRecord(
                    playerData,
                    channelId,
                    record.hrId
                );
                return delivery?.basicSentAt &&
                    !delivery.enrichedAt &&
                    !delivery.retractedAt &&
                    !delivery.enrichmentFailedAt;
            })
        ])];
        if (pendingChannelIds.length === 0) {
            this.pendingEnrichments.delete(jobKey);
        } else {
            record.channelIds = pendingChannelIds;
            record.attempts = (record.attempts || 0) + 1;
            record.deliveryAttempts = (record.deliveryAttempts || 0) + 1;
            if (ageMs >= this.enrichmentMaxAgeMs ||
                record.deliveryAttempts >= this.enrichmentMaxDataAttempts) {
                for (const channelId of pendingChannelIds) {
                    const delivery = this.getAlertDeliveryRecord(
                        playerData,
                        channelId,
                        record.hrId
                    );
                    if (delivery) {
                        delivery.enrichmentFailedAt =
                            this.clock().toISOString();
                        delivery.enrichmentFailureReason =
                            'Delivery retry limit reached';
                    }
                }
                if (!record.deliveryTerminalLoggedAt) {
                    record.deliveryTerminalLoggedAt =
                        this.clock().toISOString();
                    this.metrics.enrichmentsTerminal++;
                    this.logEvent('error', 'enrichment_delivery_terminal', {
                        jobId: jobKey,
                        playerId,
                        eventId: record.hrId,
                        channelIds: pendingChannelIds,
                        ageMs,
                        deliveryAttempts: record.deliveryAttempts
                    });
                }
                this.pendingEnrichments.delete(jobKey);
            } else {
                record.nextAttemptAt = new Date(
                    this.clock().getTime() + 5 * 60 * 1000
                ).toISOString();
                this.pendingEnrichments.set(jobKey, record);
            }
        }
        this.saveState({ throwOnError: true });
    }

    startMonitoring() {
        if (this.monitorTask || this.shuttingDown) return;
        const runScheduledPoll = async () => {
            this.monitorTask = null;
            try {
                await this.checkForNewHomeRuns();
            } catch (error) {
                this.logEvent('error', 'scheduled_poll_failed', { error: error.message });
            } finally {
                this.resumePendingEnrichments();
                this.scheduleNextPoll();
            }
        };
        this.scheduledPollRunner = runScheduledPoll;
        this.logEvent('info', 'monitoring_started', {
            pollIntervalMs: this.pollIntervalMs,
            offseasonPollIntervalMs: this.offseasonPollIntervalMs,
            jitterMs: this.pollJitterMs
        });

        if (this.startupCatchUpPlayerIds.size > 0) {
            void runScheduledPoll();
        } else {
            this.scheduleNextPoll();
        }
    }

    isOffseason() {
        const month = this.clock().getUTCMonth();
        return month === 10 || month === 11 || month === 0 || month === 1;
    }

    scheduleNextPoll() {
        if (this.shuttingDown || this.monitorTask) return;
        const baseDelay = this.isOffseason()
            ? this.offseasonPollIntervalMs
            : this.pollIntervalMs;
        const jitter = this.pollJitterMs > 0
            ? Math.floor(this.random() * (this.pollJitterMs + 1))
            : 0;
        this.monitorTask = setTimeout(this.scheduledPollRunner, baseDelay + jitter);
    }

    async handleCommand(message) {
        const content = message.content.trim().toLowerCase();
        if (!content.startsWith('!')) {
            return;
        }

        const parts = content.split(/\s+/);
        const command = parts[0];
        const args = parts.slice(1);
        const shortcutPlayerId = this.getPlayerShortcutCommands().get(command);
        if (shortcutPlayerId) {
            await this.sendPlayerStats(shortcutPlayerId, message);
            return;
        }

        if (command === '!players') {
            await this.sendTrackedPlayers(message);
            return;
        }

        if (command === '!hrstats') {
            await this.sendAllHomeRunStats(message);
            return;
        }

        if (command === '!parkstats') {
            const playerName = args.join(' ') || null;
            await this.sendParksBreakdown(message, playerName);
            return;
        }

        const adminCommands = new Set([
            '!testhr',
            '!debug',
            '!forcecheck',
            '!reset'
        ]);

        if (adminCommands.has(command) && !(await this.ensureAdmin(message))) {
            return;
        }

        if (command === '!testhr') {
            await this.sendTestHomeRunAlert(message);
            return;
        }

        if (command === '!debug') {
            await this.sendDebugInfo(message);
            return;
        }

        if (command === '!forcecheck') {
            await message.reply('Running manual home run check...');
            const result = await this.checkForNewHomeRuns({ force: true });
            await message.reply(
                `Manual check finished: ${result.detected} HR detected, ` +
                `${result.alertsDelivered} basic alert delivery(s), ${result.alertFailures} delivery failure(s), ` +
                `${result.enrichmentsQueued} enrichment job(s) queued, ${result.playersFailed} player(s) unavailable, ` +
                `${result.pendingEnrichments} enrichment job(s) pending.`
            );
            return;
        }

        if (command === '!reset') {
            const playerName = args.join(' ');
            if (!playerName) {
                await message.reply('Usage: !reset [playerName]');
                return;
            }

            await this.resetPlayerHR(playerName, message);
            return;
        }
    }

    async sendDebugInfo(message) {
        try {
            const debugInfo = [];
            debugInfo.push(`**Bot Status:**`);
            debugInfo.push(`- Last check: ${this.lastCheckTime ? this.lastCheckTime.toISOString() : 'Never'}`);
            debugInfo.push(`- Last fully successful poll: ${this.lastSuccessfulPollAt ? this.lastSuccessfulPollAt.toISOString() : 'Never'}`);
            debugInfo.push(`- Current season: ${this.currentSeason}`);
            debugInfo.push(`- Alert channels: ${this.channelIds.length} (${this.channelIds.join(', ')})`);
            debugInfo.push(`- Polls: ${this.metrics.checksSucceeded} succeeded / ${this.metrics.checksFailed} degraded or failed`);
            debugInfo.push(`- Alerts: ${this.metrics.detected} detected / ${this.metrics.delivered} delivered / ${this.metrics.failed} failed`);
            const oldestPendingTimestamp = Math.min(...[...this.pendingEnrichments.values()]
                .map(record => Date.parse(record.createdAt))
                .filter(Number.isFinite));
            const oldestPending = Number.isFinite(oldestPendingTimestamp)
                ? this.formatSnapshotAge(new Date(oldestPendingTimestamp).toISOString())
                : 'N/A';
            debugInfo.push(`- Enrichment queue: ${this.pendingEnrichments.size} pending (oldest: ${oldestPending})`);
            debugInfo.push(`\n**Player Tracking:**`);

            for (const [playerId, playerData] of Object.entries(this.players)) {
                const snapshot = await this.getPlayerStatsForDisplay(playerId);
                const currentHR = this.getSeasonHomeRunTotal(snapshot.stats);
                const liveText = currentHR === null
                    ? 'Unavailable'
                    : `${currentHR}${snapshot.stale ? ` (stale, ${this.formatSnapshotAge(snapshot.fetchedAt)})` : ''}`;
                debugInfo.push(`- ${playerData.name}: Tracked=${playerData.lastCheckedHR}, Current=${liveText}`);
            }

            const embed = new Discord.EmbedBuilder()
                .setTitle('🔧 Debug Information')
                .setDescription(debugInfo.join('\n'))
                .setColor('#FFA500')
                .setTimestamp();

            await message.reply({ embeds: [embed] });
        } catch (error) {
            this.log(`Error in debug command: ${error.message}`);
            await message.reply('Error getting debug info!');
        }
    }

    async resetPlayerHR(playerName, message) {
        try {
            const resolution = this.resolvePlayerByName(playerName);
            const playerId = resolution.playerId;

            if (!playerId) {
                await message.reply(this.formatPlayerResolutionError(playerName, resolution));
                return;
            }

            if (this.checkInProgress) {
                await this.checkInProgress;
            }
            const releasePlayerMutation = await this.acquireKeyedLock(
                this.playerMutationLocks,
                playerId
            );
            try {
            const currentTotal = await this.getPlayerHomeRunTotal(playerId);
            if (currentTotal === null) {
                await message.reply('The live MLB total is unavailable, so no tracking state was changed.');
                return;
            }
            const playerData = this.players[playerId];
            const currentDetails = currentTotal > 0
                ? await this.getRecentHomeRunDetails(
                    playerId,
                    currentTotal,
                    { force: true }
                )
                : [];
            const confirmedTotal = await this.getPlayerHomeRunTotal(playerId);
            if (confirmedTotal !== currentTotal) {
                await message.reply(
                    'MLB data changed while the reset snapshot was being reconstructed, so no tracking state was changed.'
                );
                return;
            }
            const eventIds = await this.reconcileAuthoritativeInventory(
                playerId,
                playerData,
                currentDetails,
                currentTotal,
                { persist: false }
            );
            if (!eventIds) {
                await message.reply(
                    'The complete current home-run inventory is unavailable, so no tracking state was changed.'
                );
                return;
            }
            const oldValue = playerData.lastCheckedHR;
            playerData.lastCheckedHR = currentTotal;
            playerData.checkpointInitialized = true;
            playerData.lowerTotalObservation = null;
            playerData.inventoryCorrectionCandidate = null;
            playerData.baselineHomeRunIds = new Set(eventIds);
            playerData.baselineSnapshotInitialized = true;
            try {
                this.saveState({ throwOnError: true });
            } catch (error) {
                this.scheduleFatalShutdown(
                    'manual-resync-persistence-failed',
                    error
                );
                throw error;
            }
            this.logEvent('info', 'player_checkpoint_resynchronized', {
                playerId,
                player: playerData.name,
                previousCheckpoint: oldValue,
                currentTotal
            });

            await message.reply(
                `Resynchronized ${playerData.name}'s checkpoint from ${oldValue} to the live total (${currentTotal}). ` +
                'Previously delivered alert history was preserved; historical alerts will not replay.'
            );
            } finally {
                releasePlayerMutation();
            }
        } catch (error) {
            this.log(`Error in reset command: ${error.message}`);
            await message.reply('Error resetting player HR count!');
        }
    }

    getParksBreakdown(homeRunParks) {
        const counts = { noDoubter: 0, tier80: 0, tier60: 0, tier40: 0, under40: 0 };
        const records = Object.values(homeRunParks || {})
            .filter(value => this.isCurrentParkAnalysisRecord(value))
            .map(value => this.normalizeParkAnalysisRecord(value))
            .filter(Boolean);

        for (const record of records) {
            const ratio = record.parksCleared / record.parksEvaluated;
            if (record.parksCleared === record.parksEvaluated) {
                counts.noDoubter++;
            } else if (ratio >= 0.8) {
                counts.tier80++;
            } else if (ratio >= 0.6) {
                counts.tier60++;
            } else if (ratio >= 0.4) {
                counts.tier40++;
            } else {
                counts.under40++;
            }
        }

        return { total: records.length, counts };
    }

    normalizeParkAnalysisRecord(value) {
        if (Number.isFinite(Number(value)) && (typeof value === 'number' || typeof value === 'string')) {
            const cleared = Number(value);
            if (cleared < 0 || cleared > 30) return null;
            return {
                parksCleared: cleared,
                parksEvaluated: 30,
                parksExpected: 30,
                analysisStatus: 'legacy',
                legacy: true
            };
        }
        if (!value || typeof value !== 'object') return null;
        const parksCleared = Number(value.parksCleared ?? value.total_dongs);
        const parksEvaluated = Number(value.parksEvaluated ?? value.parks_evaluated);
        if (!Number.isFinite(parksCleared) || !Number.isFinite(parksEvaluated) ||
            parksEvaluated <= 0 || parksCleared < 0 || parksCleared > parksEvaluated) {
            return null;
        }
        return { ...value, parksCleared, parksEvaluated };
    }

    isCurrentParkAnalysisRecord(value) {
        if (!this.analysisAvailable ||
            this.analysisPermanentlyUnavailable ||
            !this.ballparkDataVersion ||
            !this.ballparkMetadataVersion) {
            return false;
        }
        const record = this.normalizeParkAnalysisRecord(value);
        if (!record || record.legacy) return false;
        if (record.sourceDataHash !== this.ballparkDataVersion ||
            record.ballparkDataVersion !== this.ballparkMetadataVersion) {
            return false;
        }
        return ['ok', 'partial'].includes(record.analysisStatus);
    }

    getSeasonHomeRunTotal(stats) {
        if (stats?.homeRuns === null || stats?.homeRuns === undefined) return null;
        const total = Number.parseInt(stats.homeRuns, 10);
        return Number.isInteger(total) && total >= 0 ? total : null;
    }

    buildParksBreakdownLines(breakdown, seasonHomeRunTotal = null) {
        const { total, counts } = breakdown;
        const hasSeasonTotal = Number.isFinite(seasonHomeRunTotal);
        const summaryLine = hasSeasonTotal
            ? `Parks data: **${total}/${seasonHomeRunTotal} HR**`
            : `Parks data: **${total} HR**`;

        if (total === 0) {
            return [
                summaryLine,
                hasSeasonTotal && seasonHomeRunTotal > 0
                    ? 'No current verified park breakdown is stored for those home runs.'
                    : 'No current verified parks data is available.'
            ];
        }

        return [
            summaryLine,
            `Cleared every evaluated park: **${counts.noDoubter}**`,
            `Cleared at least 80%: **${counts.tier80}**`,
            `Cleared 60–79%: **${counts.tier60}**`,
            `Cleared 40–59%: **${counts.tier40}**`,
            `Cleared under 40%: **${counts.under40}**`
        ];
    }

    formatParksBreakdown(playerName, breakdown, seasonHomeRunTotal = null) {
        return [
            `**${playerName}**`,
            ...this.buildParksBreakdownLines(breakdown, seasonHomeRunTotal)
        ].join('\n');
    }

    queuePlayerParkBackfill(playerId, seasonHomeRunTotal = null, { force = false } = {}) {
        const playerData = this.players[playerId];
        const analyzedHomeRunTotal = Object.entries(playerData?.homeRunParks || {})
            .filter(([eventId, value]) => {
                return playerData?.authoritativeSnapshotInitialized &&
                    playerData.authoritativeHomeRunIds.has(eventId) &&
                    this.isCurrentParkAnalysisRecord(value);
            }).length;
        const normalizedTotal = seasonHomeRunTotal !== null &&
            seasonHomeRunTotal !== undefined &&
            Number.isInteger(Number(seasonHomeRunTotal)) &&
            Number(seasonHomeRunTotal) >= 0
            ? Number(seasonHomeRunTotal)
            : null;
        const remaining = normalizedTotal === null
            ? null
            : Math.max(0, normalizedTotal - analyzedHomeRunTotal);
        if (!playerData || normalizedTotal === null) {
            return { state: 'unavailable', queued: false, inProgress: false, remaining };
        }
        if (this.inventoryReconciliationPlayerIds.has(String(playerId))) {
            return {
                state: 'inventory_reconciliation',
                queued: false,
                inProgress: false,
                remaining
            };
        }
        if (this.analysisPermanentlyUnavailable) {
            return {
                state: 'analysis_unavailable',
                queued: false,
                inProgress: false,
                remaining
            };
        }
        if (!this.analysisAvailable) {
            return {
                state: 'analysis_unavailable',
                queued: false,
                inProgress: false,
                remaining
            };
        }
        if (remaining === 0) {
            return { state: 'complete', queued: false, inProgress: false, remaining: 0 };
        }
        if (this.backfillPromises.has(playerId)) {
            return { state: 'in_progress', queued: false, inProgress: true, remaining };
        }
        const now = this.clock().getTime();
        const lastStarted = this.backfillLastStartedAt.get(playerId) || 0;
        if (!force && now - lastStarted < this.backfillCooldownMs) {
            return {
                state: 'cooldown',
                queued: false,
                inProgress: false,
                remaining,
                retryAfterMs: this.backfillCooldownMs - (now - lastStarted)
            };
        }
        this.backfillLastStartedAt.set(playerId, now);
        const jobSeason = this.currentSeason;
        let job;
        job = this.ensurePlayerParkDataCore(playerId, normalizedTotal, jobSeason)
            .catch(error => {
                this.logEvent('error', 'park_backfill_failed', {
                    playerId,
                    error: error.message
                });
                return null;
            })
            .finally(() => {
                if (this.backfillPromises.get(playerId) === job) {
                    this.backfillPromises.delete(playerId);
                }
                this.backgroundJobs.delete(job);
            });
        this.backfillPromises.set(playerId, job);
        this.backgroundJobs.add(job);
        return { state: 'queued', queued: true, inProgress: true, remaining };
    }

    formatParkBackfillStatus(status) {
        if (!status) return null;
        if (status.state === 'queued') {
            return `Park-analysis backfill queued in the background; ${status.remaining} HR remaining.`;
        }
        if (status.state === 'in_progress') {
            return `Park-analysis backfill is already in progress; ${status.remaining} HR remaining.`;
        }
        if (status.state === 'cooldown') {
            const seconds = Math.max(1, Math.ceil(status.retryAfterMs / 1000));
            return `Park-analysis backfill is cooling down for about ${seconds}s; ${status.remaining} HR remaining.`;
        }
        if (status.state === 'analysis_unavailable') {
            return 'Verified park projections are disabled pending geometry calibration; ' +
                `no backfill was queued (${status.remaining} HR without current analysis).`;
        }
        if (status.state === 'inventory_reconciliation') {
            return 'Park-analysis backfill was not queued while MLB event identities are being reconciled.';
        }
        if (status.state === 'unavailable') {
            return 'Park-analysis backfill was not queued because the live season total is unavailable.';
        }
        return null;
    }

    async ensurePlayerParkDataCore(
        playerId,
        seasonHomeRunTotal = null,
        jobSeason = this.currentSeason
    ) {
        const playerData = this.players[playerId];
        const reconciliationPlayerId = String(playerId);
        if (!playerData ||
            jobSeason !== this.currentSeason ||
            this.inventoryReconciliationPlayerIds.has(reconciliationPlayerId)) {
            return { seasonHomeRunTotal: null, analyzedHomeRunTotal: 0, updatedHomeRuns: 0 };
        }

        if (!playerData.homeRunParks || typeof playerData.homeRunParks !== 'object') {
            playerData.homeRunParks = {};
        }

        const suppliedTotal = seasonHomeRunTotal === null || seasonHomeRunTotal === undefined
            ? null
            : Number.parseInt(seasonHomeRunTotal, 10);
        const targetHomeRuns = Number.isInteger(suppliedTotal) && suppliedTotal >= 0
            ? suppliedTotal
            : await this.getPlayerHomeRuns(playerId);
        const existingParkIds = Object.keys(playerData.homeRunParks)
            .filter(id =>
                playerData.authoritativeSnapshotInitialized &&
                playerData.authoritativeHomeRunIds.has(id) &&
                this.isCurrentParkAnalysisRecord(playerData.homeRunParks[id])
            );

        if (targetHomeRuns === null || targetHomeRuns <= 0 || existingParkIds.length >= targetHomeRuns) {
            return {
                seasonHomeRunTotal: targetHomeRuns,
                analyzedHomeRunTotal: existingParkIds.length,
                updatedHomeRuns: 0
            };
        }

        this.log(`${playerData.name}: backfilling park data (${existingParkIds.length}/${targetHomeRuns} HR analyzed)`);

        const reconstructionTarget = Math.min(
            targetHomeRuns,
            existingParkIds.length + this.backfillBatchSize
        );
        const allHomeRunDetails = this.sortHomeRunDetailsChronologically(
            await this.getRecentHomeRunDetails(playerId, reconstructionTarget)
        );
        if (jobSeason !== this.currentSeason ||
            this.inventoryReconciliationPlayerIds.has(reconciliationPlayerId)) {
            return {
                seasonHomeRunTotal: targetHomeRuns,
                analyzedHomeRunTotal: existingParkIds.length,
                updatedHomeRuns: 0,
                aborted: 'season-rollover'
            };
        }

        let updatedHomeRuns = 0;
        let attempted = 0;
        for (const hrDetail of allHomeRunDetails) {
            if (jobSeason !== this.currentSeason ||
                this.shuttingDown ||
                this.inventoryReconciliationPlayerIds.has(reconciliationPlayerId)) {
                break;
            }
            if (attempted >= this.backfillBatchSize) break;
            if (this.isFallbackHomeRunDetail(hrDetail) || !hrDetail?.gameId) {
                continue;
            }

            const candidateHrId = this.buildHomeRunId(hrDetail, playerId);
            if (!playerData.authoritativeSnapshotInitialized ||
                !playerData.authoritativeHomeRunIds.has(candidateHrId)) {
                continue;
            }
            const hrId = this.reconcileHomeRunAliases(playerId, playerData, hrDetail);
            if (this.isCurrentParkAnalysisRecord(playerData.homeRunParks[hrId])) {
                continue;
            }
            attempted++;

            let analysisResult = null;
            const backfillAnalysisId = `${hrId}:backfill`;
            try {
                const statcastData = await this.getStatcastDataForHR(playerId, hrDetail);
                if (!statcastData ||
                    this.inventoryReconciliationPlayerIds.has(reconciliationPlayerId)) {
                    continue;
                }

                analysisResult = await this.runHRAnalysis(
                    statcastData,
                    playerData.name,
                    playerId,
                    backfillAnalysisId
                );
                if (jobSeason === this.currentSeason &&
                    !this.inventoryReconciliationPlayerIds.has(reconciliationPlayerId) &&
                    playerData.authoritativeHomeRunIds.has(hrId) &&
                    this.isUsableAnalysisResult(analysisResult, statcastData)) {
                    playerData.homeRunParks[hrId] =
                        this.buildParkAnalysisRecord(analysisResult, statcastData);
                    updatedHomeRuns++;
                }
            } catch (error) {
                this.log(`Could not backfill park data for ${playerData.name} HR ${hrId}: ${error.message}`);
            } finally {
                if (analysisResult?.temp_directory) {
                    this.cleanupAnalysisArtifacts(analysisResult.temp_directory);
                }
                const cacheKey = [...this.analysisCache.keys()]
                    .find(key => key.endsWith(`:${backfillAnalysisId}`));
                if (cacheKey) this.analysisCache.delete(cacheKey);
            }
        }

        if (jobSeason !== this.currentSeason) {
            return {
                seasonHomeRunTotal: targetHomeRuns,
                analyzedHomeRunTotal: existingParkIds.length,
                updatedHomeRuns: 0,
                aborted: 'season-rollover'
            };
        }
        if (updatedHomeRuns > 0) {
            this.saveState({ throwOnError: true });
        }

        const analyzedHomeRunTotal = Object.values(playerData.homeRunParks)
            .filter(value => this.isCurrentParkAnalysisRecord(value)).length;
        this.log(`${playerData.name}: park data now available for ${analyzedHomeRunTotal}/${targetHomeRuns} HR`);

        return {
            seasonHomeRunTotal: targetHomeRuns,
            analyzedHomeRunTotal,
            updatedHomeRuns,
            remaining: Math.max(0, targetHomeRuns - analyzedHomeRunTotal)
        };
    }

    async sendParksBreakdown(message, playerName = null) {
        try {
            if (playerName) {
                const resolution = this.resolvePlayerByName(playerName);
                const playerId = resolution.playerId;
                if (!playerId) {
                    await message.reply(this.formatPlayerResolutionError(playerName, resolution));
                    return;
                }

                const playerData = this.players[playerId];
                const snapshot = await this.getPlayerStatsForDisplay(playerId);
                const seasonHomeRunTotal = this.getSeasonHomeRunTotal(snapshot.stats);
                const backfillStatus = this.queuePlayerParkBackfill(playerId, seasonHomeRunTotal);
                const breakdown = this.getParksBreakdown(playerData.homeRunParks || {});
                const notes = [];
                if (snapshot.stale && snapshot.stats) {
                    notes.push(
                        `MLB is unavailable; the season total is cached (${this.formatSnapshotAge(snapshot.fetchedAt)}).`
                    );
                }
                const backfillText = this.formatParkBackfillStatus(backfillStatus);
                if (backfillText) notes.push(backfillText);
                const text = [
                    this.formatParksBreakdown(playerData.name, breakdown, seasonHomeRunTotal),
                    ...notes
                ].join('\n\n');

                const embed = new Discord.EmbedBuilder()
                    .setTitle(`${playerData.name} — ${this.currentSeason} Parks Breakdown`)
                    .setDescription(text)
                    .setColor('#132448')
                    .setTimestamp();

                const thumbnail = this.getPlayerHeadshotUrlById(playerId);
                if (thumbnail) {
                    embed.setThumbnail(thumbnail);
                }

                await message.reply({ embeds: [embed] });
                return;
            }

            // All players
            const sections = [];
            const playerEntries = Object.entries(this.players);
            const snapshots = await Promise.all(
                playerEntries.map(([playerId]) => this.getPlayerStatsForDisplay(playerId))
            );
            for (let index = 0; index < playerEntries.length; index++) {
                const [, playerData] = playerEntries[index];
                const snapshot = snapshots[index];
                const seasonHomeRunTotal = this.getSeasonHomeRunTotal(snapshot.stats);
                const breakdown = this.getParksBreakdown(playerData.homeRunParks || {});
                const availabilityNote = snapshot.stale && snapshot.stats
                    ? `\nCached total (${this.formatSnapshotAge(snapshot.fetchedAt)}).`
                    : (snapshot.stats ? '' : '\nLive total unavailable; no cached total.');
                sections.push(
                    `${this.formatParksBreakdown(playerData.name, breakdown, seasonHomeRunTotal)}${availabilityNote}`
                );
            }
            const analysisNote = this.analysisPermanentlyUnavailable
                ? 'Verified park projections are disabled pending geometry calibration.'
                : null;

            const embed = new Discord.EmbedBuilder()
                .setTitle(`${this.currentSeason} Parks Breakdown — All Players`)
                .setDescription(
                    [analysisNote, ...sections].filter(Boolean).join('\n\n')
                )
                .setColor('#132448')
                .setTimestamp()
                .setFooter({
                    text: 'Counts include only the current verified analysis version'
                });

            await message.reply({ embeds: [embed] });
        } catch (error) {
            this.logEvent('error', 'parks_command_failed', { error: error.message });
            await message.reply('Had trouble pulling parks breakdown data.');
        }
    }

    async sendPlayerStats(playerId, message) {
        try {
            const playerData = this.players[playerId];
            const snapshot = await this.getPlayerStatsForDisplay(playerId);
            const stats = snapshot.stats;

            if (!stats) {
                await message.reply(
                    `MLB stats for ${playerData.name} are unavailable, and the bot has no cached season snapshot to show.`
                );
                return;
            }

            const seasonHomeRunTotal = this.getSeasonHomeRunTotal(stats);
            const backfillStatus = this.queuePlayerParkBackfill(playerId, seasonHomeRunTotal);
            const parksBreakdown = this.getParksBreakdown(playerData.homeRunParks || {});
            const backfillText = this.formatParkBackfillStatus(backfillStatus);
            const parksBreakdownText = [
                ...this.buildParksBreakdownLines(parksBreakdown, seasonHomeRunTotal),
                ...(backfillText ? [backfillText] : [])
            ].join('\n');

            const embed = new Discord.EmbedBuilder()
                .setTitle(`${playerData.name} ${this.currentSeason} Stats`)
                .addFields(
                    { name: '⚾ Hitting', value: `**AVG:** ${this.formatStatValue(stats.avg)} | **HR:** ${this.formatStatValue(stats.homeRuns)} | **RBI:** ${this.formatStatValue(stats.rbi)} | **R:** ${this.formatStatValue(stats.runs)}`, inline: false },
                    { name: '📊 Advanced', value: `**OBP:** ${this.formatStatValue(stats.obp)} | **SLG:** ${this.formatStatValue(stats.slg)} | **OPS:** ${this.formatStatValue(stats.ops)}`, inline: false },
                    { name: '🏃 Other', value: `**H:** ${this.formatStatValue(stats.hits)} | **AB:** ${this.formatStatValue(stats.atBats)} | **SB:** ${this.formatStatValue(stats.stolenBases)} | **SO:** ${this.formatStatValue(stats.strikeOuts)} | **BB:** ${this.formatStatValue(stats.baseOnBalls)}`, inline: false },
                    { name: '🏟️ Parks Breakdown', value: parksBreakdownText, inline: false },
                    { name: '🤖 Bot Tracking', value: `**Last Checked:** ${this.players[playerId].lastCheckedHR} HR`, inline: false }
                )
                .setColor('#132448')
                .setTimestamp()
                .setFooter({
                    text: snapshot.stale
                        ? `Cached MLB snapshot (${this.formatSnapshotAge(snapshot.fetchedAt)}) | Team: ${playerData.team} | #${playerData.number}`
                        : `Live MLB data | Team: ${playerData.team} | #${playerData.number}`
                });

            const statsThumbnail = this.getPlayerHeadshotUrlById(playerId);
            if (statsThumbnail) {
                embed.setThumbnail(statsThumbnail);
            }

            await message.reply({ embeds: [embed] });
        } catch (error) {
            this.logEvent('error', 'player_stats_command_failed', {
                playerId,
                error: error.message
            });
            await message.reply('Sorry, I had trouble getting the stats right now!');
        }
    }

    async sendTrackedPlayers(message) {
        const playerList = Object.values(this.players)
            .map(player => `• ${player.name} (${player.team} #${player.number})`)
            .join('\n');
        const shortcutCommands = [...this.getPlayerShortcutCommands().keys()].sort().join(', ');

        const embed = new Discord.EmbedBuilder()
            .setTitle('📊 Tracked Players')
            .setDescription(`Currently monitoring these players for home runs:\n\n${playerList}`)
            .addFields(
                { name: 'Player Commands', value: shortcutCommands || 'No unique shortcut commands configured', inline: false },
                { name: 'General Commands', value: '!hrstats, !parkstats, !players', inline: false },
                { name: 'Admin Commands', value: '!forcecheck, !testhr, !reset [player], !debug', inline: false },
                { name: 'Alert Channels', value: `Sending to ${this.channelIds.length} channel(s)`, inline: false }
            )
            .setColor('#132448')
            .setTimestamp();

        await message.reply({ embeds: [embed] });
    }

    async sendAllHomeRunStats(message) {
        try {
            const hrStats = await Promise.all(
                Object.entries(this.players).map(async ([playerId, playerData]) => {
                    const snapshot = await this.getPlayerStatsForDisplay(playerId);
                    return {
                        name: playerData.name,
                        team: playerData.team,
                        homeRuns: this.getSeasonHomeRunTotal(snapshot.stats),
                        tracked: playerData.lastCheckedHR,
                        stale: snapshot.stale && Boolean(snapshot.stats),
                        fetchedAt: snapshot.fetchedAt
                    };
                })
            );

            hrStats.sort((a, b) => {
                if (a.homeRuns === null && b.homeRuns !== null) return 1;
                if (a.homeRuns !== null && b.homeRuns === null) return -1;
                if (a.homeRuns !== b.homeRuns) return (b.homeRuns || 0) - (a.homeRuns || 0);
                return a.name.localeCompare(b.name);
            });

            const statsText = hrStats
                .map((player, index) => {
                    const total = player.homeRuns === null
                        ? 'Unavailable'
                        : `${player.homeRuns} HR${player.stale ? ` (cached, ${this.formatSnapshotAge(player.fetchedAt)})` : ''}`;
                    return `${index + 1}. ${player.name} (${player.team}): ${total} (tracking: ${player.tracked})`;
                })
                .join('\n');

            const embed = new Discord.EmbedBuilder()
                .setTitle(`🏆 ${this.currentSeason} Home Run Leaderboard`)
                .setDescription(statsText)
                .setColor('#FFD700')
                .setTimestamp()
                .setFooter({ text: 'Numbers in parentheses show what the bot last recorded' });

            await message.reply({ embeds: [embed] });
        } catch (error) {
            this.logEvent('error', 'leaderboard_command_failed', { error: error.message });
            await message.reply('Sorry, I had trouble getting the home run stats!');
        }
    }

    async sendTestHomeRunAlert(message) {
        try {
            // Pick a random player for the test
            const playerIds = Object.keys(this.players);
            const randomPlayerId = playerIds[Math.floor(this.random() * playerIds.length)];
            const playerData = this.players[randomPlayerId];

            // Create sample home run data
            const sampleDistances = ['415 ft', '438 ft', '462 ft', '395 ft', '441 ft', '478 ft'];
            const sampleRBIs = [1, 2, 3, 4];
            const sampleHRTypes = ['Solo HR', '2-run HR', '3-run HR', 'Grand Slam!'];

            const randomDistance = sampleDistances[Math.floor(this.random() * sampleDistances.length)];
            const randomRBI = sampleRBIs[Math.floor(this.random() * sampleRBIs.length)];
            const randomHRType = sampleHRTypes[randomRBI - 1];

            const testDetails = {
                distance: randomDistance,
                rbi: randomRBI,
                rbiDescription: randomHRType
            };

            // Create the embed for test (only send to current channel)
            const hrType = testDetails.rbiDescription || 'Solo HR';
            const titleText = hrType === 'Grand Slam!' ?
                `${playerData.name.toUpperCase()} GRAND SLAM!` :
                `${playerData.name.toUpperCase()} ${hrType.toUpperCase().replace(' HR', ' HOME RUN')}!`;

            // Parse distance for nuke check
            let isNuke = false;
            if (randomDistance) {
                const match = randomDistance.match(/(\d+)/);
                if (match) {
                    const distanceNum = parseInt(match[1]);
                    isNuke = distanceNum > 440;
                }
            }

            // Always use singular description
            let description = `${playerData.name} just hit a home run!`;
            if (isNuke) {
                description = `${playerData.name} just launched a massive home run!`;
            }

            const embed = new Discord.EmbedBuilder()
                .setTitle(titleText)
                .setDescription(description)
                .addFields(this.buildInitialAlertFields(
                    playerData,
                    `${Math.floor(this.random() * 40) + 10}`,
                    hrType,
                    testDetails.distance
                ))
                .setColor('#132448')
                .setTimestamp();

            const testThumbnail = this.getPlayerHeadshotUrlById(randomPlayerId);
            if (testThumbnail) {
                embed.setThumbnail(testThumbnail);
            }

            // Send only to the current channel where the command was issued
            await message.channel.send({ embeds: [embed] });

            await message.reply(`🧪 Test alert sent to this channel for ${playerData.name}!`);
        } catch (error) {
            this.log(`Error sending test message: ${error.message}`);
            await message.reply('Sorry, I had trouble sending the test alert!');
        }
    }

    scheduleFatalShutdown(reason, error = null) {
        if (this.fatalShutdownPromise) return this.fatalShutdownPromise;
        this.processRef.exitCode = 1;
        this.logEvent('fatal', 'fatal_shutdown_scheduled', {
            reason,
            error: error?.message || null
        });
        this.fatalShutdownPromise = Promise.resolve()
            .then(() => this.shutdown(reason))
            .catch(shutdownError => {
                this.logEvent('fatal', 'fatal_shutdown_failed', {
                    reason,
                    error: shutdownError.message
                });
            });
        return this.fatalShutdownPromise;
    }

    destroyDiscordClient() {
        if (this.discordDestroyed) return;
        this.discordDestroyed = true;
        try {
            this.client.destroy();
        } catch (error) {
            this.logEvent('warn', 'discord_destroy_failed', {
                error: error.message
            });
        }
    }

    finalizeShutdown(reason, timedOut) {
        if (this.shutdownFinalizePromise) {
            return this.shutdownFinalizePromise;
        }
        this.shutdownFinalizePromise = (async () => {
            try {
                this.saveState({ throwOnError: true });
            } catch (error) {
                this.processRef.exitCode = 1;
                this.logEvent('error', 'shutdown_state_save_failed', {
                    error: error.message
                });
            }

            for (const directory of [...this.activeTempDirectories]) {
                this.cleanupAnalysisArtifacts(directory);
            }
            this.destroyDiscordClient();
            this.releaseStateLease();
            if (this.removeProcessHandlers) {
                this.removeProcessHandlers();
                this.removeProcessHandlers = null;
            }
            this.logEvent('info', 'shutdown_completed', { reason, timedOut });
        })();
        return this.shutdownFinalizePromise;
    }

    async shutdown(reason = 'shutdown') {
        if (this.shutdownPromise) return this.shutdownPromise;
        this.shuttingDown = true;
        this.shutdownPromise = (async () => {
            this.logEvent('info', 'shutdown_started', { reason });
            if (this.monitorTask) {
                clearTimeout(this.monitorTask);
                this.monitorTask = null;
            }
            if (this.enrichmentWakeTimer) {
                clearTimeout(this.enrichmentWakeTimer);
                this.enrichmentWakeTimer = null;
            }

            for (const release of this.analysisQueue.splice(0)) {
                release();
            }
            this.enrichmentQueue.length = 0;
            this.destroyDiscordClient();

            const activeWork = () => [...new Set([
                ...(this.checkInProgress ? [this.checkInProgress] : []),
                ...this.backgroundJobs
            ])];
            const deadline = Date.now() + this.shutdownTimeoutMs;
            let timedOut = false;
            while (activeWork().length > 0 && Date.now() < deadline) {
                const remainingMs = Math.max(1, deadline - Date.now());
                let timeoutHandle;
                const outcome = await Promise.race([
                    Promise.allSettled(activeWork()).then(() => 'settled'),
                    new Promise(resolve => {
                        timeoutHandle = setTimeout(() => resolve('timeout'), remainingMs);
                    })
                ]);
                if (timeoutHandle) clearTimeout(timeoutHandle);
                if (outcome === 'timeout') {
                    timedOut = true;
                    break;
                }
            }
            if (timedOut) {
                this.processRef.exitCode = 1;
                const remainingWork = activeWork();
                this.logEvent('warn', 'shutdown_work_timeout', {
                    activeJobs: remainingWork.length,
                    timeoutMs: this.shutdownTimeoutMs
                });
                void (async () => {
                    while (activeWork().length > 0) {
                        await Promise.allSettled(activeWork());
                    }
                    await this.finalizeShutdown(reason, true);
                })()
                    .catch(error => {
                        this.logEvent('fatal', 'deferred_shutdown_finalize_failed', {
                            reason,
                            error: error.message
                        });
                    });
                return;
            }
            await this.finalizeShutdown(reason, false);
        })();
        return this.shutdownPromise;
    }
}

function buildBot(config, options = {}) {
    if (!config || typeof config !== 'object') {
        throw new Error('A parsed bot configuration is required');
    }
    return new BaseballBot(config.token, config.channelIds, {
        ...config,
        ...options
    });
}

function installProcessHandlers(bot, processRef = process) {
    const signalHandlers = new Map(
        ['SIGTERM', 'SIGINT'].map(signal => [
            signal,
            () => {
                void bot.shutdown(signal).catch(error => {
                    processRef.exitCode = 1;
                    bot.logEvent('fatal', 'signal_shutdown_failed', { signal, error: error.message });
                });
            }
        ])
    );
    const handleUnhandledRejection = reason => {
        const error = reason instanceof Error ? reason : new Error(String(reason));
        bot.logEvent('fatal', 'unhandled_rejection', { error: error.message });
        bot.scheduleFatalShutdown('unhandled-rejection', error);
    };
    const handleUncaughtException = error => {
        bot.logEvent('fatal', 'uncaught_exception', { error: error?.message || String(error) });
        bot.scheduleFatalShutdown('uncaught-exception', error);
    };

    for (const [signal, handler] of signalHandlers) {
        processRef.on(signal, handler);
    }
    processRef.on('unhandledRejection', handleUnhandledRejection);
    processRef.on('uncaughtException', handleUncaughtException);
    return () => {
        for (const [signal, handler] of signalHandlers) {
            processRef.removeListener(signal, handler);
        }
        processRef.removeListener('unhandledRejection', handleUnhandledRejection);
        processRef.removeListener('uncaughtException', handleUncaughtException);
    };
}

async function start(config = parseConfig(), options = {}) {
    const bot = buildBot(config, options);
    bot.removeProcessHandlers = installProcessHandlers(bot, options.processRef || process);
    let readyTimeout;
    try {
        const initializePromise = bot.initialize();
        const gatewayStartup = initializePromise.then(
            () => bot.gatewayReadyPromise
        );
        const timeout = new Promise((resolve, reject) => {
            readyTimeout = setTimeout(() => {
                reject(new Error(
                    `Discord gateway did not become ready within ${bot.readyTimeoutMs}ms`
                ));
            }, bot.readyTimeoutMs);
        });
        await Promise.race([gatewayStartup, timeout]);
        if (readyTimeout) {
            clearTimeout(readyTimeout);
            readyTimeout = null;
        }
        await initializePromise;
        await bot.readyPromise;
        return bot;
    } catch (error) {
        bot.processRef.exitCode = 1;
        bot.logEvent('fatal', 'startup_failed', { error: error.message });
        await bot.shutdown('startup-failed');
        throw error;
    } finally {
        if (readyTimeout) clearTimeout(readyTimeout);
    }
}

function loadRuntimeEnvironment({
    environment = process.env,
    environmentPath = path.join(__dirname, '.env'),
    fileSystem = fs,
} = {}) {
    const requiredConfigurationIsInjected =
        String(environment.BOT_TOKEN || '').trim() !== '' &&
        String(environment.CHANNEL_ID || '').trim() !== '';
    return loadEnvironmentFile(environmentPath, environment, {
        fileSystem,
        ignoreAccessErrors: requiredConfigurationIsInjected,
    });
}

async function runMain() {
    loadRuntimeEnvironment();
    return start();
}

module.exports = {
    BaseballBot,
    STATE_VERSION,
    buildBot,
    installProcessHandlers,
    loadRuntimeEnvironment,
    parseConfig,
    parseCsvIds,
    resolveStatePath,
    start,
    validateStateDocument
};

if (require.main === module) {
    runMain().catch(error => {
        console.error(JSON.stringify({
            timestamp: new Date().toISOString(),
            level: 'fatal',
            event: 'startup_failed',
            error: error.message
        }));
        process.exitCode = 1;
    });
}
