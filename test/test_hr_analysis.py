"""Deterministic unit checks for the pure HR-analysis calculations."""

from __future__ import annotations

import math
import sys
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "scripts"))

from hr_analysis import (  # noqa: E402
    analyze_all_parks,
    compute_landing_xy,
    compute_spray_angle,
    find_nearest_fence_point,
    spray_direction,
    would_it_dong,
)


class CoordinateTests(unittest.TestCase):
    def test_center_field_coordinates_have_zero_spray(self):
        self.assertEqual(compute_spray_angle(125.0, 150.0), 0.0)

    def test_spray_angle_handles_the_home_plate_axis_without_division(self):
        self.assertEqual(compute_spray_angle(126.0, 199.0), 67.5)
        self.assertEqual(compute_spray_angle(124.0, 199.0), -67.5)

    def test_center_field_landing_uses_requested_distance(self):
        x_value, y_value = compute_landing_xy(125.0, 150.0, 425.0)
        self.assertAlmostEqual(x_value, 0.0)
        self.assertAlmostEqual(y_value, 425.0)

    def test_direction_thresholds_are_stable(self):
        self.assertEqual(spray_direction(-16), "Left Field")
        self.assertEqual(spray_direction(-10), "Left-Center")
        self.assertEqual(spray_direction(0), "Center Field")
        self.assertEqual(spray_direction(10), "Right-Center")
        self.assertEqual(spray_direction(16), "Right Field")


class PhysicsTests(unittest.TestCase):
    def test_nearest_fence_point_uses_smallest_angle_delta(self):
        points = [
            {"spray_angle": -15.0, "d_wall": 330.0, "fence_height": 8.0},
            {"spray_angle": 0.0, "d_wall": 400.0, "fence_height": 8.0},
            {"spray_angle": 15.0, "d_wall": 330.0, "fence_height": 8.0},
        ]
        self.assertIs(find_nearest_fence_point(2.0, points), points[1])

    def test_home_park_force_flag_guarantees_a_home_run(self):
        fence = {"spray_angle": 0.0, "d_wall": 500.0, "fence_height": 100.0}
        clears, height_at_wall, fence_height = would_it_dong(
            95.0,
            25.0,
            360.0,
            3.5,
            fence,
            force_dong=True,
        )

        self.assertTrue(clears)
        self.assertTrue(math.isfinite(height_at_wall))
        self.assertEqual(fence_height, 100.0)

    def test_all_park_analysis_returns_one_detail_per_profile(self):
        fences = {
            "AAA": {
                "stadium": "Alpha Park",
                "fence_points": [
                    {"spray_angle": 0.0, "d_wall": 350.0, "fence_height": 8.0}
                ],
            },
            "BBB": {
                "stadium": "Beta Park",
                "fence_points": [
                    {"spray_angle": 0.0, "d_wall": 410.0, "fence_height": 12.0}
                ],
            },
        }

        cleared, not_cleared, details = analyze_all_parks(
            105.0,
            28.0,
            400.0,
            3.5,
            0.0,
            "AAA",
            fences,
        )

        self.assertEqual(len(details), 2)
        self.assertEqual(set(cleared) | set(not_cleared), {"AAA", "BBB"})
        self.assertIn("AAA", cleared)


if __name__ == "__main__":
    unittest.main()
