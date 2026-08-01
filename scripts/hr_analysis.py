#!/usr/bin/env python3
"""
HR Analysis: physics engine + ballpark overlay image generator.

Estimates a simplified ballistic flight path and generates a matplotlib
ballpark overlay image from independently supplied, verified geometry.

Called from Node.js via:
    python scripts/hr_analysis.py --launch_speed 112.3 --launch_angle 28.5 \
        --hit_distance 450 --hc_x 140.2 --hc_y 165.8 --plate_z 3.2 \
        --home_team NYY --player_name "Aaron Judge" --pitcher_name "Gerrit Cole" \
        --output_image tmp/hr_overlay.png --fences_path data/fences.json

Returns JSON to stdout.
"""

import argparse
import hashlib
import io
import json
import math
import os
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image


# ── Physics constants ────────────────────────────────────────────────────────
G = -32.174  # ft/s^2  (gravity, negative = downward)
SCALE = 2.495671  # MLBAM coordinate scale factor
IMAGE_DOWNLOAD_TIMEOUT_SECONDS = 4
MAX_IMAGE_DOWNLOAD_BYTES = 8 * 1024 * 1024
MAX_IMAGE_PIXELS = 20_000_000
IMAGE_CACHE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60
EXPECTED_FENCE_FIELDS = {
    "spray_angle",
    "d_wall",
    "fence_height",
    "x",
    "y",
}
DEFAULT_METADATA_PATH = (
    Path(__file__).resolve().parent.parent / "data" / "ballpark_metadata.json"
)
TEAM_LOGO_CODES = {
    "ARI": "ari",
    "AZ": "ari",
    "ATL": "atl",
    "BAL": "bal",
    "BOS": "bos",
    "CHC": "chc",
    "CIN": "cin",
    "CLE": "cle",
    "COL": "col",
    "CWS": "chw",
    "DET": "det",
    "HOU": "hou",
    "KC": "kc",
    "LAA": "laa",
    "LAD": "lad",
    "MIA": "mia",
    "MIL": "mil",
    "MIN": "min",
    "NYM": "nym",
    "NYY": "nyy",
    "OAK": "oak",
    "PHI": "phi",
    "PIT": "pit",
    "SD": "sd",
    "SEA": "sea",
    "SF": "sf",
    "STL": "stl",
    "TB": "tb",
    "TEX": "tex",
    "TOR": "tor",
    "WAS": "wsh",
    "WSH": "wsh",
}


class AnalysisValidationError(ValueError):
    """Raised when analysis inputs or local data fail validation."""


class UnsupportedVenueError(AnalysisValidationError):
    """Raised when a venue has no trustworthy local geometry."""


def load_json_object(file_path, label):
    """Load a JSON object from disk with a useful validation error."""
    path_obj = Path(file_path)
    try:
        payload = json.loads(path_obj.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise AnalysisValidationError(
            f"{label} file does not exist: {path_obj}"
        ) from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise AnalysisValidationError(
            f"Could not load {label} from {path_obj}: {exc}"
        ) from exc

    if not isinstance(payload, dict):
        raise AnalysisValidationError(
            f"{label} must be a JSON object: {path_obj}"
        )
    return payload


def require_finite_number(value, label, minimum=None, maximum=None):
    """Return a finite float within optional inclusive bounds."""
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise AnalysisValidationError(f"{label} must be numeric") from exc

    if not math.isfinite(number):
        raise AnalysisValidationError(f"{label} must be finite")
    if minimum is not None and number < minimum:
        raise AnalysisValidationError(f"{label} must be at least {minimum}")
    if maximum is not None and number > maximum:
        raise AnalysisValidationError(f"{label} must be at most {maximum}")
    return number


def validate_analysis_inputs(
    launch_speed,
    launch_angle,
    hit_distance,
    hc_x,
    hc_y,
    plate_z,
):
    """Validate and normalize Statcast inputs before analysis."""
    return {
        "launch_speed": require_finite_number(
            launch_speed, "launch_speed", minimum=0.1, maximum=250.0
        ),
        "launch_angle": require_finite_number(
            launch_angle, "launch_angle", minimum=-89.9, maximum=89.9
        ),
        "hit_distance": require_finite_number(
            hit_distance, "hit_distance", minimum=0.1, maximum=1000.0
        ),
        "hc_x": require_finite_number(
            hc_x, "hc_x", minimum=-1000.0, maximum=1000.0
        ),
        "hc_y": require_finite_number(
            hc_y, "hc_y", minimum=-1000.0, maximum=1000.0
        ),
        "plate_z": require_finite_number(
            plate_z, "plate_z", minimum=0.0, maximum=20.0
        ),
    }


def normalize_player_id(player_id):
    """Return a safe numeric MLB player ID for URLs and cache names."""
    if player_id is None or str(player_id).strip() == "":
        return None

    normalized = str(player_id).strip()
    if not normalized.isdigit() or len(normalized) > 12:
        raise AnalysisValidationError("player_id must contain only digits")
    return normalized


def validate_fences_data(fences_data):
    """Validate the complete raw fence-geometry snapshot."""
    if not fences_data:
        raise AnalysisValidationError("Fence data is empty")

    for team_code, team_data in fences_data.items():
        if not isinstance(team_code, str) or not team_code.strip():
            raise AnalysisValidationError(
                "Fence team codes must be nonempty strings"
            )
        if not isinstance(team_data, dict):
            raise AnalysisValidationError(
                f"Fence entry for {team_code} must be an object"
            )
        stadium = team_data.get("stadium")
        if not isinstance(stadium, str) or not stadium.strip():
            raise AnalysisValidationError(
                f"Fence entry for {team_code} has no stadium name"
            )

        fence_points = team_data.get("fence_points")
        if not isinstance(fence_points, list) or not fence_points:
            raise AnalysisValidationError(
                f"Fence entry for {team_code} has no fence points"
            )

        previous_angle = None
        for point_index, point in enumerate(fence_points):
            if not isinstance(point, dict):
                raise AnalysisValidationError(
                    f"Fence point {team_code}[{point_index}] must be an object"
                )
            missing_fields = EXPECTED_FENCE_FIELDS.difference(point)
            if missing_fields:
                raise AnalysisValidationError(
                    f"Fence point {team_code}[{point_index}] is missing "
                    f"{', '.join(sorted(missing_fields))}"
                )

            prefix = f"{team_code}[{point_index}]"
            spray_angle = require_finite_number(
                point["spray_angle"],
                f"{prefix}.spray_angle",
                minimum=-90.0,
                maximum=90.0,
            )
            require_finite_number(
                point["d_wall"],
                f"{prefix}.d_wall",
                minimum=1.0,
                maximum=1000.0,
            )
            require_finite_number(
                point["fence_height"],
                f"{prefix}.fence_height",
                minimum=0.0,
                maximum=100.0,
            )
            require_finite_number(point["x"], f"{prefix}.x")
            require_finite_number(point["y"], f"{prefix}.y")

            if previous_angle is not None and spray_angle < previous_angle:
                raise AnalysisValidationError(
                    f"Fence points for {team_code} are not sorted by spray angle"
                )
            previous_angle = spray_angle


def validate_stadium_paths(stadium_paths, geometry_teams):
    """Validate coordinate paths used for image rendering."""
    if stadium_paths is None:
        return
    if not isinstance(stadium_paths, dict):
        raise AnalysisValidationError("Stadium paths must be a JSON object")

    missing_teams = sorted(set(geometry_teams).difference(stadium_paths))
    if missing_teams:
        raise AnalysisValidationError(
            f"Stadium paths are missing geometry for: {', '.join(missing_teams)}"
        )

    for team_code in geometry_teams:
        segments = stadium_paths[team_code]
        if not isinstance(segments, dict):
            raise AnalysisValidationError(
                f"Stadium paths for {team_code} must be an object"
            )
        for segment_name, points in segments.items():
            if not isinstance(points, list):
                raise AnalysisValidationError(
                    f"Stadium path {team_code}.{segment_name} must be a list"
                )
            for point_index, point in enumerate(points):
                if (
                    not isinstance(point, dict)
                    or "x" not in point
                    or "y" not in point
                ):
                    raise AnalysisValidationError(
                        f"Stadium path point {team_code}.{segment_name}"
                        f"[{point_index}] must contain x and y"
                    )
                prefix = f"{team_code}.{segment_name}[{point_index}]"
                require_finite_number(point["x"], f"{prefix}.x")
                require_finite_number(point["y"], f"{prefix}.y")


def validate_ballpark_metadata(metadata, fences_data):
    """Validate versioned current-venue metadata against local geometry."""
    required_fields = {
        "schema_version",
        "data_version",
        "expected_active_venues",
        "advanced_analysis_enabled",
        "analysis_disabled_reason",
        "analysis_release",
        "geometry_files_sha256",
        "team_aliases",
        "verified_venues",
        "retained_venue_mappings",
        "unsupported_venues",
        "excluded_geometry_teams",
    }
    missing_fields = required_fields.difference(metadata)
    if missing_fields:
        raise AnalysisValidationError(
            "Ballpark metadata is missing "
            + ", ".join(sorted(missing_fields))
        )
    if metadata["schema_version"] != 2:
        raise AnalysisValidationError(
            "ballpark metadata schema_version must be 2"
        )

    expected = metadata["expected_active_venues"]
    geometry_hashes = metadata["geometry_files_sha256"]
    verified = metadata["verified_venues"]
    retained = metadata["retained_venue_mappings"]
    unsupported = metadata["unsupported_venues"]
    aliases = metadata["team_aliases"]
    excluded = metadata["excluded_geometry_teams"]
    analysis_enabled = metadata["advanced_analysis_enabled"]
    disabled_reason = metadata["analysis_disabled_reason"]
    release = metadata["analysis_release"]
    data_version = metadata["data_version"]

    if not isinstance(expected, int) or expected <= 0:
        raise AnalysisValidationError(
            "expected_active_venues must be a positive integer"
        )
    if not isinstance(analysis_enabled, bool):
        raise AnalysisValidationError(
            "advanced_analysis_enabled must be boolean"
        )
    if not analysis_enabled and (
        not isinstance(disabled_reason, str) or not disabled_reason.strip()
    ):
        raise AnalysisValidationError(
            "analysis_disabled_reason must explain why analysis is disabled"
        )
    if not isinstance(data_version, str) or not data_version.strip():
        raise AnalysisValidationError("data_version must be a nonempty string")
    if not isinstance(release, dict):
        raise AnalysisValidationError("analysis_release must be an object")
    required_release_fields = {
        "status",
        "verification_schema_version",
        "source_revisions_recorded",
        "calibration_complete",
        "calculation_rendering_walls_aligned",
        "verified_venue_ids",
    }
    missing_release_fields = required_release_fields.difference(release)
    if missing_release_fields:
        raise AnalysisValidationError(
            "analysis_release is missing "
            + ", ".join(sorted(missing_release_fields))
        )
    if release["verification_schema_version"] != 1:
        raise AnalysisValidationError(
            "analysis_release verification_schema_version must be 1"
        )
    for field in (
        "source_revisions_recorded",
        "calibration_complete",
        "calculation_rendering_walls_aligned",
    ):
        if not isinstance(release[field], bool):
            raise AnalysisValidationError(
                f"analysis_release {field} must be boolean"
            )
    if (
        not isinstance(release["verified_venue_ids"], list)
        or any(
            not str(venue_id).isdigit()
            for venue_id in release["verified_venue_ids"]
        )
    ):
        raise AnalysisValidationError(
            "analysis_release verified_venue_ids must contain venue IDs"
        )
    if not isinstance(geometry_hashes, dict):
        raise AnalysisValidationError(
            "geometry_files_sha256 must be an object"
        )
    for file_name in ("fences.json", "stadium_paths.json"):
        expected_hash = geometry_hashes.get(file_name)
        if (
            not isinstance(expected_hash, str)
            or len(expected_hash) != 64
            or any(
                character not in "0123456789abcdef"
                for character in expected_hash.lower()
            )
        ):
            raise AnalysisValidationError(
                f"geometry_files_sha256 has no valid SHA-256 for {file_name}"
            )
    if not isinstance(verified, dict):
        raise AnalysisValidationError("verified_venues must be an object")
    if not isinstance(retained, dict):
        raise AnalysisValidationError(
            "retained_venue_mappings must be an object"
        )
    if not isinstance(unsupported, dict):
        raise AnalysisValidationError("unsupported_venues must be an object")
    if not isinstance(aliases, dict):
        raise AnalysisValidationError("team_aliases must be an object")
    if not isinstance(excluded, list):
        raise AnalysisValidationError(
            "excluded_geometry_teams must be a list"
        )
    if len(retained) + len(unsupported) != expected:
        raise AnalysisValidationError(
            "Retained and unsupported venue counts do not match "
            "expected_active_venues"
        )
    if analysis_enabled:
        if release["status"] != "verified":
            raise AnalysisValidationError(
                "enabled analysis requires analysis_release status verified"
            )
        for field in (
            "source_revisions_recorded",
            "calibration_complete",
            "calculation_rendering_walls_aligned",
        ):
            if release[field] is not True:
                raise AnalysisValidationError(
                    f"enabled analysis requires analysis_release {field}"
                )
        if any(word in data_version.lower() for word in ("disabled", "unverified")):
            raise AnalysisValidationError(
                "enabled analysis data_version cannot be marked disabled or unverified"
            )
        source_revision = str(
            metadata.get("geometry_source_revision") or ""
        ).strip()
        provenance_note = str(
            metadata.get("geometry_source_provenance_note") or ""
        ).lower()
        if not source_revision or source_revision == "checked-in-snapshot":
            raise AnalysisValidationError(
                "enabled analysis requires recorded upstream geometry revisions"
            )
        if "not recorded" in provenance_note or "unrecorded" in provenance_note:
            raise AnalysisValidationError(
                "enabled analysis cannot declare unrecorded geometry provenance"
            )
        if not verified or len(verified) + len(unsupported) != expected:
            raise AnalysisValidationError(
                "enabled analysis requires verified coverage for every non-unsupported venue"
            )
        declared_verified_ids = {
            str(venue_id) for venue_id in release["verified_venue_ids"]
        }
        if declared_verified_ids != set(verified):
            raise AnalysisValidationError(
                "analysis_release verified_venue_ids do not match verified_venues"
            )
    else:
        if release["status"] != "disabled":
            raise AnalysisValidationError(
                "disabled analysis requires analysis_release status disabled"
            )
        if verified or release["verified_venue_ids"]:
            raise AnalysisValidationError(
                "disabled analysis cannot declare verified venues"
            )

    for alias, canonical in aliases.items():
        if not isinstance(alias, str) or not isinstance(canonical, str):
            raise AnalysisValidationError(
                "Team aliases must map string codes to string codes"
            )

    seen_team_codes = set()
    seen_geometry_teams = set()
    for venue_id, venue_data in retained.items():
        if not str(venue_id).isdigit() or not isinstance(venue_data, dict):
            raise AnalysisValidationError(
                f"Invalid retained venue entry: {venue_id}"
            )
        for field in ("team_code", "geometry_team", "venue_name"):
            value = venue_data.get(field)
            if not isinstance(value, str) or not value.strip():
                raise AnalysisValidationError(
                    f"Retained venue {venue_id} has invalid {field}"
                )

        team_code = venue_data["team_code"].upper()
        geometry_team = venue_data["geometry_team"].upper()
        if geometry_team not in fences_data:
            raise AnalysisValidationError(
                f"Retained venue {venue_id} references missing geometry "
                f"{geometry_team}"
            )
        if team_code in seen_team_codes:
            raise AnalysisValidationError(
                f"Duplicate retained team code: {team_code}"
            )
        if geometry_team in seen_geometry_teams:
            raise AnalysisValidationError(
                f"Duplicate retained geometry team: {geometry_team}"
            )
        seen_team_codes.add(team_code)
        seen_geometry_teams.add(geometry_team)

    for venue_id, venue_data in verified.items():
        if venue_id not in retained or venue_data != retained[venue_id]:
            raise AnalysisValidationError(
                f"Verified venue {venue_id} must match its retained mapping"
            )

    for venue_id, venue_data in unsupported.items():
        if not str(venue_id).isdigit() or not isinstance(venue_data, dict):
            raise AnalysisValidationError(
                f"Invalid unsupported venue entry: {venue_id}"
            )
        if not isinstance(venue_data.get("team_code"), str):
            raise AnalysisValidationError(
                f"Unsupported venue {venue_id} has no team_code"
            )
        reason = venue_data.get("reason")
        if not isinstance(reason, str) or not reason.strip():
            raise AnalysisValidationError(
                f"Unsupported venue {venue_id} has no reason"
            )

    unexpected_exclusions = set(excluded).difference(fences_data)
    if unexpected_exclusions:
        raise AnalysisValidationError(
            "Excluded geometry teams are missing from fence data: "
            + ", ".join(sorted(unexpected_exclusions))
        )


def validate_geometry_file_hashes(metadata, geometry_paths):
    """Refuse geometry files that differ from the reviewed metadata pins."""
    expected_hashes = metadata["geometry_files_sha256"]
    for file_name, file_path in geometry_paths.items():
        path_obj = Path(file_path)
        try:
            actual_hash = hashlib.sha256(path_obj.read_bytes()).hexdigest()
        except OSError as exc:
            raise AnalysisValidationError(
                f"Could not verify geometry file {path_obj}: {exc}"
            ) from exc
        if actual_hash != expected_hashes[file_name].lower():
            raise AnalysisValidationError(
                f"{file_name} does not match its reviewed SHA-256 snapshot"
            )


def normalize_team_code(team_code, metadata):
    """Normalize same-franchise aliases without guessing venue geometry."""
    if team_code is None or not str(team_code).strip():
        raise AnalysisValidationError("home_team is required")
    normalized = str(team_code).strip().upper()
    aliases = {
        str(alias).upper(): str(canonical).upper()
        for alias, canonical in metadata["team_aliases"].items()
    }
    return aliases.get(normalized, normalized)


def build_current_fences(fences_data, metadata):
    """Build the explicitly verified current-venue comparison set."""
    if not metadata["advanced_analysis_enabled"]:
        raise UnsupportedVenueError(metadata["analysis_disabled_reason"])
    current_fences = {}
    for venue_id, venue_data in metadata["verified_venues"].items():
        team_code = venue_data["team_code"].upper()
        geometry_team = venue_data["geometry_team"].upper()
        geometry = fences_data[geometry_team]
        current_fences[team_code] = {
            "stadium": venue_data["venue_name"],
            "fence_points": geometry["fence_points"],
            "geometry_team": geometry_team,
            "venue_id": int(venue_id),
        }
    return current_fences


def resolve_home_venue(home_team, venue_id, metadata):
    """Resolve a current venue or fail without a fabricated fallback."""
    if not metadata["advanced_analysis_enabled"]:
        raise UnsupportedVenueError(metadata["analysis_disabled_reason"])

    normalized_team = normalize_team_code(home_team, metadata)
    supported = metadata["verified_venues"]
    unsupported = metadata["unsupported_venues"]

    if venue_id is not None and str(venue_id).strip() != "":
        venue_key = str(venue_id).strip()
        if not venue_key.isdigit():
            raise AnalysisValidationError(
                "venue_id must contain only digits"
            )
        if venue_key in unsupported:
            entry = unsupported[venue_key]
            raise UnsupportedVenueError(
                f"{entry.get('venue_name', 'Venue')} ({venue_key}) is "
                f"unsupported: {entry['reason']}"
            )
        if venue_key not in supported:
            raise UnsupportedVenueError(
                f"Venue {venue_key} is unsupported because no verified local "
                "geometry is available"
            )

        entry = supported[venue_key]
        expected_team = entry["team_code"].upper()
        if normalized_team != expected_team:
            raise AnalysisValidationError(
                f"home_team {normalized_team} does not match venue "
                f"{venue_key} ({expected_team})"
            )
        return {
            "venue_id": int(venue_key),
            "venue_name": entry["venue_name"],
            "team_code": expected_team,
            "geometry_team": entry["geometry_team"].upper(),
        }

    for venue_key, entry in supported.items():
        if entry["team_code"].upper() == normalized_team:
            return {
                "venue_id": int(venue_key),
                "venue_name": entry["venue_name"],
                "team_code": normalized_team,
                "geometry_team": entry["geometry_team"].upper(),
            }

    for venue_key, entry in unsupported.items():
        if entry["team_code"].upper() == normalized_team:
            raise UnsupportedVenueError(
                f"{entry.get('venue_name', normalized_team)} ({venue_key}) is "
                f"unsupported: {entry['reason']}"
            )

    raise UnsupportedVenueError(
        f"Team {normalized_team} is unsupported because no verified current "
        "venue geometry is available"
    )


def compute_spray_angle(hc_x, hc_y):
    """Compute spray angle from Statcast hit coordinates (MLBAM system)."""
    hc_x_ = SCALE * (hc_x - 125.0)
    hc_y_ = SCALE * (199.0 - hc_y)
    if hc_x_ == 0 and hc_y_ == 0:
        return 0.0
    spray = math.degrees(math.atan2(hc_x_, hc_y_)) * 0.75
    return round(spray, 1)


def compute_landing_xy(hc_x, hc_y, hit_distance):
    """Compute landing spot x,y in the fence coordinate system."""
    hc_x_ = SCALE * (hc_x - 125.0)
    hc_y_ = SCALE * (199.0 - hc_y)
    r = math.sqrt(hc_x_ ** 2 + hc_y_ ** 2)
    if r == 0:
        return 0.0, hit_distance
    # Scale the direction vector to the actual hit distance
    land_x = hc_x_ / r * hit_distance
    land_y = hc_y_ / r * hit_distance
    return land_x, land_y


def compute_stadium_spray_angle(x_value, y_value):
    """Compute spray angle from already-transformed stadium coordinates."""
    if y_value == 0:
        return 0.0
    return math.degrees(math.atan2(x_value, y_value)) * 0.75


def get_team_logo_url(team_abbr):
    """Return ESPN CDN logo URL for the given MLB team abbreviation."""
    logo_code = TEAM_LOGO_CODES.get((team_abbr or "").upper())
    if not logo_code:
        return None
    return f"https://a.espncdn.com/i/teamlogos/mlb/500/{logo_code}.png"


def get_player_headshot_url(player_id):
    """Return MLB headshot URL for the given player ID."""
    if not player_id:
        return None
    return (
        "https://img.mlbstatic.com/mlb-photos/image/upload/"
        "d_people:generic:headshot:67:current.png/w_213,q_auto:best/"
        f"v1/people/{player_id}/headshot/67/current"
    )


def load_cached_image(
    url,
    cache_dir,
    cache_name,
    max_age_seconds=IMAGE_CACHE_MAX_AGE_SECONDS,
):
    """Download, validate, and atomically cache an image as an RGBA array."""
    if not url:
        return None

    os.makedirs(cache_dir, exist_ok=True)
    cache_path = os.path.join(cache_dir, cache_name)

    if os.path.exists(cache_path):
        try:
            cache_age = max(0.0, time.time() - os.path.getmtime(cache_path))
            if cache_age > max_age_seconds:
                raise ValueError("Cached image is stale")
            with Image.open(cache_path) as cached_image:
                if cached_image.width * cached_image.height > MAX_IMAGE_PIXELS:
                    raise ValueError("Cached image dimensions are too large")
                cached_image.load()
                return np.array(cached_image.convert("RGBA"))
        except Exception:
            try:
                os.remove(cache_path)
            except OSError:
                pass

    request = urllib.request.Request(
        url,
        headers={"User-Agent": "Mozilla/5.0"},
    )
    temp_path = None
    try:
        with urllib.request.urlopen(
            request,
            timeout=IMAGE_DOWNLOAD_TIMEOUT_SECONDS,
        ) as response:
            content_type = (
                response.headers.get("Content-Type", "")
                .split(";", 1)[0]
                .strip()
                .lower()
            )
            if not content_type.startswith("image/"):
                raise ValueError(
                    f"Unexpected image content type: {content_type or 'missing'}"
                )

            content_length = response.headers.get("Content-Length")
            if content_length is not None:
                try:
                    declared_size = int(content_length)
                except (TypeError, ValueError) as exc:
                    raise ValueError(
                        "Invalid image Content-Length header"
                    ) from exc
                if (
                    declared_size < 0
                    or declared_size > MAX_IMAGE_DOWNLOAD_BYTES
                ):
                    raise ValueError("Image response is too large")

            payload = response.read(MAX_IMAGE_DOWNLOAD_BYTES + 1)
            if not payload or len(payload) > MAX_IMAGE_DOWNLOAD_BYTES:
                raise ValueError("Image response is empty or too large")

        with Image.open(io.BytesIO(payload)) as downloaded_image:
            if (
                downloaded_image.width * downloaded_image.height
                > MAX_IMAGE_PIXELS
            ):
                raise ValueError("Image dimensions are too large")
            downloaded_image.load()
            image_array = np.array(downloaded_image.convert("RGBA"))

        with tempfile.NamedTemporaryFile(
            mode="wb",
            dir=cache_dir,
            prefix=f".{Path(cache_name).name}.",
            suffix=".tmp",
            delete=False,
        ) as image_file:
            temp_path = image_file.name
            image_file.write(payload)
            image_file.flush()
            os.fsync(image_file.fileno())
        os.replace(temp_path, cache_path)
        temp_path = None
        return image_array
    except Exception:
        if temp_path:
            try:
                os.remove(temp_path)
            except OSError:
                pass
        return None


def dedupe_fence_plot_points(fence_points):
    """Remove duplicate spray-angle points for plotting while keeping fence shape smooth."""
    by_angle = {}
    ordered_angles = []

    for point in fence_points:
        angle_key = round(float(point["spray_angle"]), 4)
        if angle_key not in by_angle:
            ordered_angles.append(angle_key)
            by_angle[angle_key] = point
            continue

        # Prefer the smoother inner point when duplicate spray angles exist.
        if float(point["d_wall"]) < float(by_angle[angle_key]["d_wall"]):
            by_angle[angle_key] = point

    return [by_angle[angle_key] for angle_key in ordered_angles]


def extract_outfield_wall_path(path_points, foul_line_points):
    """Extract the foul-pole-to-foul-pole wall run from GeomMLBStadiums outfield paths."""
    if len(path_points) < 3:
        return path_points

    left_line = [point for point in foul_line_points if point["x"] <= 0]
    right_line = [point for point in foul_line_points if point["x"] >= 0]
    if not left_line or not right_line:
        return path_points

    def pole_subset(line_points):
        distances = [
            math.hypot(float(point["x"]), float(point["y"]))
            for point in line_points
        ]
        cutoff = np.percentile(distances, 80)
        subset = [
            point
            for point, distance in zip(line_points, distances)
            if distance >= cutoff
        ]
        return subset or line_points

    def nearest_index(target_points):
        best_index = 0
        best_distance = float("inf")
        for index, point in enumerate(path_points):
            for target in target_points:
                dx = float(point["x"]) - float(target["x"])
                dy = float(point["y"]) - float(target["y"])
                distance = (dx * dx) + (dy * dy)
                if distance < best_distance:
                    best_distance = distance
                    best_index = index
        return best_index

    left_index = nearest_index(pole_subset(left_line))
    right_index = nearest_index(pole_subset(right_line))
    if left_index == right_index:
        return path_points

    start_index, end_index = sorted((left_index, right_index))
    direct_run = path_points[start_index:end_index + 1]
    wrapped_run = path_points[end_index:] + path_points[:start_index + 1]

    def run_score(points):
        avg_y = sum(float(point["y"]) for point in points) / len(points)
        avg_radius = sum(
            math.hypot(float(point["x"]), float(point["y"]))
            for point in points
        ) / len(points)
        return avg_y, avg_radius, len(points)

    return max((direct_run, wrapped_run), key=run_score)


def build_outfield_overlay(path_points, fence_points):
    """Project independently verified fence heights onto an outfield wall."""
    overlay_points = []
    for point in path_points:
        spray_angle = compute_stadium_spray_angle(point["x"], point["y"])
        fence_point = find_nearest_fence_point(spray_angle, fence_points)
        if fence_point is None:
            continue

        overlay_points.append(
            {
                "x": point["x"],
                "y": point["y"],
                "fence_height": float(fence_point["fence_height"]),
            }
        )
    return overlay_points


def spray_direction(angle):
    """Human-readable spray direction."""
    if angle < -15:
        return "Left Field"
    elif angle < -5:
        return "Left-Center"
    elif angle <= 5:
        return "Center Field"
    elif angle <= 15:
        return "Right-Center"
    else:
        return "Right Field"


def compute_flight_time(launch_speed, launch_angle_deg, plate_z):
    """Return flight time until a ball launched at plate_z reaches the ground."""
    launch_angle_rad = math.radians(launch_angle_deg)
    velocity = launch_speed * 5280.0 / 3600.0
    vertical_velocity = velocity * math.sin(launch_angle_rad)

    # Solve plate_z + vy*t + 0.5*G*t^2 = 0. Because G is negative,
    # the discriminant must subtract 2*G*plate_z.
    discriminant = vertical_velocity ** 2 - 2.0 * G * plate_z
    if discriminant < 0:
        raise AnalysisValidationError(
            "Launch inputs do not produce a real ground-impact time"
        )

    total_time = -(vertical_velocity + math.sqrt(discriminant)) / G
    if not math.isfinite(total_time) or total_time <= 0:
        raise AnalysisValidationError(
            "Launch inputs do not produce a positive flight time"
        )
    return total_time


def would_it_dong(launch_speed, launch_angle_deg, hit_distance, plate_z,
                  fence_points, force_dong=False):
    """
    Evaluate whether the modeled trajectory clears a supplied fence point.
    Returns (clears: bool, height_at_wall: float, fence_height: float).
    """
    launch_angle_rad = math.radians(launch_angle_deg)
    v0 = launch_speed * 5280.0 / 3600.0

    vx = v0 * math.cos(launch_angle_rad)
    vy = v0 * math.sin(launch_angle_rad)
    total_time = compute_flight_time(
        launch_speed,
        launch_angle_deg,
        plate_z,
    )

    # Back-calculate horizontal acceleration so the modeled trajectory lands
    # at the measured Statcast distance at total_time.
    ax = (-2.0 * vx / total_time) + (2.0 * hit_distance / (total_time ** 2))

    d_wall = require_finite_number(
        fence_points["d_wall"],
        "fence d_wall",
        minimum=1.0,
        maximum=1000.0,
    )
    fence_height = require_finite_number(
        fence_points["fence_height"],
        "fence height",
        minimum=0.0,
        maximum=100.0,
    )

    # Select the earliest non-negative root of
    # d_wall = vx*t + 0.5*ax*t^2.
    if vx <= 0:
        return force_dong, 0.0, fence_height
    if abs(ax) < 1e-12:
        t_wall = d_wall / vx
    else:
        disc_wall = vx ** 2 + 2.0 * ax * d_wall
        if disc_wall < 0:
            return force_dong, 0.0, fence_height
        sqrt_disc_wall = math.sqrt(disc_wall)
        candidate_times = [
            (-vx + sqrt_disc_wall) / ax,
            (-vx - sqrt_disc_wall) / ax,
        ]
        non_negative_times = [
            candidate
            for candidate in candidate_times
            if math.isfinite(candidate) and candidate >= 0
        ]
        if not non_negative_times:
            return force_dong, 0.0, fence_height
        t_wall = min(non_negative_times)

    # Fence heights are measured from field level, so preserve the contact
    # height rather than treating the ball as launched from the ground.
    height_at_wall = plate_z + vy * t_wall + 0.5 * G * (t_wall ** 2)

    clears = height_at_wall > fence_height
    if force_dong:
        clears = True

    return clears, round(height_at_wall, 1), fence_height


def find_nearest_fence_point(spray_angle, fence_points_list):
    """Find the fence point with the nearest spray angle (no interpolation)."""
    best = None
    best_diff = float("inf")
    for pt in fence_points_list:
        diff = abs(spray_angle - pt["spray_angle"])
        if diff < best_diff:
            best_diff = diff
            best = pt
    return best


def analyze_all_parks(launch_speed, launch_angle, hit_distance, plate_z,
                      spray_angle, home_team, fences_data):
    """Check would-it-dong across every supplied supported park."""
    parks_cleared = []
    parks_not_cleared = []
    park_details = []

    for team, data in sorted(fences_data.items()):
        fence_pt = find_nearest_fence_point(spray_angle, data["fence_points"])
        if fence_pt is None:
            continue

        is_home = (team == home_team)
        modeled_clears, h_wall, f_height = would_it_dong(
            launch_speed, launch_angle, hit_distance, plate_z,
            fence_pt, force_dong=False
        )
        forced_home_result = bool(is_home and not modeled_clears)
        clears = modeled_clears or is_home

        detail = {
            "team": team,
            "geometry_team": data.get("geometry_team", team),
            "venue_id": data.get("venue_id"),
            "stadium": data["stadium"],
            "clears": clears,
            "forced_home_result": forced_home_result,
            "height_at_wall": h_wall,
            "fence_height": f_height,
            "wall_distance": fence_pt["d_wall"],
        }
        park_details.append(detail)

        if clears:
            parks_cleared.append(team)
        else:
            parks_not_cleared.append(team)

    return parks_cleared, parks_not_cleared, park_details


# ── Image generation ──────────────────────────────────────────────────────────

def generate_image(fences_data, home_team, spray_angle, hit_distance,
                   hc_x, hc_y, player_name, launch_speed, launch_angle,
                   total_dongs, parks_evaluated, pitcher_name, output_path,
                   stadium_paths=None, fence_height=None, player_id=None,
                   asset_cache_dir=None):
    """Generate a neutral ballpark overlay image."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.patches as patches
    import matplotlib.pyplot as plt
    from matplotlib.collections import LineCollection
    from matplotlib.colors import LinearSegmentedColormap

    # Wall-height gradient: teal to dark navy.
    wall_cmap = LinearSegmentedColormap.from_list(
        "wall_height", ["#5BA8D0", "#003459"])

    fig, ax = plt.subplots(1, 1, figsize=(8.75, 6.6))
    fig.patch.set_facecolor("white")
    ax.set_facecolor("white")

    # Get home park fence data
    home_data = fences_data.get(home_team)
    if not home_data:
        raise UnsupportedVenueError(
            f"No verified geometry is available for home team {home_team}"
        )

    fence_pts = home_data["fence_points"]
    stadium_name = home_data["stadium"]
    geometry_team = home_data.get("geometry_team", home_team)

    path_x = []
    path_y = []
    outfield_wall_points = []

    # Draw stadium outline from GeomMLBStadiums path data
    if stadium_paths and geometry_team in stadium_paths:
        path_data = stadium_paths[geometry_team]
        segment_styles = {
            "foul_lines": {"linewidth": 1.6, "zorder": 2},
            "home_plate": {"linewidth": 1.4, "zorder": 2},
            "infield_inner": {"linewidth": 1.3, "zorder": 2},
            "infield_outer": {"linewidth": 1.3, "zorder": 2},
            "outfield_inner": {"linewidth": 1.3, "zorder": 2},
            "outfield_outer": {"linewidth": 1.6, "zorder": 2},
        }

        for segment_name in (
            "foul_lines",
            "home_plate",
            "infield_inner",
            "infield_outer",
            "outfield_inner",
            "outfield_outer",
        ):
            points = path_data.get(segment_name)
            if not points or len(points) < 2:
                continue

            sx = [p["x"] for p in points]
            sy = [p["y"] for p in points]
            path_x.extend(sx)
            path_y.extend(sy)

            ax.plot(
                sx,
                sy,
                color="black",
                linewidth=segment_styles[segment_name]["linewidth"],
                zorder=segment_styles[segment_name]["zorder"],
                solid_joinstyle="round",
                solid_capstyle="round",
            )

        wall_path_points = extract_outfield_wall_path(
            path_data.get("outfield_outer", []),
            path_data.get("foul_lines", []),
        )
        outfield_wall_points = build_outfield_overlay(wall_path_points, fence_pts)
    else:
        outfield_wall_points = dedupe_fence_plot_points(fence_pts)
        path_x.extend(point["x"] for point in outfield_wall_points)
        path_y.extend(point["y"] for point in outfield_wall_points)

    # Draw wall overlay using exact GeomMLBStadiums outfield geometry.
    fx = [pt["x"] for pt in outfield_wall_points]
    fy = [pt["y"] for pt in outfield_wall_points]
    fh = [pt["fence_height"] for pt in outfield_wall_points]
    home_fence_pt = find_nearest_fence_point(spray_angle, fence_pts)
    wall_distance = home_fence_pt["d_wall"] if home_fence_pt else None

    if len(outfield_wall_points) >= 2:
        ax.plot(
            fx,
            fy,
            color="#12314a",
            linewidth=4.0,
            zorder=2.8,
            solid_joinstyle="round",
            solid_capstyle="round",
        )

        points_arr = np.array([fx, fy]).T.reshape(-1, 1, 2)
        segments = np.concatenate([points_arr[:-1], points_arr[1:]], axis=1)
        heights = [(fh[i] + fh[i + 1]) / 2 for i in range(len(fh) - 1)]

        norm = plt.Normalize(vmin=min(fh), vmax=max(fh))
        lc = LineCollection(segments, cmap=wall_cmap, norm=norm,
                            linewidths=3.1, zorder=3)
        lc.set_array(np.array(heights))
        ax.add_collection(lc)

    # Ball flight path — landing spot
    land_x, land_y = compute_landing_xy(hc_x, hc_y, hit_distance)

    # Keep the visual arc shallow and orient it with the spray angle.
    curv = spray_angle / (-90.0)

    # Draw solid blue flight line
    ax.annotate("", xy=(land_x, land_y), xytext=(0, 0),
                arrowprops=dict(arrowstyle="-", color="#0047AB",
                                connectionstyle=f"arc3,rad={curv}",
                                linewidth=2.5),
                zorder=5)

    # Landing spot — explosion/star marker
    ax.plot(land_x, land_y, marker="*", color="red", markersize=20,
            markeredgecolor="orange", markeredgewidth=1.2, zorder=6)

    # Compute plot bounds
    field_x = fx + path_x + [0]
    field_y = fy + path_y + [0]
    field_min_x = min(field_x)
    field_max_x = max(field_x)
    field_min_y = min(field_y)
    field_max_y = max(field_y)

    all_x = field_x + [land_x]
    all_y = field_y + [land_y]
    layout_min_x = min(all_x) - 24
    layout_min_y = min(all_y) - 40
    layout_max_y = max(all_y) + 20
    right_panel_width = 88
    layout_max_x = max(field_max_x, land_x) + right_panel_width

    field_height = field_max_y - field_min_y
    label_center_x = (field_min_x + field_max_x) / 2
    info_x = layout_min_x + 6
    info_y = layout_min_y + 6
    asset_cache_dir = asset_cache_dir or os.path.join(
        os.path.dirname(output_path) or ".", "asset_cache"
    )
    logo_image = load_cached_image(
        get_team_logo_url(home_team),
        asset_cache_dir,
        f"team_logo_{home_team.lower()}.png",
    )
    player_headshot = load_cached_image(
        get_player_headshot_url(player_id),
        asset_cache_dir,
        f"player_headshot_{player_id}.png",
    ) if player_id else None

    if logo_image is not None:
        logo_height = field_height * 0.23
        logo_width = logo_height * (logo_image.shape[1] / logo_image.shape[0])
        logo_center_y = field_min_y + field_height * 0.64
        ax.imshow(
            logo_image,
            extent=(
                label_center_x - logo_width / 2,
                label_center_x + logo_width / 2,
                logo_center_y - logo_height / 2,
                logo_center_y + logo_height / 2,
            ),
            alpha=0.14,
            zorder=0.6,
        )
        stadium_label_y = field_min_y + field_height * 0.48
    else:
        team_label_y = field_min_y + field_height * 0.64
        stadium_label_y = field_min_y + field_height * 0.48
        ax.text(label_center_x, team_label_y, home_team, fontsize=11,
                ha="center", va="bottom", alpha=0.65, color="#003459",
                fontweight="bold", zorder=1)

    ax.text(label_center_x, stadium_label_y, stadium_name, fontsize=14,
            ha="center", va="bottom", alpha=0.28, color="#6f6f6f", zorder=1)

    details_lines = [
        f"Exit Velo: {launch_speed:.1f} mph",
        f"Launch Angle: {launch_angle:.1f}°",
    ]
    if wall_distance is not None:
        details_lines.append(f"Wall Dist: {int(round(wall_distance))} ft")
    if pitcher_name and pitcher_name != "Unknown":
        details_lines.append(f"Off: {pitcher_name}")

    details_text = "\n".join(details_lines)
    ax.text(layout_max_x - 8, info_y + 34, details_text,
            fontsize=8.2, ha="right", va="bottom", color="#1a1a1a",
            linespacing=1.15, zorder=10)

    # Distance stays in the bottom-right corner
    ax.text(layout_max_x - 8, info_y,
            f"{int(round(hit_distance))} FT", fontsize=15, ha="right",
            va="bottom", alpha=0.75, color="#3B73C5",
            fontweight="bold", zorder=10)

    # Player info text (bottom-left)
    park_label = "parks" if parks_evaluated == 30 else "supported parks"
    info_text = (
        f"{player_name}\nHome Run\n"
        f"HR in {total_dongs}/{parks_evaluated} {park_label}"
    )
    if player_headshot is not None:
        portrait_height = field_height * 0.21
        portrait_width = portrait_height * (
            player_headshot.shape[1] / player_headshot.shape[0]
        )
        portrait_bottom = info_y + 58
        ax.imshow(
            player_headshot,
            extent=(
                info_x,
                info_x + portrait_width,
                portrait_bottom,
                portrait_bottom + portrait_height,
            ),
            zorder=10,
        )
        ax.add_patch(
            patches.Rectangle(
                (info_x, portrait_bottom),
                portrait_width,
                portrait_height,
                fill=False,
                edgecolor="#d0d0d0",
                linewidth=0.8,
                zorder=11,
            )
        )

    ax.text(info_x, info_y, info_text, fontsize=10.5, ha="left",
            va="bottom", fontweight="semibold", zorder=10)

    # Wall-height legend on the right side.
    if fence_height is not None and fence_height > 0:
        legend_min = min(fh)
        legend_max = max(fh)
        legend_width = 18
        legend_height = 84 if legend_min == legend_max else 112
        legend_x = layout_max_x - legend_width - 18
        legend_bottom = info_y + 86
        legend_top = legend_bottom + legend_height

        if legend_min == legend_max:
            legend_vmin = legend_min - 1
            legend_vmax = legend_max + 1
        else:
            legend_vmin = legend_min
            legend_vmax = legend_max

        legend_norm = plt.Normalize(vmin=legend_vmin, vmax=legend_vmax)
        gradient = np.linspace(legend_vmin, legend_vmax, 256).reshape(256, 1)
        ax.imshow(
            gradient,
            extent=(legend_x, legend_x + legend_width, legend_bottom, legend_top),
            origin="lower",
            cmap=wall_cmap,
            norm=legend_norm,
            aspect="auto",
            zorder=8,
        )
        ax.add_patch(
            patches.Rectangle(
                (legend_x, legend_bottom),
                legend_width,
                legend_height,
                fill=False,
                edgecolor="#1a1a1a",
                linewidth=0.8,
                zorder=9,
            )
        )

        ax.text(legend_x + legend_width / 2, legend_top + 14,
                "Wall Height (ft)", fontsize=10, ha="center", va="bottom",
                fontweight="bold", color="#1a1a1a", zorder=9)

        unique_heights = sorted({int(round(height)) for height in fh})
        if len(unique_heights) > 5:
            tick_values = [int(round(value)) for value in np.linspace(
                legend_min, legend_max, 5
            )]
        else:
            tick_values = unique_heights

        for tick in sorted(set(tick_values)):
            tick_y = legend_bottom + (
                (tick - legend_vmin) / (legend_vmax - legend_vmin)
            ) * legend_height
            ax.plot([legend_x - 3, legend_x], [tick_y, tick_y],
                    color="#ffffff", linewidth=0.8, alpha=0.85, zorder=9)
            ax.plot([legend_x + legend_width, legend_x + legend_width + 3],
                    [tick_y, tick_y], color="#ffffff", linewidth=0.8,
                    alpha=0.85, zorder=9)
            ax.text(legend_x + legend_width + 9, tick_y, str(tick),
                    fontsize=9.5, ha="left", va="center",
                    color="#1a1a1a", zorder=9)

        marker_y = legend_bottom + (
            (fence_height - legend_vmin) / (legend_vmax - legend_vmin)
        ) * legend_height
        ax.plot([legend_x - 14, legend_x], [marker_y, marker_y],
                color="#1a1a1a", linewidth=0.8,
                linestyle=(0, (3, 2)), zorder=9)
        ax.text(legend_x - 16, marker_y, str(int(round(fence_height))),
                fontsize=10.5, ha="right", va="center",
                fontweight="bold", color="#1a1a1a", zorder=9)

    # Clean up axes
    ax.set_aspect("equal")
    ax.set_xlim(layout_min_x, layout_max_x)
    ax.set_ylim(layout_min_y, layout_max_y)
    ax.axis("off")
    fig.subplots_adjust(left=0.02, right=0.98, top=0.98, bottom=0.02)

    # Save at high DPI
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    fig.savefig(output_path, dpi=300, bbox_inches="tight",
                facecolor="white", edgecolor="none")
    plt.close(fig)


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="HR Analysis Engine")
    parser.add_argument("--launch_speed", type=float, required=True)
    parser.add_argument("--launch_angle", type=float, required=True)
    parser.add_argument("--hit_distance", type=float, required=True)
    parser.add_argument("--hc_x", type=float, required=True)
    parser.add_argument("--hc_y", type=float, required=True)
    parser.add_argument("--plate_z", type=float, default=3.5)
    parser.add_argument("--home_team", type=str, required=True)
    parser.add_argument("--venue_id", type=str, default=None)
    parser.add_argument("--player_name", type=str, default="Unknown")
    parser.add_argument("--player_id", type=str, default=None)
    parser.add_argument("--pitcher_name", type=str, default="Unknown")
    parser.add_argument("--output_image", type=str, required=True)
    parser.add_argument(
        "--asset_cache_dir",
        type=str,
        default=None,
        help="Persistent directory for validated team logos and headshots",
    )
    parser.add_argument("--fences_path", type=str, required=True)
    parser.add_argument("--stadium_paths", type=str, required=True)
    parser.add_argument(
        "--ballpark_metadata",
        type=str,
        default=str(DEFAULT_METADATA_PATH),
    )

    args = parser.parse_args()

    metrics = validate_analysis_inputs(
        args.launch_speed,
        args.launch_angle,
        args.hit_distance,
        args.hc_x,
        args.hc_y,
        args.plate_z,
    )
    player_id = normalize_player_id(args.player_id)

    raw_fences_data = load_json_object(args.fences_path, "fence data")
    metadata = load_json_object(
        args.ballpark_metadata,
        "ballpark metadata",
    )
    validate_ballpark_metadata(metadata, raw_fences_data)
    geometry_paths = {
        "fences.json": args.fences_path,
        "stadium_paths.json": args.stadium_paths,
    }
    validate_geometry_file_hashes(metadata, geometry_paths)
    if metadata["advanced_analysis_enabled"]:
        validate_fences_data(raw_fences_data)
    resolved_venue = resolve_home_venue(
        args.home_team,
        args.venue_id,
        metadata,
    )
    fences_data = build_current_fences(raw_fences_data, metadata)

    stadium_paths = load_json_object(
        args.stadium_paths,
        "stadium paths",
    )
    validate_stadium_paths(
        stadium_paths,
        {
            park_data["geometry_team"]
            for park_data in fences_data.values()
        },
    )

    # Compute spray angle
    spray_angle = compute_spray_angle(metrics["hc_x"], metrics["hc_y"])
    direction = spray_direction(spray_angle)
    home_team = resolved_venue["team_code"]

    # Analyze all parks
    parks_cleared, parks_not_cleared, park_details = analyze_all_parks(
        metrics["launch_speed"],
        metrics["launch_angle"],
        metrics["hit_distance"],
        metrics["plate_z"],
        spray_angle,
        home_team,
        fences_data,
    )

    total_dongs = len(parks_cleared)
    parks_evaluated = len(park_details)
    parks_expected = metadata["expected_active_venues"]
    analysis_warnings = []
    if parks_evaluated < parks_expected:
        unavailable_names = [
            entry.get("venue_name", entry.get("team_code", "unknown venue"))
            for entry in metadata["unsupported_venues"].values()
        ]
        analysis_warnings.append(
            f"Evaluated {parks_evaluated} of {parks_expected} active venues; "
            "verified geometry is unavailable for "
            + ", ".join(unavailable_names)
        )
    analysis_status = "ok" if not analysis_warnings else "partial"

    # Get fence height at home park for image
    home_fence_pt = find_nearest_fence_point(
        spray_angle,
        fences_data[home_team]["fence_points"],
    )
    home_fence_height = home_fence_pt["fence_height"] if home_fence_pt else None

    # Generate image
    image_error = None
    try:
        generate_image(
            fences_data,
            home_team,
            spray_angle,
            metrics["hit_distance"],
            metrics["hc_x"],
            metrics["hc_y"],
            args.player_name,
            metrics["launch_speed"],
            metrics["launch_angle"],
            total_dongs,
            parks_evaluated,
            args.pitcher_name,
            args.output_image,
            stadium_paths=stadium_paths,
            fence_height=home_fence_height,
            player_id=player_id,
            asset_cache_dir=args.asset_cache_dir,
        )
        image_generated = True
    except Exception as e:
        image_generated = False
        image_error = str(e)
        pyplot = sys.modules.get("matplotlib.pyplot")
        if pyplot is not None:
            pyplot.close("all")
        print(f"Image generation error: {e}", file=sys.stderr)

    # Output JSON
    result = {
        "success": True,
        "error": None,
        "analysis_status": analysis_status,
        "analysis_error": None,
        "analysis_warnings": analysis_warnings,
        "image_status": "ok" if image_generated else "error",
        "image_error": image_error,
        "ballpark_data_version": metadata["data_version"],
        "venue_id": resolved_venue["venue_id"],
        "venue_name": resolved_venue["venue_name"],
        "geometry_team": resolved_venue["geometry_team"],
        "spray_angle": spray_angle,
        "spray_direction": direction,
        "total_dongs": total_dongs,
        "parks_evaluated": parks_evaluated,
        "parks_expected": parks_expected,
        "parks_cleared": parks_cleared,
        "parks_not_cleared": parks_not_cleared,
        "park_details": park_details,
        "image_path": args.output_image if image_generated else None,
    }

    print(json.dumps(result, allow_nan=False))


def build_error_result(error):
    """Return a stable JSON contract for analysis failures."""
    return {
        "success": False,
        "error": str(error),
        "analysis_status": "error",
        "analysis_error": str(error),
        "analysis_warnings": [],
        "image_status": "not_attempted",
        "image_error": None,
        "ballpark_data_version": None,
        "venue_id": None,
        "venue_name": None,
        "geometry_team": None,
        "spray_angle": None,
        "spray_direction": None,
        "total_dongs": None,
        "parks_evaluated": 0,
        "parks_expected": None,
        "parks_cleared": [],
        "parks_not_cleared": [],
        "park_details": [],
        "image_path": None,
    }


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        error_result = build_error_result(e)
        print(json.dumps(error_result, allow_nan=False))
        sys.exit(1)
