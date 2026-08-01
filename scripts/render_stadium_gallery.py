#!/usr/bin/env python3
"""Render a metadata-bound stadium gallery for offline visual inspection."""

import argparse
import hashlib
import json
from math import ceil
from pathlib import Path
import sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

from hr_analysis import extract_outfield_wall_path


def _load_json_object(path, label):
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"Could not load {label} from {path}: {exc}") from exc
    if not isinstance(payload, dict):
        raise ValueError(f"{label} must be a JSON object")
    return payload


def release_is_verified(metadata):
    """Return true only for a complete schema-2 verified release."""
    release = metadata.get("analysis_release")
    verified_venues = metadata.get("verified_venues")
    retained_mappings = metadata.get("retained_venue_mappings")
    unsupported_venues = metadata.get("unsupported_venues")
    expected_venues = metadata.get("expected_active_venues")
    data_version = str(metadata.get("data_version") or "").lower()
    source_revision = str(
        metadata.get("geometry_source_revision") or ""
    ).strip()
    provenance_note = str(
        metadata.get("geometry_source_provenance_note") or ""
    ).lower()
    if (
        metadata.get("schema_version") != 2
        or metadata.get("advanced_analysis_enabled") is not True
        or not isinstance(release, dict)
        or not isinstance(verified_venues, dict)
        or not verified_venues
        or not isinstance(retained_mappings, dict)
        or not isinstance(unsupported_venues, dict)
        or not isinstance(expected_venues, int)
        or len(verified_venues) + len(unsupported_venues) != expected_venues
        or any(
            venue_id not in retained_mappings
            or venue != retained_mappings[venue_id]
            or not venue.get("geometry_team")
            for venue_id, venue in verified_venues.items()
            if isinstance(venue, dict)
        )
        or any(
            not isinstance(venue, dict)
            for venue in verified_venues.values()
        )
        or any(word in data_version for word in ("disabled", "unverified"))
        or not source_revision
        or source_revision == "checked-in-snapshot"
        or "not recorded" in provenance_note
        or "unrecorded" in provenance_note
    ):
        return False

    declared_ids = release.get("verified_venue_ids")
    return (
        release.get("status") == "verified"
        and release.get("verification_schema_version") == 1
        and release.get("source_revisions_recorded") is True
        and release.get("calibration_complete") is True
        and release.get("calculation_rendering_walls_aligned") is True
        and isinstance(declared_ids, list)
        and {str(venue_id) for venue_id in declared_ids}
        == set(verified_venues)
    )


def load_gallery_inputs(paths_path, metadata_path):
    """Load and integrity-check a stadium-path snapshot and its metadata."""
    metadata = _load_json_object(metadata_path, "ballpark metadata")
    if metadata.get("schema_version") != 2:
        raise ValueError("Ballpark metadata schema_version must be 2")
    if not isinstance(metadata.get("advanced_analysis_enabled"), bool):
        raise ValueError(
            "Ballpark metadata advanced_analysis_enabled must be boolean"
        )
    if not isinstance(metadata.get("analysis_release"), dict):
        raise ValueError("Ballpark metadata analysis_release must be an object")

    expected_hash = (
        metadata.get("geometry_files_sha256", {})
        .get("stadium_paths.json")
    )
    if (
        not isinstance(expected_hash, str)
        or len(expected_hash) != 64
        or any(character not in "0123456789abcdef"
               for character in expected_hash.lower())
    ):
        raise ValueError(
            "Ballpark metadata has no valid stadium_paths.json SHA-256 pin"
        )
    try:
        actual_hash = hashlib.sha256(paths_path.read_bytes()).hexdigest()
    except OSError as exc:
        raise ValueError(
            f"Could not read stadium paths from {paths_path}: {exc}"
        ) from exc
    if actual_hash != expected_hash.lower():
        raise ValueError(
            "stadium_paths.json does not match the metadata SHA-256 pin"
        )

    stadium_paths = _load_json_object(paths_path, "stadium paths")
    return stadium_paths, metadata


def select_gallery_teams(stadium_paths, metadata):
    """Choose only verified teams for a verified release."""
    if release_is_verified(metadata):
        verified_teams = {
            str(venue["geometry_team"]).upper()
            for venue in metadata["verified_venues"].values()
            if isinstance(venue, dict) and venue.get("geometry_team")
        }
        missing_teams = sorted(verified_teams.difference(stadium_paths))
        if missing_teams:
            raise ValueError(
                "Verified stadium paths are missing for "
                + ", ".join(missing_teams)
            )
        teams = sorted(verified_teams)
    else:
        teams = sorted(
            team for team in stadium_paths
            if team != "generic"
        )

    if not teams:
        raise ValueError("No stadium paths are available to render")
    return teams


def unverified_gallery_message(metadata):
    """Return the warning banner required for non-verified snapshots."""
    if release_is_verified(metadata):
        return None
    data_version = str(metadata.get("data_version") or "unknown version")
    return (
        "UNVERIFIED OFFLINE REFERENCE — DO NOT USE FOR PARK ANALYSIS\n"
        f"Geometry release: {data_version}"
    )


def draw_stadium(ax, team, stadium_paths):
    """Draw a single stadium preview onto the provided axis."""
    path_data = stadium_paths.get(team)
    if not path_data:
        ax.axis("off")
        return

    path_x = []
    path_y = []

    segment_styles = {
        "foul_lines": 1.0,
        "home_plate": 0.8,
        "infield_inner": 0.8,
        "infield_outer": 0.9,
        "outfield_inner": 0.9,
        "outfield_outer": 1.0,
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

        sx = [point["x"] for point in points]
        sy = [point["y"] for point in points]
        path_x.extend(sx)
        path_y.extend(sy)
        ax.plot(sx, sy, color="black", linewidth=segment_styles[segment_name])

    outfield_outer = extract_outfield_wall_path(
        path_data.get("outfield_outer", []),
        path_data.get("foul_lines", []),
    )
    if len(outfield_outer) >= 2:
        fx = [point["x"] for point in outfield_outer]
        fy = [point["y"] for point in outfield_outer]
        ax.plot(fx, fy, color="#225b84", linewidth=2.2, solid_joinstyle="round", solid_capstyle="round")
    else:
        fx = []
        fy = []

    all_x = fx + path_x + [0]
    all_y = fy + path_y + [0]
    ax.set_xlim(min(all_x) - 20, max(all_x) + 20)
    ax.set_ylim(min(all_y) - 20, max(all_y) + 20)
    ax.set_aspect("equal")
    ax.axis("off")
    ax.set_title(team, fontsize=10, fontweight="bold", pad=4)


def render_gallery(stadium_paths, metadata, teams=None, cols=5):
    """Build a gallery figure and visibly mark every unverified snapshot."""
    teams = list(teams or select_gallery_teams(stadium_paths, metadata))
    cols = max(1, int(cols))
    rows = ceil(len(teams) / cols)

    fig, axes = plt.subplots(rows, cols, figsize=(cols * 3.3, rows * 3.0))
    axes = axes.flatten() if hasattr(axes, "flatten") else [axes]
    fig.patch.set_facecolor("white")

    warning = unverified_gallery_message(metadata)
    for ax, team in zip(axes, teams):
        draw_stadium(ax, team, stadium_paths)
        if warning:
            ax.text(
                0.5,
                0.5,
                "UNVERIFIED",
                transform=ax.transAxes,
                ha="center",
                va="center",
                rotation=28,
                fontsize=21,
                fontweight="bold",
                color="#9d1c1c",
                alpha=0.20,
                zorder=20,
            )

    for ax in axes[len(teams):]:
        ax.axis("off")

    if warning:
        fig.suptitle(
            warning,
            color="#8b0000",
            fontsize=13,
            fontweight="bold",
            y=0.995,
        )
        disabled_reason = str(
            metadata.get("analysis_disabled_reason") or
            "Release attestation is incomplete."
        ).strip()
        fig.text(
            0.5,
            0.005,
            disabled_reason,
            ha="center",
            va="bottom",
            fontsize=7.5,
            color="#8b0000",
            wrap=True,
        )
        fig.tight_layout(rect=(0.0, 0.04, 1.0, 0.94), pad=1.0)
    else:
        fig.tight_layout(pad=1.0)
    return fig


def main():
    parser = argparse.ArgumentParser(description="Render a gallery of all ballparks")
    parser.add_argument("--paths", default="data/stadium_paths.json", type=Path)
    parser.add_argument(
        "--metadata",
        required=True,
        type=Path,
        help="Schema-2 metadata that pins and classifies the path snapshot",
    )
    parser.add_argument("--output", default="tmp/stadium_gallery.png", type=Path)
    parser.add_argument("--cols", default=5, type=int)
    args = parser.parse_args()

    stadium_paths, metadata = load_gallery_inputs(
        args.paths,
        args.metadata,
    )
    teams = select_gallery_teams(stadium_paths, metadata)
    fig = render_gallery(stadium_paths, metadata, teams, args.cols)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(args.output, dpi=220, bbox_inches="tight", facecolor="white", edgecolor="none")
    plt.close(fig)
    warning = unverified_gallery_message(metadata)
    if warning:
        print(warning.replace("\n", " — "), file=sys.stderr)
    print(args.output)


if __name__ == "__main__":
    main()
