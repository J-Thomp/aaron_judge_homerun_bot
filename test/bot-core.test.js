'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    BaseballBot,
    STATE_VERSION,
    loadRuntimeEnvironment,
    parseConfig,
    start,
    validateStateDocument,
} = require('../bot');
const { parseEnvironmentFile } = require('../scripts/environment');
const { validateStatePath } = require('../scripts/preflight');

const CHANNEL_A = '123456789012345678';
const CHANNEL_B = '223456789012345678';
const ADMIN_ID = '323456789012345678';
const GUILD_ID = '423456789012345678';
const FIXED_NOW = new Date('2026-07-28T12:00:00.000Z');
let botCounter = 0;

function fakeClient() {
    return {
        channels: {
            fetch: async () => {
                throw new Error('Unexpected Discord access in an offline unit test');
            },
        },
        user: null,
        once() {},
        on() {},
        async login() {},
        destroy() {},
    };
}

function makeBot(options = {}) {
    const {
        channelIds = [CHANNEL_A, CHANNEL_B],
        ...botOptions
    } = options;
    botCounter += 1;
    const bot = new BaseballBot('test-token', channelIds, {
        client: fakeClient(),
        clock: () => new Date(FIXED_NOW),
        disableStateLock: true,
        statePath: path.join(
            os.tmpdir(),
            'home-run-bot-unit-state',
            `${process.pid}-${botCounter}.json`
        ),
        ...botOptions,
    });
    bot.logEvent = () => {};
    return bot;
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function confirmedDetails(
    bot,
    playerId,
    count,
    { gameBase = 700000, atBatBase = 10 } = {}
) {
    return Array.from({ length: count }, (_, index) =>
        bot.createHomeRunDetail({
            playerId: String(playerId),
            season: bot.currentSeason,
            gameId: String(gameBase + index),
            gameDate: `2026-06-${String(index + 1).padStart(2, '0')}`,
            gameHomeRunIndex: 1,
            atBatIndex: atBatBase + index,
        })
    );
}

function keepOnlyPlayer(bot, playerId) {
    bot.players = { [playerId]: bot.players[playerId] };
    return bot.players[playerId];
}

function enableVerifiedAnalysis(bot) {
    bot.analysisAvailable = true;
    bot.analysisPermanentlyUnavailable = false;
    bot.ballparkDataVersion = 'fixture-source-hash';
    bot.ballparkMetadataVersion = 'fixture-metadata-v1';
}

test('runtime and helper scripts share Node environment-file parsing', () => {
    const parsed = parseEnvironmentFile([
        'export BOT_TOKEN="token # retained"',
        'STATE_PATH=runtime/state.json # ignored comment',
        "PYTHON_BIN='C:\\\\Python 3.13\\\\python.exe'",
    ].join('\n'));

    assert.equal(parsed.BOT_TOKEN, 'token # retained');
    assert.equal(parsed.STATE_PATH, 'runtime/state.json');
    assert.equal(parsed.PYTHON_BIN, 'C:\\\\Python 3.13\\\\python.exe');
});

test('runtime tolerates a root-only environment file after systemd injects required values', () => {
    const accessDenied = new Error('permission denied');
    accessDenied.code = 'EACCES';
    const deniedFileSystem = {
        existsSync: () => true,
        readFileSync: () => {
            throw accessDenied;
        },
    };
    const injectedEnvironment = {
        BOT_TOKEN: 'injected-token',
        CHANNEL_ID: CHANNEL_A,
    };

    assert.equal(
        loadRuntimeEnvironment({
            environment: injectedEnvironment,
            environmentPath: '/opt/home-run-bot/.env',
            fileSystem: deniedFileSystem,
        }),
        false
    );
    assert.throws(
        () => loadRuntimeEnvironment({
            environment: {},
            environmentPath: '/opt/home-run-bot/.env',
            fileSystem: deniedFileSystem,
        }),
        error => error === accessDenied
    );
});

test('configuration validates and deduplicates Discord IDs while resolving runtime controls', () => {
    const configRoot = path.join(os.tmpdir(), 'home-run-bot-config-test');
    const config = parseConfig({
        BOT_TOKEN: '  secret-token  ',
        CHANNEL_ID: `${CHANNEL_A}, ${CHANNEL_A},${CHANNEL_B}`,
        ADMIN_USER_IDS: `${ADMIN_ID},${ADMIN_ID}`,
        ALLOWED_GUILD_IDS: GUILD_ID,
        STATE_PATH: path.join('runtime', 'state.json'),
        HTTP_TIMEOUT_MS: '2500',
        HTTP_RETRIES: '0',
        BACKFILL_BATCH_SIZE: '7',
        POLL_INTERVAL_MS: '30000',
        OFFSEASON_POLL_INTERVAL_MS: '60000',
        POLL_JITTER_MS: '0',
    }, { cwd: configRoot });

    assert.equal(config.token, 'secret-token');
    assert.deepEqual(config.channelIds, [CHANNEL_A, CHANNEL_B]);
    assert.deepEqual(config.adminUserIds, [ADMIN_ID]);
    assert.deepEqual(config.allowedGuildIds, [GUILD_ID]);
    assert.equal(config.statePath, path.resolve(configRoot, 'runtime', 'state.json'));
    assert.equal(config.httpTimeoutMs, 2500);
    assert.equal(config.httpRetries, 0);
    assert.equal(config.backfillBatchSize, 7);
    assert.equal(config.backfillLimit, 7);
    assert.equal(config.pollIntervalMs, 30000);
    assert.equal(config.offseasonPollIntervalMs, 60000);
    assert.equal(config.pollJitterMs, 0);

    assert.throws(
        () => parseConfig({ BOT_TOKEN: 'token', CHANNEL_ID: 'not-a-snowflake' }),
        /invalid Discord ID/
    );
    assert.throws(
        () => parseConfig({ CHANNEL_ID: CHANNEL_A }),
        /BOT_TOKEN is required/
    );
    assert.throws(
        () => parseConfig({
            BOT_TOKEN: 'token',
            CHANNEL_ID: CHANNEL_A,
            HTTP_TIMEOUT_MS: 'not-a-number',
        }),
        /HTTP_TIMEOUT_MS/
    );
    assert.throws(
        () => parseConfig({
            BOT_TOKEN: 'token',
            CHANNEL_ID: CHANNEL_A,
            POLL_INTERVAL_MS: '29999',
        }),
        /POLL_INTERVAL_MS/
    );
});

test('preflight requires the state file parent to support atomic replacement', () => {
    const statePath = path.resolve(os.tmpdir(), 'read-only-state', 'state.json');
    const stateDirectory = path.dirname(statePath);
    const successMessages = [];
    const errorMessages = [];
    const fakeFileSystem = {
        constants: fs.constants,
        existsSync(candidate) {
            return candidate === statePath || candidate === stateDirectory;
        },
        statSync(candidate) {
            return {
                isFile: () => candidate === statePath,
                isDirectory: () => candidate === stateDirectory,
            };
        },
        accessSync(candidate, mode) {
            if (candidate === stateDirectory &&
                mode === (fs.constants.W_OK | fs.constants.X_OK)) {
                const error = new Error('parent directory is read-only');
                error.code = 'EACCES';
                throw error;
            }
        },
    };

    validateStatePath({
        fileSystem: fakeFileSystem,
        environment: { STATE_PATH: statePath },
        currentDirectory: os.tmpdir(),
        successMessages,
        errorMessages,
    });

    assert.deepEqual(successMessages, []);
    assert.equal(errorMessages.length, 1);
    assert.match(errorMessages[0], /STATE_PATH parent directory is read-only/);
});

test('preflight accepts a readable state file when its parent can atomically replace it', () => {
    const statePath = path.resolve(os.tmpdir(), 'readable-state', 'state.json');
    const stateDirectory = path.dirname(statePath);
    const successMessages = [];
    const errorMessages = [];
    const accessCalls = [];
    const fakeFileSystem = {
        constants: fs.constants,
        existsSync(candidate) {
            return candidate === statePath || candidate === stateDirectory;
        },
        statSync(candidate) {
            return {
                isFile: () => candidate === statePath,
                isDirectory: () => candidate === stateDirectory,
            };
        },
        accessSync(candidate, mode) {
            accessCalls.push([candidate, mode]);
        },
    };

    validateStatePath({
        fileSystem: fakeFileSystem,
        environment: { STATE_PATH: statePath },
        currentDirectory: os.tmpdir(),
        successMessages,
        errorMessages,
    });

    assert.deepEqual(errorMessages, []);
    assert.equal(successMessages.length, 1);
    assert.deepEqual(accessCalls, [
        [statePath, fs.constants.R_OK],
        [stateDirectory, fs.constants.W_OK | fs.constants.X_OK],
    ]);
});

test('constructor deduplicates channels and rejects invalid destinations', () => {
    const bot = makeBot({ channelIds: [CHANNEL_A, CHANNEL_A, CHANNEL_B] });
    assert.deepEqual(bot.channelIds, [CHANNEL_A, CHANNEL_B]);

    assert.throws(
        () => makeBot({ channelIds: ['invalid'] }),
        /valid Discord channel ID/
    );
});

test('stable event IDs reconcile legacy aliases without losing per-channel delivery', () => {
    const bot = makeBot();
    enableVerifiedAnalysis(bot);
    const playerId = '592450';
    const playerData = bot.players[playerId];
    const legacyId = '777001_2026-07-28_placeholder_1';
    const parkRecord = {
        parksCleared: 20,
        parksEvaluated: 29,
        parksExpected: 30,
        analysisStatus: 'partial',
        sourceDataHash: bot.ballparkDataVersion,
        ballparkDataVersion: bot.ballparkMetadataVersion,
    };

    bot.ensurePlayerDeliveryState(playerData);
    for (const channelId of bot.channelIds) {
        playerData.sentHomeRunsByChannel[channelId].add(legacyId);
        playerData.alertMessagesByChannel[channelId][legacyId] = {
            messageId: `message-${channelId}`,
            basicSentAt: FIXED_NOW.toISOString(),
        };
    }
    playerData.homeRunParks[legacyId] = parkRecord;

    const detail = bot.createHomeRunDetail({
        playerId,
        season: 2026,
        gameId: '777001',
        gameDate: '2026-07-28',
        gameHomeRunIndex: 1,
        atBatIndex: 42,
    });
    const canonicalId = bot.reconcileHomeRunAliases(playerId, playerData, detail);

    assert.equal(canonicalId, 'hr:2026:592450:777001:ab:42');
    assert.equal(playerData.eventAliases[legacyId], canonicalId);
    assert.equal(playerData.homeRunParks[canonicalId], parkRecord);
    assert.equal(Object.hasOwn(playerData.homeRunParks, legacyId), false);
    assert.equal(bot.getParksBreakdown(playerData.homeRunParks).total, 1);
    assert.equal(bot.isHomeRunFullySent(playerData, canonicalId), true);
    for (const channelId of bot.channelIds) {
        assert.equal(playerData.sentHomeRunsByChannel[channelId].has(canonicalId), true);
        assert.equal(playerData.sentHomeRunsByChannel[channelId].has(legacyId), false);
        assert.equal(
            Object.hasOwn(playerData.alertMessagesByChannel[channelId], legacyId),
            false
        );
        assert.equal(
            playerData.alertMessagesByChannel[channelId][canonicalId].reconciledFrom,
            legacyId
        );
    }
});

test('per-channel acknowledgements do not mark an event complete prematurely', () => {
    const bot = makeBot();
    const playerData = bot.players['592450'];
    const eventId = 'hr:2026:592450:777001:ab:42';

    bot.markHomeRunSentToChannels(playerData, eventId, [CHANNEL_A]);
    assert.deepEqual(bot.getPendingChannelIdsForHomeRun(playerData, eventId), [CHANNEL_B]);
    assert.equal(bot.isHomeRunFullySent(playerData, eventId), false);

    bot.markHomeRunSentToChannels(playerData, eventId, [CHANNEL_B]);
    assert.deepEqual(bot.getPendingChannelIdsForHomeRun(playerData, eventId), []);
    assert.equal(bot.isHomeRunFullySent(playerData, eventId), true);
});

test('baseline initialization and a single lower observation cannot regress a checkpoint', async () => {
    const bot = makeBot();
    const playerId = '592450';
    const playerData = bot.players[playerId];
    bot.players = { [playerId]: playerData };
    bot.saveState = () => true;

    let officialTotal = 12;
    bot.getPlayerHomeRunTotal = async () => officialTotal;
    bot.getRecentHomeRunDetails = async (_playerId, total) =>
        confirmedDetails(bot, playerId, total);

    await bot.checkForNewHomeRuns();
    assert.equal(playerData.checkpointInitialized, true);
    assert.equal(playerData.lastCheckedHR, 12);

    officialTotal = 11;
    await bot.checkForNewHomeRuns();
    assert.equal(playerData.lastCheckedHR, 12);
    assert.deepEqual(playerData.lowerTotalObservation, { value: 11, count: 1 });
});

test('HTTP policy retries transient failures, honors Retry-After, and times out', async () => {
    let attempts = 0;
    const delays = [];
    const retryBot = makeBot({
        sleep: async delay => {
            delays.push(delay);
        },
        fetch: async () => {
            attempts += 1;
            if (attempts === 1) {
                return new Response('{}', {
                    status: 429,
                    headers: {
                        'content-type': 'application/json',
                        'retry-after': '0',
                    },
                });
            }
            return new Response('{"ok":true}', {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        },
    });

    assert.equal(retryBot.isRetryableHttpError({ status: 429 }), true);
    assert.equal(retryBot.isRetryableHttpError({ status: 404 }), false);
    assert.equal(retryBot.isRetryableHttpError({ name: 'AbortError' }), true);

    const response = await retryBot.httpGet('https://example.test/data', { retries: 1 });
    assert.deepEqual(response.data, { ok: true });
    assert.equal(attempts, 2);
    assert.deepEqual(delays, [0]);

    const timeoutBot = makeBot({
        fetch: async (_url, { signal }) => new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => {
                const error = new Error('request aborted');
                error.name = 'AbortError';
                reject(error);
            }, { once: true });
        }),
    });
    await assert.rejects(
        timeoutBot.httpGet('https://example.test/slow', {
            retries: 0,
            timeoutMs: 5,
        }),
        error => error?.name === 'AbortError'
    );
});

test('atomic state writes retain a valid backup and recover from a corrupt primary', t => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'home-run-bot-state-'));
    t.after(() => fs.rmSync(tempDirectory, { recursive: true, force: true }));
    const statePath = path.join(tempDirectory, 'state.json');
    const playerId = '592450';
    const bot = makeBot({ statePath });
    const playerData = bot.players[playerId];

    playerData.lastCheckedHR = 3;
    playerData.checkpointInitialized = true;
    assert.equal(bot.saveState({ throwOnError: true }), true);

    playerData.lastCheckedHR = 4;
    assert.equal(bot.saveState({ throwOnError: true }), true);
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).players[playerId].lastCheckedHR, 4);
    assert.equal(
        JSON.parse(fs.readFileSync(`${statePath}.bak`, 'utf8')).players[playerId].lastCheckedHR,
        3
    );

    fs.writeFileSync(statePath, '{"players":', 'utf8');
    const recoveredBot = makeBot({ statePath });
    const restoredPlayers = recoveredBot.loadState();
    assert.equal(restoredPlayers.has(playerId), true);
    assert.equal(recoveredBot.players[playerId].lastCheckedHR, 3);
    assert.deepEqual(
        fs.readdirSync(tempDirectory).filter(fileName => fileName.endsWith('.tmp')),
        []
    );
});

test('manual reset resynchronizes only after a live total and preserves delivery history', async () => {
    const bot = makeBot();
    const playerId = '592450';
    const playerData = bot.players[playerId];
    const eventId = 'hr:2026:592450:777001:ab:42';
    const replies = [];
    let saves = 0;

    playerData.lastCheckedHR = 5;
    playerData.checkpointInitialized = true;
    playerData.homeRunParks[eventId] = {
        parksCleared: 29,
        parksEvaluated: 29,
        analysisStatus: 'partial',
    };
    bot.markHomeRunSentToChannels(playerData, eventId, bot.channelIds);
    const currentDetails = Array.from({ length: 7 }, (_, index) =>
        bot.createHomeRunDetail({
            playerId,
            season: 2026,
            gameId: index === 0 ? '777001' : String(777001 + index),
            gameDate: `2026-07-${String(index + 1).padStart(2, '0')}`,
            gameHomeRunIndex: 1,
            atBatIndex: index === 0 ? 42 : 50 + index,
        })
    );
    bot.getPlayerHomeRunTotal = async () => 7;
    bot.getRecentHomeRunDetails = async () => currentDetails;
    bot.saveState = () => {
        saves += 1;
        return true;
    };

    await bot.resetPlayerHR('judge', {
        reply: async message => {
            replies.push(message);
        },
    });

    assert.equal(playerData.lastCheckedHR, 7);
    assert.equal(playerData.checkpointInitialized, true);
    assert.equal(playerData.baselineHomeRunIds.size, 7);
    assert.equal(playerData.authoritativeHomeRunIds.size, 7);
    assert.equal(bot.isHomeRunFullySent(playerData, eventId), true);
    assert.ok(playerData.homeRunParks[eventId]);
    assert.equal(saves, 1);
    assert.match(replies.at(-1), /historical alerts will not replay/i);

    keepOnlyPlayer(bot, playerId);
    const nextDetails = [
        ...currentDetails,
        bot.createHomeRunDetail({
            playerId,
            season: 2026,
            gameId: '777099',
            gameDate: '2026-07-28',
            gameHomeRunIndex: 1,
            atBatIndex: 99,
        }),
    ];
    bot.getPlayerHomeRunTotal = async () => 8;
    bot.getRecentHomeRunDetails = async () => nextDetails;
    const alerted = [];
    bot.sendInitialAlert = async (
        _playerId,
        currentPlayer,
        _total,
        detail,
        currentEventId,
        channelIds
    ) => {
        alerted.push(currentEventId);
        bot.markHomeRunSentToChannels(
            currentPlayer,
            currentEventId,
            channelIds,
            { hrDetail: detail }
        );
        return { successChannelIds: channelIds, failedChannelIds: [] };
    };

    await bot.checkForNewHomeRuns();

    assert.deepEqual(alerted, [bot.buildHomeRunId(nextDetails.at(-1), playerId)]);
});

test('manual reset schedules a fatal shutdown when its state cannot be persisted', async () => {
    const bot = makeBot({ channelIds: [CHANNEL_A] });
    const replies = [];
    const failures = [];
    bot.getPlayerHomeRunTotal = async () => 0;
    bot.saveState = () => {
        throw new Error('disk unavailable');
    };
    bot.scheduleFatalShutdown = (reason, error) => {
        failures.push({ reason, error });
    };

    await bot.resetPlayerHR('judge', {
        reply: async message => {
            replies.push(message);
        },
    });

    assert.equal(failures.length, 1);
    assert.equal(failures[0].reason, 'manual-resync-persistence-failed');
    assert.match(failures[0].error.message, /disk unavailable/);
    assert.match(replies.at(-1), /error resetting/i);
});

test('park tiers are based on evaluated coverage instead of hard-coded park counts', () => {
    const bot = makeBot();
    enableVerifiedAnalysis(bot);
    const versionFields = {
        sourceDataHash: bot.ballparkDataVersion,
        ballparkDataVersion: bot.ballparkMetadataVersion,
    };
    const breakdown = bot.getParksBreakdown({
        all: { parksCleared: 29, parksEvaluated: 29, analysisStatus: 'partial', ...versionFields },
        eighty: { parksCleared: 24, parksEvaluated: 29, analysisStatus: 'partial', ...versionFields },
        sixty: { parksCleared: 18, parksEvaluated: 29, analysisStatus: 'partial', ...versionFields },
        forty: { parksCleared: 12, parksEvaluated: 29, analysisStatus: 'partial', ...versionFields },
        under: { parksCleared: 11, parksEvaluated: 29, analysisStatus: 'partial', ...versionFields },
    });

    assert.deepEqual(breakdown, {
        total: 5,
        counts: {
            noDoubter: 1,
            tier80: 1,
            tier60: 1,
            tier40: 1,
            under40: 1,
        },
    });

    const lines = bot.buildParksBreakdownLines(breakdown, 5).join('\n');
    assert.match(lines, /Cleared every evaluated park/);
    assert.match(lines, /Cleared at least 80%/);
    assert.doesNotMatch(lines, /30\/30|\/30 parks/);
});

test('ambiguous player fragments are reported instead of selecting arbitrarily', () => {
    const bot = makeBot();
    const resolution = bot.resolvePlayerByName('a');

    assert.equal(resolution.status, 'ambiguous');
    assert.equal(resolution.playerId, null);
    assert.ok(resolution.candidates.length >= 2);
    assert.match(bot.formatPlayerResolutionError('a', resolution), /ambiguous/i);
});

test('Savant full-metrics fallback selects the exact batter, game, and at-bat', async () => {
    const bot = makeBot({ channelIds: [CHANNEL_A] });
    bot.getGamePlays = async () => {
        throw new Error('play-by-play unavailable');
    };
    bot.getGameMetadata = async () => ({
        venueId: 3313,
        venueName: 'Yankee Stadium',
        homeTeam: 'NYY',
        awayTeam: 'BOS',
    });
    bot.httpGet = async url => {
        assert.match(url, /batters_lookup%5B%5D=592450/);
        assert.match(url, /game_pk=777001/);
        return {
            data: [
                'events,batter,game_pk,at_bat_number,launch_speed,launch_angle,hit_distance,hc_x,hc_y,plate_z,bat_score,post_bat_score,inning_topbot',
                'home_run,999999,777001,8,99,20,350,100,100,2.5,0,1,Top',
                'home_run,592450,777001,7,100,20,380,110,90,2.6,0,1,Top',
                'home_run,592450,777001,8,110,28,430,125,80,2.9,1,3,Bot',
                'home_run,592450,888002,8,120,35,500,130,70,3.0,0,4,Bot',
            ].join('\n'),
        };
    };

    const result = await bot.getStatcastDataForHR('592450', {
        playerId: '592450',
        season: 2026,
        gameId: '777001',
        gameDate: '2026-07-28',
        atBatIndex: 7,
        gameHomeRunIndex: 2,
    });

    assert.equal(result.statcast_source, 'baseball-savant-csv');
    assert.equal(result.game_pk, '777001');
    assert.equal(result.launch_speed, 110);
    assert.equal(result.launch_angle, 28);
    assert.equal(result.hit_distance_sc, 430);
    assert.equal(result.rbi, 2);
    assert.equal(result.rbi_description, '2-run HR');
    assert.equal(result.venue_id, 3313);
    assert.equal(result.pitcher_team, 'BOS');
});

test('state loading fails closed when both the primary and backup are corrupt', t => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'home-run-bot-corrupt-'));
    t.after(() => fs.rmSync(tempDirectory, { recursive: true, force: true }));
    const statePath = path.join(tempDirectory, 'state.json');
    fs.writeFileSync(statePath, '{"players":', 'utf8');
    fs.writeFileSync(`${statePath}.bak`, '{"season":', 'utf8');

    const bot = makeBot({ statePath });
    assert.throws(
        () => bot.loadState(),
        /No valid current state file could be loaded/
    );
});

test('recent and stale state locks both fail closed until explicitly released', t => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'home-run-bot-lock-'));
    t.after(() => fs.rmSync(tempDirectory, { recursive: true, force: true }));
    const statePath = path.join(tempDirectory, 'state.json');
    const lockPath = `${statePath}.lock`;

    fs.writeFileSync(lockPath, 'unreadable lock owner\n', 'utf8');
    const recentTime = FIXED_NOW;
    fs.utimesSync(lockPath, recentTime, recentTime);
    assert.throws(
        () => makeBot({ statePath, disableStateLock: false }).acquireStateLease(),
        /Refusing automatic recovery/
    );

    const staleTime = new Date(FIXED_NOW.getTime() - 60 * 60 * 1000);
    fs.utimesSync(lockPath, staleTime, staleTime);
    assert.throws(
        () => makeBot({ statePath, disableStateLock: false }).acquireStateLease(),
        /Refusing automatic recovery/
    );

    fs.unlinkSync(lockPath);
    const owner = makeBot({ statePath, disableStateLock: false });
    owner.acquireStateLease();
    assert.equal(fs.existsSync(lockPath), true);
    assert.throws(
        () => makeBot({ statePath, disableStateLock: false }).acquireStateLease(),
        /State lease is held/
    );
    owner.releaseStateLease();
    assert.equal(fs.existsSync(lockPath), false);
});

test('ready timeout shuts down and ignores a Discord ready event that arrives late', async t => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'home-run-bot-ready-'));
    t.after(() => fs.rmSync(tempDirectory, { recursive: true, force: true }));
    const processRef = new EventEmitter();
    processRef.exitCode = 0;
    let readyHandler = null;
    let channelFetches = 0;
    let destroyed = false;
    const client = {
        channels: {
            fetch: async () => {
                channelFetches += 1;
                throw new Error('late-ready preflight must not execute');
            },
        },
        user: { tag: 'late#0001', username: 'late' },
        once(_event, handler) {
            readyHandler = handler;
        },
        on() {},
        async login() {},
        destroy() {
            destroyed = true;
        },
    };
    const statePath = path.join(tempDirectory, 'state.json');

    await assert.rejects(
        start({
            token: 'test-token',
            channelIds: [CHANNEL_A],
            adminUserIds: [],
            allowedGuildIds: [],
            statePath,
        }, {
            client,
            processRef,
            clock: () => new Date(FIXED_NOW),
            readyTimeoutMs: 5,
            shutdownTimeoutMs: 5,
        }),
        /Discord gateway did not become ready/
    );

    assert.equal(typeof readyHandler, 'function');
    assert.equal(destroyed, true);
    assert.equal(processRef.exitCode, 1);
    assert.equal(fs.existsSync(`${statePath}.lock`), false);
    assert.equal(processRef.listenerCount('SIGTERM'), 0);
    assert.equal(processRef.listenerCount('SIGINT'), 0);

    readyHandler();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(channelFetches, 0);
});

test('unexpected command failures receive feedback without escaping the event handler', async t => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'home-run-bot-command-'));
    t.after(() => fs.rmSync(tempDirectory, { recursive: true, force: true }));
    const client = new EventEmitter();
    client.channels = {
        fetch: async () => {
            throw new Error('Unexpected Discord access in an offline unit test');
        },
    };
    client.user = null;
    client.login = async () => {};
    client.destroy = () => {};
    const bot = makeBot({
        channelIds: [CHANNEL_A],
        client,
        statePath: path.join(tempDirectory, 'state.json'),
    });
    const logMessages = [];
    const logEvents = [];
    bot.log = message => logMessages.push(message);
    bot.logEvent = (level, event, details) => {
        logEvents.push({ level, event, details });
    };
    bot.handleIncomingMessage = async () => {
        throw new Error('simulated command failure');
    };

    await bot.initialize();

    const replies = [];
    client.emit('messageCreate', {
        guildId: GUILD_ID,
        channelId: CHANNEL_A,
        reply: async message => replies.push(message),
    });
    await Promise.all([...bot.backgroundJobs]);

    assert.deepEqual(replies, [
        'That command could not be completed. The failure was logged; please try again later.',
    ]);
    assert.equal(bot.backgroundJobs.size, 0);
    assert.match(logMessages.at(-1), /simulated command failure/);

    client.emit('messageCreate', {
        guildId: GUILD_ID,
        channelId: CHANNEL_A,
        reply: async () => {
            throw new Error('simulated reply failure');
        },
    });
    await Promise.all([...bot.backgroundJobs]);

    assert.equal(bot.backgroundJobs.size, 0);
    assert.deepEqual(logEvents.at(-1), {
        level: 'warn',
        event: 'command_failure_reply_failed',
        details: {
            guildId: GUILD_ID,
            channelId: CHANNEL_A,
            error: 'simulated reply failure',
        },
    });
});

test('terminal enrichment records unavailability once and removes completed work', async () => {
    const bot = makeBot({
        channelIds: [CHANNEL_A],
        enrichmentMaxAgeMs: 1000,
    });
    const playerId = '592450';
    const hrId = 'hr:2026:592450:777001:ab:42';
    const jobKey = `2026:${playerId}:${hrId}`;
    const record = {
        playerId,
        season: 2026,
        hrId,
        totalHomeRuns: 31,
        hrDetail: {
            playerId,
            season: 2026,
            gameId: '777001',
            gameDate: '2026-07-28',
            atBatIndex: 42,
            gameHomeRunIndex: 1,
        },
        channelIds: [CHANNEL_A],
        createdAt: '2026-07-28T11:00:00.000Z',
        attempts: 0,
    };
    let statcastCalls = 0;
    let deliveredFooter = null;
    bot.getStatcastDataForHR = async () => {
        statcastCalls += 1;
        return null;
    };
    bot.updateEnrichedAlert = async (
        _playerId,
        _playerData,
        _record,
        _channelId,
        _statcastData,
        _analysisResult,
        footerText
    ) => {
        deliveredFooter = footerText;
        bot.getAlertDeliveryRecord(
            bot.players[playerId],
            CHANNEL_A,
            hrId
        ).enrichedAt = FIXED_NOW.toISOString();
        return true;
    };
    bot.saveState = () => true;
    bot.markHomeRunSentToChannels(
        bot.players[playerId],
        hrId,
        [CHANNEL_A],
        {
            basicSentAt: record.createdAt,
            hrDetail: record.hrDetail,
            playerId,
            season: 2026,
            hrId,
        }
    );
    bot.pendingEnrichments.set(jobKey, record);

    await bot.processEnrichment(jobKey, record);

    assert.equal(statcastCalls, 0);
    assert.equal(record.terminalReason, 'statcast-unavailable');
    assert.equal(bot.metrics.enrichmentsTerminal, 1);
    assert.match(deliveredFooter, /no further data retries will run/i);
    assert.equal(bot.pendingEnrichments.has(jobKey), false);
});

test('analysis cleanup tolerates a missing path and an inspection race', () => {
    const tempRoot = path.join(os.tmpdir(), 'home-run-bot-cleanup-race');
    const missingPath = path.join(tempRoot, 'analysis-missing');
    const bot = makeBot({ tempRoot });
    bot.activeTempDirectories.add(path.resolve(missingPath));

    assert.doesNotThrow(() => bot.cleanupAnalysisArtifacts(missingPath));
    assert.equal(bot.activeTempDirectories.has(path.resolve(missingPath)), false);

    bot.activeTempDirectories.add(path.resolve(missingPath));
    bot.fileSystem = {
        ...fs,
        existsSync: () => true,
        statSync: () => {
            const error = new Error('path disappeared');
            error.code = 'ENOENT';
            throw error;
        },
    };
    assert.doesNotThrow(() => bot.cleanupAnalysisArtifacts(missingPath));
    assert.equal(bot.activeTempDirectories.has(path.resolve(missingPath)), false);
});

test('enrichment finalizer does not evict a sibling at-bat cache key', async () => {
    const bot = makeBot({ channelIds: [CHANNEL_A] });
    const ownHrId = 'hr:2026:592450:777001:ab:1';
    const siblingHrId = 'hr:2026:592450:777001:ab:10';
    const ownKey = `geometry:${ownHrId}`;
    const ownArtifactKey = `geometry:${ownHrId}:artifact:0:1`;
    const siblingKey = `geometry:${siblingHrId}`;
    const cleaned = [];
    bot.analysisCache.set(ownKey, Promise.resolve({ temp_directory: 'own-main' }));
    bot.analysisCache.set(ownArtifactKey, Promise.resolve({ temp_directory: 'own-artifact' }));
    bot.analysisCache.set(siblingKey, Promise.resolve({ temp_directory: 'sibling' }));
    bot.cleanupAnalysisArtifacts = directory => {
        cleaned.push(directory);
    };
    bot.processEnrichmentCore = async () => {};

    await bot.processEnrichment('job', { hrId: ownHrId });

    assert.deepEqual(cleaned.sort(), ['own-artifact', 'own-main']);
    assert.equal(bot.analysisCache.has(ownKey), false);
    assert.equal(bot.analysisCache.has(ownArtifactKey), false);
    assert.equal(bot.analysisCache.has(siblingKey), true);
});

test('state version validation accepts legacy state and rejects malformed or newer state', () => {
    const baseState = {
        season: 2026,
        players: {},
    };

    assert.doesNotThrow(() => validateStateDocument({ ...baseState }));
    assert.equal(
        validateStateDocument({
            ...baseState,
            version: STATE_VERSION,
            pendingEnrichments: {},
        }).version,
        STATE_VERSION
    );
    assert.throws(
        () => validateStateDocument({ ...baseState, version: STATE_VERSION + 1 }),
        /unsupported/
    );
    assert.throws(
        () => validateStateDocument({ ...baseState, version: '2' }),
        /unsupported/
    );
    assert.throws(
        () => validateStateDocument({ ...baseState, version: 0 }),
        /unsupported/
    );
});

test('deep semantic state corruption falls back to a valid backup and otherwise fails closed', t => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'home-run-bot-state-deep-'));
    t.after(() => fs.rmSync(tempDirectory, { recursive: true, force: true }));
    const statePath = path.join(tempDirectory, 'state.json');
    const source = makeBot({ channelIds: [CHANNEL_A], statePath });
    const playerId = '592450';
    const eventId = 'hr:2026:592450:700001:ab:10';
    const sourcePlayer = source.players[playerId];
    sourcePlayer.lastCheckedHR = 1;
    sourcePlayer.checkpointInitialized = true;
    sourcePlayer.baselineHomeRunIds = new Set([eventId]);
    sourcePlayer.baselineSnapshotInitialized = true;
    sourcePlayer.authoritativeHomeRunIds = new Set([eventId]);
    sourcePlayer.authoritativeSnapshotInitialized = true;
    sourcePlayer.authoritativeSnapshotCapturedAt = FIXED_NOW.toISOString();
    const validState = source.serializeState();
    const invalidState = structuredClone(validState);
    invalidState.players[playerId].baselineHomeRunIds = [];
    invalidState.players[playerId].authoritativeHomeRunIds = [];

    fs.writeFileSync(statePath, JSON.stringify(invalidState), 'utf8');
    fs.writeFileSync(`${statePath}.bak`, JSON.stringify(validState), 'utf8');

    const recovered = makeBot({ channelIds: [CHANNEL_A], statePath });
    recovered.loadState();
    assert.equal(recovered.players[playerId].lastCheckedHR, 1);
    assert.equal(recovered.players[playerId].baselineHomeRunIds.has(eventId), true);

    fs.writeFileSync(`${statePath}.bak`, JSON.stringify(invalidState), 'utf8');
    assert.throws(
        () => makeBot({ channelIds: [CHANNEL_A], statePath }).loadState(),
        /No valid current state file could be loaded/
    );
});

test('transient correction guards are neither persisted nor restored', t => {
    const tempDirectory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'home-run-bot-transient-state-')
    );
    t.after(() => fs.rmSync(tempDirectory, { recursive: true, force: true }));
    const statePath = path.join(tempDirectory, 'state.json');
    const playerId = '592450';
    const source = makeBot({ channelIds: [CHANNEL_A], statePath });
    const playerData = source.players[playerId];
    const detail = confirmedDetails(source, playerId, 1)[0];
    const eventId = source.buildHomeRunId(detail, playerId);

    playerData.lastCheckedHR = 1;
    playerData.checkpointInitialized = true;
    playerData.baselineHomeRunIds = new Set([eventId]);
    playerData.baselineSnapshotInitialized = true;
    playerData.authoritativeHomeRunIds = new Set([eventId]);
    playerData.authoritativeSnapshotInitialized = true;
    playerData.authoritativeSnapshotCapturedAt = FIXED_NOW.toISOString();
    source.markHomeRunSentToChannels(
        playerData,
        eventId,
        [CHANNEL_A],
        {
            messageId: 'message-1',
            playerId,
            season: 2026,
            hrId: eventId,
            hrDetail: detail,
        }
    );
    const delivery = source.getAlertDeliveryRecord(
        playerData,
        CHANNEL_A,
        eventId
    );
    delivery.retractionInProgress = true;

    const serialized = source.serializeState();
    assert.equal(
        Object.hasOwn(
            serialized.players[playerId]
                .alertMessagesByChannel[CHANNEL_A][eventId],
            'retractionInProgress'
        ),
        false
    );

    serialized.players[playerId]
        .alertMessagesByChannel[CHANNEL_A][eventId]
        .retractionInProgress = true;
    fs.writeFileSync(statePath, JSON.stringify(serialized), 'utf8');

    const restored = makeBot({ channelIds: [CHANNEL_A], statePath });
    restored.loadState();
    const restoredDelivery = restored.getAlertDeliveryRecord(
        restored.players[playerId],
        CHANNEL_A,
        eventId
    );
    assert.equal(
        Object.hasOwn(restoredDelivery, 'retractionInProgress'),
        false
    );
    assert.equal(
        restored.pendingEnrichments.has(`2026:${playerId}:${eventId}`),
        true
    );
});

test('invalid in-memory state cannot replace the durable primary', t => {
    const tempDirectory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'home-run-bot-invalid-save-')
    );
    t.after(() => fs.rmSync(tempDirectory, { recursive: true, force: true }));
    const statePath = path.join(tempDirectory, 'state.json');
    const bot = makeBot({ channelIds: [CHANNEL_A], statePath });
    const playerData = bot.players['592450'];

    assert.equal(bot.saveState({ throwOnError: true }), true);
    const durableState = fs.readFileSync(statePath, 'utf8');
    playerData.lastCheckedHR = 1;
    playerData.checkpointInitialized = true;
    playerData.baselineSnapshotInitialized = true;
    playerData.authoritativeSnapshotInitialized = true;

    assert.throws(
        () => bot.saveState({ throwOnError: true }),
        /inventory does not cover its checkpoint/
    );
    assert.equal(fs.readFileSync(statePath, 'utf8'), durableState);
});

test('persisted enrichment jobs require canonical keys and durable basic deliveries', () => {
    const bot = makeBot({ channelIds: [CHANNEL_A] });
    const playerId = '592450';
    const detail = confirmedDetails(bot, playerId, 1)[0];
    const hrId = bot.buildHomeRunId(detail, playerId);
    const createdAt = FIXED_NOW.toISOString();
    bot.markHomeRunSentToChannels(
        bot.players[playerId],
        hrId,
        [CHANNEL_A],
        {
            basicSentAt: createdAt,
            playerId,
            season: 2026,
            hrId,
            hrDetail: detail,
        }
    );
    const jobKey = `2026:${playerId}:${hrId}`;
    bot.pendingEnrichments.set(jobKey, {
        playerId,
        season: 2026,
        hrId,
        totalHomeRuns: 1,
        hrDetail: detail,
        channelIds: [CHANNEL_A],
        createdAt,
        attempts: 0,
    });
    const validState = bot.serializeState();
    assert.doesNotThrow(() => validateStateDocument(validState));

    const wrongKey = structuredClone(validState);
    wrongKey.pendingEnrichments[`wrong:${jobKey}`] =
        wrongKey.pendingEnrichments[jobKey];
    delete wrongKey.pendingEnrichments[jobKey];
    assert.throws(
        () => validateStateDocument(wrongKey),
        /does not match/
    );

    const missingDelivery = structuredClone(validState);
    delete missingDelivery.players[playerId]
        .alertMessagesByChannel[CHANNEL_A][hrId];
    assert.throws(
        () => validateStateDocument(missingDelivery),
        /no durable alert record/
    );
});

test('prior-season state starts current-season catch-up from an explicit zero inventory', async t => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'home-run-bot-season-'));
    t.after(() => fs.rmSync(tempDirectory, { recursive: true, force: true }));
    const statePath = path.join(tempDirectory, 'state.json');
    const source = makeBot({ channelIds: [CHANNEL_A], statePath });
    const savedState = source.serializeState();
    savedState.season = 2025;
    fs.writeFileSync(statePath, JSON.stringify(savedState), 'utf8');

    const bot = makeBot({ channelIds: [CHANNEL_A], statePath });
    const restored = bot.loadState();
    const playerId = '592450';
    const playerData = keepOnlyPlayer(bot, playerId);
    bot.startupCatchUpPlayerIds = new Set([playerId]);
    const detail = confirmedDetails(bot, playerId, 1)[0];
    const alerted = [];
    bot.getPlayerHomeRunTotal = async () => 1;
    bot.getRecentHomeRunDetails = async () => [detail];
    bot.sendInitialAlert = async (
        _playerId,
        currentPlayer,
        _total,
        currentDetail,
        hrId,
        channelIds
    ) => {
        alerted.push(hrId);
        bot.markHomeRunSentToChannels(
            currentPlayer,
            hrId,
            channelIds,
            { hrDetail: currentDetail }
        );
        return { successChannelIds: channelIds, failedChannelIds: [] };
    };
    bot.saveState = () => true;

    assert.equal(restored.has(playerId), true);
    assert.equal(playerData.lastCheckedHR, 0);
    await bot.checkForNewHomeRuns();

    assert.deepEqual(alerted, [bot.buildHomeRunId(detail, playerId)]);
    assert.equal(playerData.lastCheckedHR, 1);
});

test('identity-based detection alerts a backdated insertion without replaying existing events', async () => {
    const bot = makeBot({ channelIds: [CHANNEL_A] });
    const playerId = '592450';
    const playerData = keepOnlyPlayer(bot, playerId);
    const existingDetails = confirmedDetails(bot, playerId, 10, {
        gameBase: 710000,
        atBatBase: 20,
    });
    const inserted = bot.createHomeRunDetail({
        playerId,
        season: 2026,
        gameId: '719999',
        gameDate: '2026-06-04T12:00:00.000Z',
        gameHomeRunIndex: 1,
        atBatIndex: 99,
    });
    const currentDetails = bot.sortHomeRunDetailsChronologically([
        ...existingDetails,
        inserted,
    ]);
    const existingIds = existingDetails.map(detail =>
        bot.buildHomeRunId(detail, playerId)
    );
    playerData.lastCheckedHR = 10;
    playerData.checkpointInitialized = true;
    playerData.baselineHomeRunIds = new Set(existingIds);
    playerData.baselineSnapshotInitialized = true;
    playerData.authoritativeHomeRunIds = new Set(existingIds);
    playerData.authoritativeSnapshotInitialized = true;
    playerData.authoritativeSnapshotCapturedAt = FIXED_NOW.toISOString();
    for (const [index, eventId] of existingIds.entries()) {
        bot.markHomeRunSentToChannels(
            playerData,
            eventId,
            [CHANNEL_A],
            { hrDetail: existingDetails[index] }
        );
    }
    const alerted = [];
    bot.getPlayerHomeRunTotal = async () => 11;
    bot.getRecentHomeRunDetails = async () => currentDetails;
    bot.sendInitialAlert = async (
        _playerId,
        currentPlayer,
        _total,
        detail,
        hrId,
        channelIds
    ) => {
        alerted.push(hrId);
        bot.markHomeRunSentToChannels(
            currentPlayer,
            hrId,
            channelIds,
            { hrDetail: detail }
        );
        return { successChannelIds: channelIds, failedChannelIds: [] };
    };
    bot.saveState = () => true;

    await bot.checkForNewHomeRuns();

    assert.deepEqual(alerted, [bot.buildHomeRunId(inserted, playerId)]);
    assert.equal(playerData.lastCheckedHR, 11);
});

test('same-total official identity replacement retracts the removed event and alerts the replacement', async () => {
    const bot = makeBot({ channelIds: [CHANNEL_A] });
    const playerId = '592450';
    const playerData = keepOnlyPlayer(bot, playerId);
    const [first, removed] = confirmedDetails(bot, playerId, 2, {
        gameBase: 720000,
        atBatBase: 30,
    });
    const replacement = bot.createHomeRunDetail({
        ...removed,
        gameId: '720099',
        atBatIndex: 99,
        eventKey: null,
    });
    const firstId = bot.buildHomeRunId(first, playerId);
    const removedId = bot.buildHomeRunId(removed, playerId);
    const replacementId = bot.buildHomeRunId(replacement, playerId);
    playerData.lastCheckedHR = 2;
    playerData.checkpointInitialized = true;
    playerData.baselineHomeRunIds = new Set([firstId, removedId]);
    playerData.baselineSnapshotInitialized = true;
    playerData.authoritativeHomeRunIds = new Set([firstId, removedId]);
    playerData.authoritativeSnapshotInitialized = true;
    playerData.authoritativeSnapshotCapturedAt = FIXED_NOW.toISOString();
    for (const [eventId, detail] of [[firstId, first], [removedId, removed]]) {
        bot.markHomeRunSentToChannels(
            playerData,
            eventId,
            [CHANNEL_A],
            { hrDetail: detail }
        );
    }
    playerData.homeRunParks[removedId] = {
        parksCleared: 10,
        parksEvaluated: 29,
        analysisStatus: 'partial',
    };
    const retracted = [];
    const alerted = [];
    bot.annotateRetractedHomeRun = async (_id, _player, eventId) => {
        retracted.push(eventId);
        return true;
    };
    bot.getPlayerHomeRunTotal = async () => 2;
    bot.getRecentHomeRunDetails = async () => [first, replacement];
    bot.sendInitialAlert = async (
        _playerId,
        currentPlayer,
        _total,
        detail,
        hrId,
        channelIds
    ) => {
        alerted.push(hrId);
        bot.markHomeRunSentToChannels(
            currentPlayer,
            hrId,
            channelIds,
            { hrDetail: detail }
        );
        return { successChannelIds: channelIds, failedChannelIds: [] };
    };
    bot.saveState = () => true;

    await bot.checkForNewHomeRuns({ force: true });
    assert.deepEqual(retracted, []);
    assert.deepEqual(alerted, []);
    await bot.checkForNewHomeRuns({ force: true });

    assert.deepEqual(retracted, [removedId]);
    assert.deepEqual(alerted, [replacementId]);
    assert.equal(Object.hasOwn(playerData.homeRunParks, removedId), false);
    assert.deepEqual(
        [...playerData.authoritativeHomeRunIds].sort(),
        [firstId, replacementId].sort()
    );
});

test('failed replacement delivery lowers the checkpoint to a semantically valid state', async () => {
    const bot = makeBot({ channelIds: [CHANNEL_A] });
    const playerId = '592450';
    const playerData = keepOnlyPlayer(bot, playerId);
    const [first, removed] = confirmedDetails(bot, playerId, 2, {
        gameBase: 725000,
        atBatBase: 35,
    });
    const replacement = bot.createHomeRunDetail({
        ...removed,
        gameId: '725099',
        atBatIndex: 99,
        eventKey: null,
    });
    const firstId = bot.buildHomeRunId(first, playerId);
    const removedId = bot.buildHomeRunId(removed, playerId);
    const replacementId = bot.buildHomeRunId(replacement, playerId);
    playerData.lastCheckedHR = 2;
    playerData.checkpointInitialized = true;
    playerData.baselineHomeRunIds = new Set([firstId, removedId]);
    playerData.baselineSnapshotInitialized = true;
    playerData.authoritativeHomeRunIds = new Set([firstId, removedId]);
    playerData.authoritativeSnapshotInitialized = true;
    playerData.authoritativeSnapshotCapturedAt = FIXED_NOW.toISOString();
    for (const [eventId, detail] of [[firstId, first], [removedId, removed]]) {
        bot.markHomeRunSentToChannels(
            playerData,
            eventId,
            [CHANNEL_A],
            { hrDetail: detail }
        );
    }
    bot.annotateRetractedHomeRun = async () => true;
    bot.getPlayerHomeRunTotal = async () => 2;
    bot.getRecentHomeRunDetails = async () => [first, replacement];
    bot.sendInitialAlert = async () => ({
        successChannelIds: [],
        failedChannelIds: [CHANNEL_A],
    });
    bot.saveState = () => true;

    await bot.checkForNewHomeRuns({ force: true });
    assert.equal(playerData.lastCheckedHR, 2);
    await bot.checkForNewHomeRuns({ force: true });

    assert.equal(playerData.lastCheckedHR, 1);
    assert.equal(playerData.baselineHomeRunIds.has(removedId), false);
    assert.equal(playerData.authoritativeHomeRunIds.has(replacementId), true);
    assert.doesNotThrow(() => validateStateDocument(bot.serializeState()));
});

test('forced inventory reconstruction bypasses legacy cached slot assignments', async () => {
    const bot = makeBot({ channelIds: [CHANNEL_A] });
    const playerId = '592450';
    const playerData = bot.players[playerId];
    playerData.homeRunEvents.cached = bot.createHomeRunDetail({
        playerId,
        season: 2026,
        gameId: '730001',
        gameDate: '2026-07-01',
        gameHomeRunIndex: 1,
        atBatIndex: 10,
        detailStatus: 'confirmed',
    });
    bot.getPlayerGameLog = async (_id, options) => {
        assert.equal(options.force, true);
        return [{
            date: '2026-07-01',
            game: { gamePk: 730001, gameDate: '2026-07-01', gameNumber: 1 },
            stat: { homeRuns: 1 },
        }];
    };
    bot.getGamePlays = async (_gameId, options) => {
        assert.equal(options.force, true);
        return [{
            matchup: { batter: { id: Number(playerId) } },
            about: { atBatIndex: 20 },
            result: { eventType: 'home_run', rbi: 1 },
        }];
    };
    bot.getHomeRunDetailsFromStatcast = async () => null;

    const [detail] = await bot.getRecentHomeRunDetails(
        playerId,
        1,
        { force: true }
    );

    assert.equal(detail.atBatIndex, 20);
});

test('incomplete play-by-play does not positionally assign a later home run', async () => {
    const bot = makeBot({ channelIds: [CHANNEL_A] });
    const playerId = '592450';
    bot.getPlayerGameLog = async () => [{
        date: '2026-07-02',
        game: { gamePk: 730002, gameDate: '2026-07-02', gameNumber: 1 },
        stat: { homeRuns: 2 },
    }];
    bot.getGamePlays = async () => [{
        matchup: { batter: { id: Number(playerId) } },
        about: { atBatIndex: 50 },
        result: { eventType: 'home_run', rbi: 1 },
    }];
    bot.getHomeRunDetailsFromStatcast = async () => null;

    const details = await bot.getRecentHomeRunDetails(
        playerId,
        2,
        { force: true }
    );

    assert.equal(details.length, 2);
    assert.equal(details.every(detail => detail.atBatIndex === null), true);
    assert.equal(
        details.every(detail => detail.detailStatus === 'pending'),
        true
    );
});

test('duplicate canonical inventory identities are rejected without replacing the prior snapshot', () => {
    const bot = makeBot({ channelIds: [CHANNEL_A] });
    const playerId = '592450';
    const playerData = bot.players[playerId];
    const priorId = 'hr:2026:592450:735000:ab:1';
    playerData.authoritativeHomeRunIds = new Set([priorId]);
    playerData.authoritativeSnapshotInitialized = true;
    const duplicate = bot.createHomeRunDetail({
        playerId,
        season: 2026,
        gameId: '735001',
        gameDate: '2026-07-03',
        gameHomeRunIndex: 1,
        atBatIndex: 10,
    });

    const result = bot.captureAuthoritativeInventory(
        playerId,
        playerData,
        [duplicate, { ...duplicate }],
        2
    );

    assert.equal(result, null);
    assert.deepEqual([...playerData.authoritativeHomeRunIds], [priorId]);
});

test('downward correction aborts if the aggregate changes during reconstruction', async () => {
    const bot = makeBot({ channelIds: [CHANNEL_A] });
    const playerId = '592450';
    const playerData = bot.players[playerId];
    const priorId = 'hr:2026:592450:736000:ab:1';
    playerData.authoritativeHomeRunIds = new Set([priorId]);
    playerData.authoritativeSnapshotInitialized = true;
    let annotationCalls = 0;
    bot.annotateRetractedHomeRun = async () => {
        annotationCalls += 1;
        return true;
    };
    bot.getPlayerHomeRunTotal = async () => 1;

    const reconciled = await bot.reconcileDownwardCorrection(
        playerId,
        playerData,
        0
    );

    assert.equal(reconciled, false);
    assert.equal(annotationCalls, 0);
    assert.deepEqual([...playerData.authoritativeHomeRunIds], [priorId]);
});

test('runtime season rollover cancels and drains active enrichment before resetting state', async () => {
    let now = new Date('2026-12-31T23:59:59.000Z');
    const bot = makeBot({
        channelIds: [CHANNEL_A],
        clock: () => new Date(now),
    });
    const activeGate = deferred();
    const record = {
        playerId: '592450',
        season: 2026,
        hrId: 'hr:2026:592450:737000:ab:1',
    };
    bot.activeEnrichmentRecords.set('old-job', record);
    bot.activeEnrichmentJobs.set('old-job', activeGate.promise);
    bot.saveState = () => true;
    now = new Date('2027-01-01T00:00:01.000Z');

    const rolloverPromise = bot.ensureActiveSeason();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(record.cancelledReason, 'season-rollover');
    assert.equal(bot.currentSeason, 2026);

    activeGate.resolve();
    assert.equal(await rolloverPromise, true);
    assert.equal(bot.currentSeason, 2027);
    assert.equal(bot.players['592450'].lastCheckedHR, 0);
});

test('alias migration during Discord I/O preserves the canonical enrichment acknowledgement', async () => {
    const channelGate = deferred();
    const fetchStarted = deferred();
    const bot = makeBot({
        channelIds: [CHANNEL_A],
        client: {
            ...fakeClient(),
            channels: {
                fetch: async () => {
                    fetchStarted.resolve();
                    return channelGate.promise;
                },
            },
        },
    });
    const playerId = '592450';
    const playerData = bot.players[playerId];
    const slotDetail = bot.createHomeRunDetail({
        playerId,
        season: 2026,
        gameId: '740001',
        gameDate: '2026-07-20',
        gameHomeRunIndex: 1,
    });
    const slotId = bot.buildHomeRunId(slotDetail, playerId);
    bot.markHomeRunSentToChannels(
        playerData,
        slotId,
        [CHANNEL_A],
        {
            messageId: 'message-1',
            basicSentAt: FIXED_NOW.toISOString(),
            hrDetail: slotDetail,
        }
    );
    const record = {
        playerId,
        season: 2026,
        hrId: slotId,
        totalHomeRuns: 1,
        hrDetail: slotDetail,
        channelIds: [CHANNEL_A],
        createdAt: FIXED_NOW.toISOString(),
        attempts: 0,
    };
    const slotJobKey = `2026:${playerId}:${slotId}`;
    bot.pendingEnrichments.set(slotJobKey, record);
    bot.saveState = () => true;

    const updatePromise = bot.updateEnrichedAlert(
        playerId,
        playerData,
        record,
        CHANNEL_A,
        null,
        null,
        'details unavailable'
    );
    await fetchStarted.promise;
    const exactDetail = { ...slotDetail, atBatIndex: 55 };
    const canonicalId = bot.reconcileHomeRunAliases(
        playerId,
        playerData,
        exactDetail
    );
    channelGate.resolve({
        messages: {
            fetch: async () => ({
                edit: async () => ({ id: 'message-1' }),
            }),
        },
        send: async () => {
            throw new Error('follow-up should not be needed');
        },
    });
    await updatePromise;

    assert.equal(record.hrId, canonicalId);
    assert.ok(
        playerData.alertMessagesByChannel[CHANNEL_A][canonicalId].enrichedAt
    );
    assert.equal(
        Object.hasOwn(
            playerData.alertMessagesByChannel[CHANNEL_A],
            slotId
        ),
        false
    );
});

test('active alias migration keeps the active record and all canonical channels without duplicate queueing', () => {
    const bot = makeBot({ channelIds: [CHANNEL_A, CHANNEL_B] });
    const playerId = '592450';
    const playerData = bot.players[playerId];
    const slotDetail = bot.createHomeRunDetail({
        playerId,
        season: 2026,
        gameId: '750001',
        gameDate: '2026-07-21',
        gameHomeRunIndex: 1,
    });
    const exactDetail = { ...slotDetail, atBatIndex: 60 };
    const slotId = bot.buildHomeRunId(slotDetail, playerId);
    const canonicalId = bot.buildHomeRunId(exactDetail, playerId);
    const slotKey = `2026:${playerId}:${slotId}`;
    const canonicalKey = `2026:${playerId}:${canonicalId}`;
    const activeRecord = {
        playerId,
        season: 2026,
        hrId: slotId,
        hrDetail: slotDetail,
        channelIds: [CHANNEL_A],
        createdAt: FIXED_NOW.toISOString(),
    };
    bot.pendingEnrichments.set(slotKey, activeRecord);
    bot.pendingEnrichments.set(canonicalKey, {
        ...activeRecord,
        hrId: canonicalId,
        hrDetail: exactDetail,
        channelIds: [CHANNEL_B],
    });
    bot.activeEnrichmentRecords.set(slotKey, activeRecord);
    bot.activeEnrichmentJobs.set(slotKey, new Promise(() => {}));

    bot.reconcileHomeRunAliases(playerId, playerData, exactDetail);
    bot.resumePendingEnrichments();

    assert.equal(bot.pendingEnrichments.get(canonicalKey), activeRecord);
    assert.deepEqual(activeRecord.channelIds.sort(), [CHANNEL_A, CHANNEL_B]);
    assert.deepEqual(bot.enrichmentQueue, []);
});

test('an active due enrichment does not create a zero-delay wake loop', t => {
    const bot = makeBot({ channelIds: [CHANNEL_A] });
    const record = {
        playerId: '592450',
        season: 2026,
        hrId: 'hr:2026:592450:760001:ab:1',
        hrDetail: {},
        channelIds: [CHANNEL_A],
        createdAt: FIXED_NOW.toISOString(),
    };
    const jobKey = `2026:${record.playerId}:${record.hrId}`;
    bot.pendingEnrichments.set(jobKey, record);
    bot.activeEnrichmentRecords.set(jobKey, record);
    bot.activeEnrichmentJobs.set(jobKey, new Promise(() => {}));
    t.after(() => {
        if (bot.enrichmentWakeTimer) clearTimeout(bot.enrichmentWakeTimer);
    });

    bot.scheduleEnrichmentWake();

    assert.equal(bot.enrichmentWakeTimer, null);
});

test('transient analysis failure executes a real second attempt and completes enrichment', async () => {
    const bot = makeBot({ channelIds: [CHANNEL_A], sleep: async () => {} });
    enableVerifiedAnalysis(bot);
    const playerId = '592450';
    const playerData = bot.players[playerId];
    const detail = confirmedDetails(bot, playerId, 1, {
        gameBase: 770000,
        atBatBase: 70,
    })[0];
    const hrId = bot.buildHomeRunId(detail, playerId);
    const jobKey = `2026:${playerId}:${hrId}`;
    const record = {
        playerId,
        season: 2026,
        hrId,
        totalHomeRuns: 1,
        hrDetail: detail,
        channelIds: [CHANNEL_A],
        createdAt: FIXED_NOW.toISOString(),
        attempts: 0,
    };
    const statcast = {
        venue_id: 3313,
        venue_name: 'Yankee Stadium',
        home_team: 'NYY',
        launch_speed: 110,
        launch_angle: 28,
        hit_distance_sc: 430,
        hc_x: 120,
        hc_y: 80,
        plate_z: 3,
    };
    const usable = {
        success: true,
        analysis_status: 'ok',
        total_dongs: 20,
        parks_evaluated: 29,
        parks_expected: 30,
        venue_id: 3313,
        image_path: 'consumer-owned.png',
        temp_directory: null,
        source_data_hash: bot.ballparkDataVersion,
        ballpark_data_version: bot.ballparkMetadataVersion,
    };
    let analysisCalls = 0;
    bot.getStatcastDataForHR = async () => statcast;
    bot.runHRAnalysis = async () => {
        analysisCalls += 1;
        return analysisCalls === 1 ? null : usable;
    };
    bot.updateEnrichedAlert = async () => {
        bot.getAlertDeliveryRecord(
            playerData,
            CHANNEL_A,
            hrId
        ).enrichedAt = FIXED_NOW.toISOString();
        return true;
    };
    bot.saveState = () => true;
    bot.markHomeRunSentToChannels(
        playerData,
        hrId,
        [CHANNEL_A],
        {
            basicSentAt: FIXED_NOW.toISOString(),
            hrDetail: detail,
        }
    );
    bot.pendingEnrichments.set(jobKey, record);

    await bot.processEnrichment(jobKey, record);

    assert.equal(analysisCalls, 2);
    assert.equal(bot.pendingEnrichments.has(jobKey), false);
    assert.ok(playerData.homeRunParks[hrId]);
});

test('enrichment acknowledgement persists only the channels still pending', async () => {
    const editedMessages = [];
    const bot = makeBot({
        client: {
            ...fakeClient(),
            channels: {
                fetch: async channelId => ({
                    messages: {
                        fetch: async messageId => ({
                            edit: async () => {
                                editedMessages.push([channelId, messageId]);
                                return { id: messageId };
                            },
                        }),
                    },
                    send: async () => {
                        throw new Error('The edit path should be available');
                    },
                }),
            },
        },
    });
    const playerId = '592450';
    const playerData = bot.players[playerId];
    const detail = confirmedDetails(bot, playerId, 1)[0];
    const eventId = bot.buildHomeRunId(detail, playerId);
    const jobKey = `2026:${playerId}:${eventId}`;
    const record = {
        playerId,
        season: 2026,
        hrId: eventId,
        totalHomeRuns: 1,
        hrDetail: detail,
        channelIds: [CHANNEL_A, CHANNEL_B],
        createdAt: FIXED_NOW.toISOString(),
        attempts: 0,
    };

    playerData.lastCheckedHR = 1;
    playerData.checkpointInitialized = true;
    playerData.baselineHomeRunIds = new Set([eventId]);
    playerData.baselineSnapshotInitialized = true;
    playerData.authoritativeHomeRunIds = new Set([eventId]);
    playerData.authoritativeSnapshotInitialized = true;
    playerData.authoritativeSnapshotCapturedAt = FIXED_NOW.toISOString();
    for (const channelId of bot.channelIds) {
        bot.markHomeRunSentToChannels(
            playerData,
            eventId,
            [channelId],
            {
                messageId: `message-${channelId}`,
                playerId,
                season: 2026,
                hrId: eventId,
                totalHomeRuns: 1,
                hrDetail: detail,
            }
        );
    }
    bot.pendingEnrichments.set(jobKey, record);
    bot.buildAlertMessageOptions = () => ({ embeds: [] });
    const persistedPendingChannels = [];
    bot.saveState = () => {
        const state = bot.serializeState();
        validateStateDocument(state);
        persistedPendingChannels.push(
            state.pendingEnrichments[jobKey]?.channelIds || []
        );
        return true;
    };

    await bot.updateEnrichedAlert(
        playerId,
        playerData,
        record,
        CHANNEL_A,
        null,
        null,
        ''
    );
    assert.deepEqual(record.channelIds, [CHANNEL_B]);
    assert.deepEqual(
        bot.pendingEnrichments.get(jobKey)?.channelIds,
        [CHANNEL_B]
    );

    await bot.updateEnrichedAlert(
        playerId,
        playerData,
        record,
        CHANNEL_B,
        null,
        null,
        ''
    );
    assert.equal(bot.pendingEnrichments.has(jobKey), false);
    assert.deepEqual(persistedPendingChannels, [[CHANNEL_B], []]);
    assert.deepEqual(editedMessages, [
        [CHANNEL_A, `message-${CHANNEL_A}`],
        [CHANNEL_B, `message-${CHANNEL_B}`],
    ]);
    assert.doesNotThrow(() =>
        validateStateDocument(bot.serializeState())
    );
});

test('stale park overlays use the shared message lock and preserve correction text', async () => {
    let messageFetches = 0;
    let editedOptions = null;
    const embedData = {
        title: 'Home run alert',
        color: 0x00ff00,
        fields: [
            { name: 'Parks Cleared', value: '20/29', inline: true },
            { name: 'Exit Velocity', value: '110 mph', inline: true },
        ],
        image: { url: 'attachment://ballpark_overlay.png' },
        footer: {
            text: 'MLB correction: this play is no longer counted as a home run.',
        },
    };
    const bot = makeBot({
        channelIds: [CHANNEL_A],
        client: {
            ...fakeClient(),
            channels: {
                fetch: async () => ({
                    messages: {
                        fetch: async () => {
                            messageFetches += 1;
                            return {
                                embeds: [{
                                    toJSON: () => structuredClone(embedData),
                                }],
                                edit: async options => {
                                    editedOptions = options;
                                    return { id: 'message-1' };
                                },
                            };
                        },
                    },
                }),
            },
        },
    });
    const playerId = '592450';
    const playerData = bot.players[playerId];
    const detail = confirmedDetails(bot, playerId, 1)[0];
    const eventId = bot.buildHomeRunId(detail, playerId);

    playerData.lastCheckedHR = 1;
    playerData.checkpointInitialized = true;
    playerData.baselineHomeRunIds = new Set([eventId]);
    playerData.baselineSnapshotInitialized = true;
    playerData.authoritativeHomeRunIds = new Set([eventId]);
    playerData.authoritativeSnapshotInitialized = true;
    playerData.authoritativeSnapshotCapturedAt = FIXED_NOW.toISOString();
    bot.markHomeRunSentToChannels(
        playerData,
        eventId,
        [CHANNEL_A],
        {
            messageId: 'message-1',
            enrichedAt: FIXED_NOW.toISOString(),
            parkAnalysisDelivered: true,
            imageDelivered: true,
            analysisSourceDataHash: 'retired-source',
            analysisMetadataVersion: 'retired-metadata',
            playerId,
            season: 2026,
            hrId: eventId,
            hrDetail: detail,
        }
    );
    bot.saveState = () => {
        validateStateDocument(bot.serializeState());
        return true;
    };

    const releaseMessage = await bot.acquireKeyedLock(
        bot.discordMessageMutationLocks,
        `${CHANNEL_A}:message-1`
    );
    const withdrawal = bot.withdrawStaleParkAnalysisDeliveries();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(messageFetches, 0);
    releaseMessage();

    assert.deepEqual(await withdrawal, {
        reviewed: 1,
        withdrawn: 1,
        deferred: 0,
    });
    const revisedEmbed = editedOptions.embeds[0].toJSON();
    assert.equal(editedOptions.attachments.length, 0);
    assert.equal(
        revisedEmbed.fields.some(field => field.name === 'Parks Cleared'),
        false
    );
    assert.equal(
        revisedEmbed.fields.some(field => field.name === 'Exit Velocity'),
        true
    );
    assert.equal(Object.hasOwn(revisedEmbed, 'image'), false);
    assert.match(revisedEmbed.footer.text, /MLB correction/);
    assert.match(revisedEmbed.footer.text, /projection withdrawn/);
    const delivery = bot.getAlertDeliveryRecord(
        playerData,
        CHANNEL_A,
        eventId
    );
    assert.equal(delivery.parkAnalysisDelivered, false);
    assert.ok(delivery.parkAnalysisWithdrawnAt);
});

test('timed-out shutdown retains the lease until nested background work settles', async t => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'home-run-bot-shutdown-'));
    t.after(() => fs.rmSync(tempDirectory, { recursive: true, force: true }));
    const statePath = path.join(tempDirectory, 'state.json');
    const processRef = new EventEmitter();
    processRef.exitCode = 0;
    const bot = makeBot({
        channelIds: [CHANNEL_A],
        statePath,
        disableStateLock: false,
        shutdownTimeoutMs: 1,
        processRef,
    });
    bot.saveState = () => true;
    bot.acquireStateLease();
    const parentGate = deferred();
    const childGate = deferred();
    let childJob;
    let parentJob;
    parentJob = parentGate.promise
        .then(() => {
            childJob = childGate.promise.finally(() => {
                bot.backgroundJobs.delete(childJob);
            });
            bot.backgroundJobs.add(childJob);
        })
        .finally(() => {
            bot.backgroundJobs.delete(parentJob);
        });
    bot.backgroundJobs.add(parentJob);

    await bot.shutdown('test-timeout');
    assert.equal(fs.existsSync(`${statePath}.lock`), true);

    parentGate.resolve();
    await parentJob;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fs.existsSync(`${statePath}.lock`), true);

    childGate.resolve();
    await childJob;
    for (let index = 0; index < 5 && fs.existsSync(`${statePath}.lock`); index++) {
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(fs.existsSync(`${statePath}.lock`), false);
});

test('initial Discord delivery uses a deterministic enforced nonce', async () => {
    const sentOptions = [];
    const bot = makeBot({
        channelIds: [CHANNEL_A],
        client: {
            ...fakeClient(),
            channels: {
                fetch: async () => ({
                    send: async options => {
                        sentOptions.push(options);
                        return { id: 'message-1' };
                    },
                }),
            },
        },
    });
    const playerId = '592450';
    const detail = confirmedDetails(bot, playerId, 1)[0];
    const hrId = bot.buildHomeRunId(detail, playerId);
    bot.saveState = () => true;
    bot.queueEnrichment = () => {};

    await bot.sendInitialAlert(
        playerId,
        bot.players[playerId],
        1,
        detail,
        hrId,
        [CHANNEL_A]
    );

    assert.equal(sentOptions.length, 1);
    assert.equal(sentOptions[0].enforceNonce, true);
    assert.equal(
        sentOptions[0].nonce,
        bot.buildDiscordNonce('home-run', CHANNEL_A, hrId)
    );
    assert.equal(sentOptions[0].nonce.length, 25);
});

test('Python subprocesses do not inherit the Discord bot token', () => {
    const originalToken = process.env.BOT_TOKEN;
    process.env.BOT_TOKEN = 'must-not-reach-python';
    try {
        const environment = makeBot().getPythonEnvironment();
        assert.equal(environment.BOT_TOKEN, undefined);
        assert.equal(environment.PYTHONDONTWRITEBYTECODE, '1');
        assert.equal(environment.PATH, process.env.PATH);
    } finally {
        if (originalToken === undefined) {
            delete process.env.BOT_TOKEN;
        } else {
            process.env.BOT_TOKEN = originalToken;
        }
    }
});
