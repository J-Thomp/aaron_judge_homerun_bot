# Home Run Tracker Discord bot

A Discord bot that polls MLB data for a fixed list of players, sends immediate
home run alerts, and enriches those alerts with Statcast details when the data
becomes available. Tracking is intentionally limited to MLB regular-season
games; Spring Training, postseason, exhibition, and Home Run Derby totals are
not included.

The bot reduces duplicate alerts across restarts and partial Discord outages.
Delivery is tracked independently for every configured channel, state writes
are atomic and backed up, and a process lease prevents two bot instances from
using the same state file.

## Requirements

- Node.js 24 LTS or newer
- npm 11
- Python 3.10 through 3.13 for the offline analysis engine and full test suite
- A Discord bot token

Python analysis uses the exact versions pinned in `requirements.txt`. The
cross-park projection engine is currently disabled because its retained
geometry did not pass calibration review. Basic alerts and Statcast enrichment
continue without it.

## Discord application setup

1. Create an application and bot in the
   [Discord Developer Portal](https://discord.com/developers/applications).
2. On the **Bot** page, enable the privileged **Message Content Intent**.
3. Invite the application with the `bot` OAuth scope.
4. Grant the bot these channel permissions:
   - View Channel
   - Send Messages
   - Embed Links
   - Attach Files
   - Read Message History
   - Send Messages in Threads, if an alert destination is a thread

The bot uses prefix commands, so the `applications.commands` scope is not
required. It does not need Administrator or Manage Messages.

## Install

Clone the repository and install the locked Node dependencies:

```bash
git clone https://github.com/joe-thomp/home-run-bot.git
cd home-run-bot
npm ci
```

To run the full Python suite or work on the disabled analysis engine, create an
isolated Python environment.

Linux or macOS:

```bash
python3.13 -m venv venv
./venv/bin/python -m pip install --requirement requirements.txt
```

Windows PowerShell:

```powershell
py -3.13 -m venv venv
.\venv\Scripts\python.exe -m pip install --requirement requirements.txt
```

When advanced analysis is enabled, the bot searches `venv`, `.venv`, and common
system Python commands. Set `PYTHON_BIN` when the intended interpreter is
elsewhere.

## Configure

Copy `.env.example` to `.env`, then replace the placeholders:

```env
BOT_TOKEN=your_discord_bot_token
CHANNEL_ID=123456789012345678
```

Keep `.env` private. It is ignored by Git; on Linux, use `chmod 600 .env`.

### Environment variables

| Variable | Required | Default | Purpose |
|---|---:|---:|---|
| `BOT_TOKEN` | Yes | - | Discord bot token |
| `CHANNEL_ID` | Yes | - | One channel ID or a comma-separated list; duplicates are removed |
| `ADMIN_USER_IDS` | No | Empty | Discord user IDs allowed to run admin commands |
| `ALLOWED_GUILD_IDS` | No | Alert-channel guilds | Guilds in which commands are accepted |
| `BOT_USERNAME` | No | Unchanged | Username the bot attempts to apply at startup |
| `PYTHON_BIN` | No | Auto-discovered | Absolute path or command for the Python interpreter |
| `STATE_PATH` | No | `data/bot_state.json` | Writable state-file location |
| `HTTP_TIMEOUT_MS` | No | `10000` | Per-request timeout, from 1,000 to 120,000 ms |
| `HTTP_RETRIES` | No | `3` | Retry count for transient HTTP failures, from 0 to 10 |
| `ENRICHMENT_CONCURRENCY` | No | `3` | Concurrent Statcast enrichment jobs, from 1 to 20 |
| `ANALYSIS_CONCURRENCY` | No | `2` | Concurrent Python analysis jobs, from 1 to 8 |
| `BACKFILL_BATCH_SIZE` | No | `3` | Maximum historical events analyzed per player batch, from 1 to 25 |
| `BACKFILL_COOLDOWN_MS` | No | `60000` | Minimum delay between player backfills, from 1 second to 1 hour |
| `POLL_INTERVAL_MS` | No | `240000` | March-October base polling interval, from 30 seconds to 1 hour |
| `OFFSEASON_POLL_INTERVAL_MS` | No | `21600000` | November-February base interval, from 1 minute to 24 hours |
| `POLL_JITTER_MS` | No | `30000` | Random delay added to each scheduled poll, from 0 to 5 minutes |
| `READY_TIMEOUT_MS` | No | `60000` | Maximum Discord startup wait, from 1 second to 5 minutes |

`PYTHON_PATH` remains accepted as a compatibility alias, but new deployments
should use `PYTHON_BIN`. `BACKFILL_LIMIT` remains a compatibility alias for
`BACKFILL_BATCH_SIZE`.

Before starting, run the local configuration and dependency check:

```bash
npm run preflight
```

This verifies configuration without printing the bot token, checks that the
state path and its parent directory are usable, validates the checked-in
ballpark JSON, and, when advanced analysis is enabled, enforces Python 3.10
through 3.13 and confirms that Matplotlib, NumPy, and Pillow exactly match the
versions pinned in `requirements.txt`.

## Run

```bash
npm start
```

For local development with automatic restart:

```bash
npm run dev
```

Only one instance may use a state file at a time. A second instance exits
instead of risking duplicate alerts or state corruption.

## Alert and recovery behavior

From March through October, the bot schedules a poll every four minutes plus
up to 30 seconds of jitter by default. From November through February, the
default interval is six hours plus jitter. These intervals are configurable
within the bounds above.

Each poll:

1. Fetch the player's official season home run total from the MLB Stats API.
2. Resolve any new home run to a stable, player-scoped game event.
3. Send a basic alert immediately to each channel that has not received it.
4. Fetch Statcast metrics in the background and, only when verified geometry is
   explicitly enabled, run the optional park analysis.
5. Edit the original alert with available enrichment. If the original message cannot
   be fetched or edited, send one follow-up message instead.

State is saved after each delivery acknowledgement. A failed channel remains
pending without causing successful channels to receive the same alert again.
Pending enrichments survive restarts. Delivery retries are bounded, and
Discord message nonces reduce duplicate sends during Discord's nonce-retention
window. No filesystem-backed bot can guarantee indefinite exactly-once
delivery if Discord accepts a message but the process loses power before the
acknowledgement is persisted.

Statcast enrichment retries are bounded. If usable data is still unavailable
after 24 hours or 96 attempts, the existing alert receives an explicit
unavailable footer and the job stops retrying. Enrichment-delivery failures
also stop after a bounded number of attempts.

On a brand-new install during the current season, the live totals become the
baseline; existing home runs are not replayed. If saved state belongs to a
prior season, the new season starts from zero so early home runs are caught up.
On a restart with current-season state, catch-up attempts to deliver every
missed event that can be resolved from MLB game data. The bot periodically
reconciles stable event identities to detect same-total replacements and
upward corrections. A lower official total must be observed twice before a
downward correction is applied.

State is stored in `data/bot_state.json` by default. Set `STATE_PATH` to keep
runtime state outside the application tree in production. Beside that path, the
bot also maintains:

- `${STATE_PATH}.bak` as the last-known-good state
- `${STATE_PATH}.lock` as the single-instance lease
- hidden, short-lived atomic-write files beside `STATE_PATH`

The default paths are ignored by Git. If the primary state file is unreadable,
the bot attempts to recover from the backup. If neither copy is valid, startup
fails closed instead of treating the current totals as a new baseline.
For a custom `STATE_PATH` inside a repository, add its primary, backup, lock,
and hidden atomic temporary-file patterns to that repository's ignore rules;
production deployments should keep state outside the application tree.

The lease also fails closed after an unclean process exit; it is never removed
automatically because competing stale-lock recovery can allow two instances to
run. First verify that no bot process is alive (for a service, check
`systemctl status home-run-bot`), then remove only the exact
`${STATE_PATH}.lock` file and restart. Never remove the lease while a bot
process is running.

## Ballpark analysis coverage

Advanced ballpark overlays and cross-park projections are intentionally
disabled. The former fence-height snapshot was removed because its named
upstream repository did not publish a license grant. The retained
MIT-licensed stadium drawing paths have an unrecorded source revision and have
not passed calibration against official dimensions. SHA-256 values in
`data/ballpark_metadata.json` protect the exact disabled files from unnoticed
changes; they do not establish that geometry is correct.

The stadium paths remain available only as a watermarked offline reference,
with attribution in `THIRD_PARTY_NOTICES.md`; `data/fences.json` is an empty
disabled placeholder. The production bot refuses to run the projection engine
and never substitutes a different park. Basic alerts and available Statcast
metrics continue to work. Park-stat commands report that no current verified
analysis is available.

At startup, the bot removes retired park fields and overlay attachments from
durable Discord messages whose IDs are present in state, while retaining their
Statcast and correction text. State migrated from releases that did not record
Discord message IDs cannot be edited automatically; those cases emit
`park_analysis_withdrawal_missing_message` and require an administrator to
remove the obsolete overlay manually.

Do not re-enable `advanced_analysis_enabled` until every active venue has
traceable source revisions, current venue mappings, coordinate transforms
validated against official dimensions, agreement between calculation and
rendering walls, and regression tolerances reviewed by a knowledgeable human.

## Commands

Commands are accepted only in guilds allowed by `ALLOWED_GUILD_IDS`. When that
variable is empty, the bot derives the allowlist from the configured alert
channels.

Anyone in an allowed guild can use:

| Command | Result |
|---|---|
| `!players` | List tracked players and command shortcuts |
| `!hrstats` | Show current season totals for all tracked players |
| `!parkstats` | Show stored park-analysis coverage for all tracked players |
| `!parkstats <player>` | Show park-analysis coverage for one player |
| `!judge`, `!rice`, `!soto`, `!ohtani`, `!schwarber`, `!harper`, `!gunnar`, `!trout` | Show one player's stats |

Admin commands require a user listed explicitly in `ADMIN_USER_IDS`. Discord's
guild Administrator permission alone does not grant access to bot-wide
operational commands:

| Command | Result |
|---|---|
| `!forcecheck` | Run a poll immediately |
| `!testhr` | Send a formatting test in the current channel |
| `!reset <player>` | Safely re-establish tracking for one player |
| `!debug` | Show operational state and counters |

`!reset` fetches and re-confirms the live MLB total, reconstructs the complete
current event inventory, reconciles corrected identities, and replaces the
player's baseline only when that snapshot is complete. It preserves valid
delivery history, so historical alerts do not replay.

Park-stat commands return only analysis produced by the current verified data
version. While advanced analysis is disabled, they explain that no verified
park projections are available and do not queue unverified calculations.

## Tracked players

The tracked roster is the `players` object in `bot.js`. Each key is an MLB
player ID and each record includes the display name, aliases, team, and number.
Find a player's ID in the URL of their MLB player page.

When changing the roster, keep aliases unique. Ambiguous partial names are
rejected instead of selecting an arbitrary player.

## Tests

Run every syntax check plus the Node and Python suites:

```bash
npm run check
```

For an individual suite:

```bash
npm run check:node
npm run test:python
```

The Python runner uses `PYTHON_BIN`, then `venv`/`.venv`, and finally common
platform commands. Its renderer smoke test runs when the pinned Matplotlib
environment is installed.

GitHub Actions runs the Node suite and both supported Python endpoints
independently, compiles every maintained Python utility, checks Python
dependency consistency, and fails on known production npm advisories.
Dependabot monitors npm, Python, and GitHub Actions dependencies.

## Updating ballpark geometry

`scripts/refresh_ballpark_data.py` is the maintained offline converter. It
accepts already-downloaded, reviewed stadium-path and fence-profile CSV files;
it does not download or trust remote content itself. Before using or
distributing generated data, record an exact source revision and verify the
source license or other permission.

Generate candidates outside `data/` first:

```bash
./venv/bin/python scripts/refresh_ballpark_data.py \
  --geom_csv /path/to/stadium_paths.csv \
  --fences_csv /path/to/fence_heights_complete.csv \
  --out_paths_json tmp/stadium_paths.candidate.json \
  --out_fences_json tmp/fences.candidate.json
```

Review the diff and active-venue mapping before replacing the checked-in data.
Then update `data/ballpark_metadata.json` with the verification date, data
version, source information, and SHA-256 hashes of both final JSON files. Run
`npm run check`; the data-contract tests fail if the metadata hashes and
checked-in snapshots differ.

Do not restore the retired network downloader or write an unreviewed upstream
response directly over the production geometry. Keep
`advanced_analysis_enabled` false until the calibration and provenance
requirements in the coverage section are satisfied.

## Production service

`deploy/home-run-bot.service.example` is a hardened systemd example. Its paths
assume the application is installed at `/opt/home-run-bot`. If advanced
analysis is eventually re-enabled, the optional virtual environment is assumed
to be `/opt/home-run-bot/venv`.

Before enabling it:

```bash
sudo useradd --system --user-group --home /opt/home-run-bot --shell /usr/sbin/nologin home-run-bot
sudo chown -R root:root /opt/home-run-bot
sudo chmod 600 /opt/home-run-bot/.env
command -v node
```

Set `PYTHON_BIN=/opt/home-run-bot/venv/bin/python` only if verified advanced
analysis is re-enabled. If `command -v node` is not `/usr/bin/node`, update
`ExecStart` only to a system-wide, service-readable path such as
`/usr/local/bin/node`. Do not point the hardened unit at an nvm/asdf executable
under a home directory because `ProtectHome` hides it. Verify the exact
executable selected for `ExecStart` before enabling the unit (substitute its
path below if necessary):

```bash
sudo -u home-run-bot /usr/bin/node --version
```

The unit's `ExecStart` sets `STATE_PATH=/var/lib/home-run-bot/bot_state.json`,
points `TMPDIR` and Matplotlib at `/var/cache/home-run-bot`, and asks systemd
to create protected state and cache directories. Setting these values on the
launched command makes them authoritative even if a copied `.env` contains an
empty `STATE_PATH`. Reusable logo/headshot assets therefore survive ordinary
service restarts and are revalidated after seven days, while per-analysis
directories are removed by the bot. The application tree, including the
checked-in ballpark geometry, remains read-only.

Install and verify the service:

```bash
sudo cp deploy/home-run-bot.service.example /etc/systemd/system/home-run-bot.service
sudo systemctl daemon-reload
sudo systemctl enable --now home-run-bot
sudo systemctl status home-run-bot
sudo journalctl --unit home-run-bot --follow
```

The process writes structured JSON logs to stdout/stderr, which systemd sends
to the journal. Monitor repeated `scheduled_poll_failed`,
`player_poll_failed`, delivery failure, state persistence, and Python preflight
events.

## Project layout

```text
bot.js                              Discord, polling, delivery, and state logic
scripts/environment.js              Shared `.env` parser
scripts/hr_analysis.py              Physics and ballpark image analysis
scripts/preflight.js                Local configuration/dependency verification
scripts/run-python-tests.js         Cross-platform Python test launcher
scripts/refresh_ballpark_data.py    Offline reviewed-source geometry converter
scripts/render_stadium_gallery.py   Watermarked offline geometry reference
data/fences.json                    Empty disabled fence-profile placeholder
data/stadium_paths.json             MIT-licensed offline stadium-path reference
data/ballpark_metadata.json         Versioned active-venue mapping
deploy/home-run-bot.service.example Hardened systemd unit
test/                               Deterministic Node and Python tests
LICENSE                             MIT license text
THIRD_PARTY_NOTICES.md              External data attribution and license notice
```

## External data

- [MLB Stats API](https://statsapi.mlb.com) for season totals, game logs,
  play-by-play, venue metadata, and hit metrics
- [Baseball Savant](https://baseballsavant.mlb.com) as a fallback data source
  for some home run details
- MLB's image CDN for player headshots
- ESPN's image CDN for team logos

These endpoints do not require project API keys, but they can be slow,
rate-limited, malformed, or temporarily unavailable. MLB and Savant data
requests use finite timeouts, bounded retries, content-type and response-size
checks, and safe degradation. Image downloads use a finite timeout plus
content-type, byte-size, and decoded-pixel limits; a failed logo or headshot
degrades to an alert without that image. Successful cached assets are
revalidated after seven days.

## License

Project-authored code is [MIT licensed](LICENSE). See
[third-party notices](THIRD_PARTY_NOTICES.md) for the retained stadium-path
reference; the project license does not grant rights in user-supplied data.
