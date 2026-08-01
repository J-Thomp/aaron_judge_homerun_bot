#!/usr/bin/env python3
"""Convert reviewed, licensed stadium-path and fence-profile CSV inputs."""

import argparse
import csv
import json
import math
from collections import defaultdict
from pathlib import Path


SCALE = 2.495671
MAX_DISTANCE_FIELD_DELTA_FEET = 1.0
MAX_SPRAY_ANGLE_FIELD_DELTA_DEGREES = 0.5
TEAM_NAME_OVERRIDES = {
    "guardians": "CLE",
}


def finite_float(value, label):
    """Parse a required finite numeric source value."""
    parsed = float(value)
    if not math.isfinite(parsed):
        raise ValueError(f"{label} must be finite")
    return parsed


def transform_geom_coords(x_value, y_value):
    """Apply the GeomMLBStadiums MLBAM coordinate transform."""
    x_numeric = finite_float(x_value, "geometry x")
    y_numeric = finite_float(y_value, "geometry y")
    return {
        "x": round(SCALE * (x_numeric - 125.0), 4),
        "y": round(SCALE * (199.0 - y_numeric), 4),
    }


def load_team_slug_to_abbr(fences_csv_path):
    """Build a mapping from source team slug to team abbreviation."""
    team_slug_to_abbr = {}
    with fences_csv_path.open(newline="", encoding="utf-8") as csv_file:
        reader = csv.DictReader(csv_file)
        for row in reader:
            team_slug_to_abbr.setdefault(row["team"], row["team_abbr"])
    team_slug_to_abbr.update(TEAM_NAME_OVERRIDES)
    return team_slug_to_abbr


def build_stadium_paths_json(geom_csv_path, fences_csv_path):
    """Convert GeomMLBStadiums path CSV into the JSON shape used by the bot."""
    team_slug_to_abbr = load_team_slug_to_abbr(fences_csv_path)
    stadium_paths = defaultdict(lambda: defaultdict(list))

    with geom_csv_path.open(newline="", encoding="utf-8") as csv_file:
        reader = csv.DictReader(csv_file)
        for row in reader:
            team_slug = row["team"]
            team_key = "generic" if team_slug == "generic" else team_slug_to_abbr[team_slug]
            stadium_paths[team_key][row["segment"]].append(
                transform_geom_coords(row["x"], row["y"])
            )

    return {
        team_key: dict(segments)
        for team_key, segments in sorted(stadium_paths.items())
    }


def build_fences_json(fences_csv_path):
    """Convert a reviewed fence-profile CSV into the bot's JSON shape."""
    fences = defaultdict(lambda: {"stadium": "", "fence_points": []})

    with fences_csv_path.open(newline="", encoding="utf-8") as csv_file:
        reader = csv.DictReader(csv_file)
        for row in reader:
            team_key = row["team_abbr"]
            x_value = finite_float(row["x"], f"{team_key} x")
            y_value = finite_float(row["y"], f"{team_key} y")
            source_distance = finite_float(
                row["d_wall"],
                f"{team_key} d_wall",
            )
            source_spray_angle = finite_float(
                row["spray_angle_stadia"],
                f"{team_key} spray_angle_stadia",
            )
            fence_height = finite_float(
                row["fence_height"],
                f"{team_key} fence_height",
            )
            derived_distance = math.hypot(x_value, y_value)
            derived_spray_angle = math.degrees(
                math.atan2(x_value, y_value)
            ) * 0.75
            if abs(source_distance - derived_distance) > MAX_DISTANCE_FIELD_DELTA_FEET:
                raise ValueError(
                    f"{team_key} fence row has d_wall inconsistent with x/y"
                )
            if (
                abs(source_spray_angle - derived_spray_angle)
                > MAX_SPRAY_ANGLE_FIELD_DELTA_DEGREES
            ):
                raise ValueError(
                    f"{team_key} fence row has spray_angle_stadia inconsistent with x/y"
                )
            fences[team_key]["stadium"] = row["stadium"]
            fences[team_key]["fence_points"].append(
                {
                    "spray_angle": round(derived_spray_angle, 4),
                    "d_wall": round(derived_distance, 4),
                    "fence_height": round(fence_height, 4),
                    "x": round(x_value, 4),
                    "y": round(y_value, 4),
                }
            )

    for team_data in fences.values():
        team_data["fence_points"].sort(key=lambda point: point["spray_angle"])
        for previous, current in zip(
            team_data["fence_points"],
            team_data["fence_points"][1:],
        ):
            if (
                abs(previous["spray_angle"] - current["spray_angle"]) < 0.0001
                and abs(previous["d_wall"] - current["d_wall"]) > 1.0
            ):
                raise ValueError(
                    f"{team_data['stadium']} contains ambiguous duplicate fence rays"
                )

    return dict(sorted(fences.items()))


def write_json(output_path, payload):
    """Write a JSON file with stable formatting."""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(payload, indent=2, allow_nan=False) + "\n",
        encoding="utf-8",
    )


def main():
    parser = argparse.ArgumentParser(description="Refresh ballpark data files")
    parser.add_argument("--geom_csv", required=True, type=Path)
    parser.add_argument("--fences_csv", required=True, type=Path)
    parser.add_argument("--out_paths_json", required=True, type=Path)
    parser.add_argument("--out_fences_json", required=True, type=Path)
    args = parser.parse_args()

    stadium_paths = build_stadium_paths_json(args.geom_csv, args.fences_csv)
    fences = build_fences_json(args.fences_csv)

    write_json(args.out_paths_json, stadium_paths)
    write_json(args.out_fences_json, fences)

    print(
        json.dumps(
            {
                "stadium_paths_teams": len(stadium_paths),
                "fence_teams": len(fences),
                "sample_stadium": stadium_paths.get("BAL", {}).keys(),
                "sample_fence_points": len(fences.get("BAL", {}).get("fence_points", [])),
            },
            default=list,
        )
    )


if __name__ == "__main__":
    main()
