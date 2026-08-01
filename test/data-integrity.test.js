'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..');

function readJson(relativePath) {
    const filePath = path.join(projectRoot, relativePath);
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function assertFiniteNumber(value, label) {
    assert.equal(typeof value, 'number', `${label} must be a number`);
    assert.ok(Number.isFinite(value), `${label} must be finite`);
}

function sha256(relativePath) {
    const payload = fs.readFileSync(path.join(projectRoot, relativePath));
    return crypto.createHash('sha256').update(payload).digest('hex');
}

test('unlicensed fence values are absent and retained path geometry is finite', () => {
    const fences = readJson(path.join('data', 'fences.json'));
    const stadiumPaths = readJson(path.join('data', 'stadium_paths.json'));
    const pathTeams = Object.keys(stadiumPaths)
        .filter(team => team !== 'generic')
        .sort();

    assert.deepEqual(
        fences,
        {},
        'fences.json must remain a disabled empty placeholder'
    );
    assert.ok(
        pathTeams.length >= 29,
        'the licensed offline path reference is incomplete'
    );
    for (const team of pathTeams) {
        const geometry = stadiumPaths[team];
        assert.ok(geometry && typeof geometry === 'object', `${team} path geometry is required`);
        assert.ok(
            Array.isArray(geometry.outfield_outer) && geometry.outfield_outer.length >= 2,
            `${team} requires an outfield_outer path`
        );
        assert.ok(
            Array.isArray(geometry.foul_lines) && geometry.foul_lines.length >= 2,
            `${team} requires foul-line geometry`
        );
        for (const [segmentName, points] of Object.entries(geometry)) {
            assert.ok(
                Array.isArray(points),
                `${team}.${segmentName} must be an array`
            );
            for (const [index, point] of points.entries()) {
                assertFiniteNumber(
                    point.x,
                    `${team}.${segmentName}[${index}].x`
                );
                assertFiniteNumber(
                    point.y,
                    `${team}.${segmentName}[${index}].y`
                );
            }
        }
    }
});

test('runtime JSON files are deliberately excluded from the repository contract', () => {
    const ignoreRules = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf8');
    const attributes = fs.readFileSync(path.join(projectRoot, '.gitattributes'), 'utf8');

    assert.match(ignoreRules, /^\.env$/m);
    assert.match(ignoreRules, /^data\/bot_state\.json\*$/m);
    assert.match(ignoreRules, /^data\/\.bot_state\.json\*\.tmp$/m);
    assert.match(ignoreRules, /^tmp\/$/m);
    assert.match(ignoreRules, /^__pycache__\/$/m);
    assert.match(ignoreRules, /^\*\.py\[cod\]$/m);
    assert.match(ignoreRules, /^\.claude\/settings\.local\.json$/m);
    assert.match(attributes, /^data\/fences\.json text eol=lf$/m);
    assert.match(attributes, /^data\/stadium_paths\.json text eol=lf$/m);
    for (const relativePath of [
        path.join('data', 'fences.json'),
        path.join('data', 'stadium_paths.json'),
    ]) {
        assert.equal(
            fs.readFileSync(path.join(projectRoot, relativePath)).includes(13),
            false,
            `${relativePath} must remain LF-only so its reviewed hash is portable`
        );
    }
});

test('systemd launches with authoritative writable state and cache paths', () => {
    const service = fs.readFileSync(
        path.join(projectRoot, 'deploy', 'home-run-bot.service.example'),
        'utf8'
    );

    assert.match(service, /^EnvironmentFile=\/opt\/home-run-bot\/\.env$/m);
    assert.doesNotMatch(service, /^Environment=STATE_PATH=/m);
    assert.match(
        service,
        /^ExecStart=\/usr\/bin\/env STATE_PATH=\/var\/lib\/home-run-bot\/bot_state\.json MPLCONFIGDIR=\/var\/cache\/home-run-bot\/matplotlib TMPDIR=\/var\/cache\/home-run-bot PYTHONDONTWRITEBYTECODE=1 \/usr\/bin\/node \/opt\/home-run-bot\/bot\.js$/m
    );
    assert.match(service, /^StateDirectory=home-run-bot$/m);
    assert.match(service, /^CacheDirectory=home-run-bot$/m);
    assert.match(service, /^ProtectSystem=strict$/m);
});

test('versioned venue metadata disables unverified projections without unsafe fallbacks', () => {
    const metadata = readJson(path.join('data', 'ballpark_metadata.json'));
    const verifiedEntries = Object.entries(metadata.verified_venues || {});
    const retainedEntries = Object.entries(metadata.retained_venue_mappings || {});
    const unsupportedEntries = Object.entries(metadata.unsupported_venues || {});
    const release = metadata.analysis_release;

    assert.equal(metadata.schema_version, 2);
    assert.match(metadata.data_version, /^\d{4}-\d{2}-\d{2}\./);
    assert.equal(metadata.advanced_analysis_enabled, false);
    assert.equal(metadata.supported_venues, undefined, 'schema 1 supported_venues must not return');
    assert.match(
        metadata.analysis_disabled_reason,
        /disabled.*no redistributable, calibrated fence profiles/i
    );
    assert.deepEqual(verifiedEntries, [], 'disabled analysis cannot expose verified venues');
    assert.equal(release?.status, 'disabled');
    assert.equal(release?.verification_schema_version, 1);
    assert.equal(release?.source_revisions_recorded, false);
    assert.equal(release?.calibration_complete, false);
    assert.equal(release?.calculation_rendering_walls_aligned, false);
    assert.deepEqual(release?.verified_venue_ids, []);
    assert.match(metadata.geometry_source_revision, /fence-profiles-removed/);
    assert.match(
        metadata.geometry_source_provenance_note,
        /upstream.*revision.*not recorded.*prior fence-height snapshot was removed/i,
        'unavailable upstream revisions must remain explicit'
    );
    assert.deepEqual(retainedEntries, []);
    assert.equal(unsupportedEntries.length, metadata.expected_active_venues);
    assert.deepEqual(metadata.excluded_geometry_teams, []);
    assert.equal(metadata.geometry_sources.length, 1);
    assert.equal(metadata.geometry_sources[0].license, 'MIT');
    assert.match(metadata.geometry_sources[0].url, /GeomMLBStadiums/);
    assert.equal(
        metadata.geometry_files_sha256?.['fences.json'],
        sha256(path.join('data', 'fences.json')),
        'fences.json must match the reviewed snapshot hash'
    );
    assert.equal(
        metadata.geometry_files_sha256?.['stadium_paths.json'],
        sha256(path.join('data', 'stadium_paths.json')),
        'stadium_paths.json must match the reviewed snapshot hash'
    );
    assert.equal(
        retainedEntries.length + unsupportedEntries.length,
        metadata.expected_active_venues,
        'retained mappings and explicitly unsupported venues must account for every active venue'
    );
    assert.deepEqual(
        new Set(release?.verified_venue_ids?.map(String) || []),
        new Set(verifiedEntries.map(([venueId]) => venueId)),
        'release verified IDs must exactly match verified_venues'
    );

    for (const [venueId, venue] of verifiedEntries) {
        assert.deepEqual(
            venue,
            metadata.retained_venue_mappings[venueId],
            `${venueId} verified mapping must match its retained mapping`
        );
    }

    for (const [venueId, venue] of unsupportedEntries) {
        assert.match(venueId, /^\d+$/, `unsupported venue ID ${venueId} must be numeric`);
        assert.ok(String(venue.reason || '').trim(), `${venueId} requires a documented reason`);
        assert.equal(
            venue.geometry_team,
            undefined,
            `${venueId} must not silently name fallback geometry`
        );
    }
});

test('third-party geometry attribution and removed-source quarantine stay documented', () => {
    const notice = fs.readFileSync(
        path.join(projectRoot, 'THIRD_PARTY_NOTICES.md'),
        'utf8'
    );
    const readme = fs.readFileSync(path.join(projectRoot, 'README.md'), 'utf8');

    assert.match(notice, /GeomMLBStadiums/);
    assert.match(notice, /Copyright \(c\) 2018 Ben Dilday/);
    assert.match(notice, /MIT License/);
    assert.match(notice, /danmorse314\/dinger-machine/);
    assert.match(notice, /did\s+not publish a license grant/i);
    assert.match(notice, /derived values\s+have therefore been removed/i);
    assert.match(
        notice,
        /root MIT license does not grant rights in third-party inputs/i
    );
    assert.match(
        readme,
        /\[third-party notices\]\(THIRD_PARTY_NOTICES\.md\)/i
    );
});
