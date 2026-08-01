"""Deterministic checks for the offline ballpark-data converter."""

from __future__ import annotations

import csv
import json
import math
import sys
import tempfile
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "scripts"))

from refresh_ballpark_data import (  # noqa: E402
    build_fences_json,
    build_stadium_paths_json,
    transform_geom_coords,
    write_json,
)


class BallparkConverterTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.root = Path(self.temporary_directory.name)

    @staticmethod
    def write_csv(path, fieldnames, rows):
        with path.open("w", newline="", encoding="utf-8") as csv_file:
            writer = csv.DictWriter(csv_file, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(rows)

    def test_coordinate_transform_maps_home_plate_origin(self):
        self.assertEqual(transform_geom_coords(125, 199), {"x": 0.0, "y": 0.0})

    def test_converter_builds_stable_team_and_fence_shapes(self):
        fences_path = self.root / "fences.csv"
        geometry_path = self.root / "geometry.csv"
        self.write_csv(
            fences_path,
            [
                "team",
                "team_abbr",
                "stadium",
                "spray_angle_stadia",
                "d_wall",
                "fence_height",
                "x",
                "y",
            ],
            [
                {
                    "team": "alpha",
                    "team_abbr": "AAA",
                    "stadium": "Alpha Park",
                    "spray_angle_stadia": "7.4",
                    "d_wall": "350",
                    "fence_height": "8",
                    "x": "60",
                    "y": "345",
                },
                {
                    "team": "alpha",
                    "team_abbr": "AAA",
                    "stadium": "Alpha Park",
                    "spray_angle_stadia": "-7.0",
                    "d_wall": "340",
                    "fence_height": "9",
                    "x": "-55",
                    "y": "335",
                },
            ],
        )
        self.write_csv(
            geometry_path,
            ["team", "segment", "x", "y"],
            [
                {"team": "alpha", "segment": "foul_lines", "x": "125", "y": "199"},
                {"team": "alpha", "segment": "foul_lines", "x": "130", "y": "190"},
                {"team": "generic", "segment": "home_plate", "x": "125", "y": "199"},
            ],
        )

        fences = build_fences_json(fences_path)
        paths = build_stadium_paths_json(geometry_path, fences_path)

        self.assertEqual(list(fences), ["AAA"])
        self.assertEqual(
            [point["spray_angle"] for point in fences["AAA"]["fence_points"]],
            sorted([
                round(math.degrees(math.atan2(-55, 335)) * 0.75, 4),
                round(math.degrees(math.atan2(60, 345)) * 0.75, 4),
            ]),
        )
        self.assertIn("AAA", paths)
        self.assertIn("generic", paths)
        self.assertEqual(paths["AAA"]["foul_lines"][0], {"x": 0.0, "y": 0.0})

    def test_converter_rejects_redundant_geometry_fields_that_disagree(self):
        fences_path = self.root / "bad-fences.csv"
        self.write_csv(
            fences_path,
            [
                "team",
                "team_abbr",
                "stadium",
                "spray_angle_stadia",
                "d_wall",
                "fence_height",
                "x",
                "y",
            ],
            [{
                "team": "alpha",
                "team_abbr": "AAA",
                "stadium": "Alpha Park",
                "spray_angle_stadia": "25",
                "d_wall": "350",
                "fence_height": "8",
                "x": "0",
                "y": "350",
            }],
        )

        with self.assertRaisesRegex(
            ValueError,
            "spray_angle_stadia inconsistent",
        ):
            build_fences_json(fences_path)

    def test_write_json_creates_parent_and_trailing_newline(self):
        output_path = self.root / "nested" / "payload.json"
        write_json(output_path, {"value": 1})

        text = output_path.read_text(encoding="utf-8")
        self.assertTrue(text.endswith("\n"))
        self.assertEqual(json.loads(text), {"value": 1})

    def test_converter_and_writer_reject_nonfinite_numbers(self):
        with self.assertRaisesRegex(ValueError, "geometry x must be finite"):
            transform_geom_coords("NaN", "199")

        with self.assertRaises(ValueError):
            write_json(
                self.root / "nonfinite.json",
                {"value": float("inf")},
            )


if __name__ == "__main__":
    unittest.main()
