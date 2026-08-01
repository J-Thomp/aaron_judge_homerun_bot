"""Offline contract tests for physics and current-venue resolution."""

from __future__ import annotations

import copy
import io
import hashlib
import importlib.util
import json
import math
import os
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch


PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "scripts"))

import hr_analysis  # noqa: E402
import render_stadium_gallery  # noqa: E402
from hr_analysis import (  # noqa: E402
    AnalysisValidationError,
    UnsupportedVenueError,
    analyze_all_parks,
    build_current_fences,
    build_error_result,
    compute_flight_time,
    load_json_object,
    load_cached_image,
    normalize_team_code,
    resolve_home_venue,
    validate_analysis_inputs,
    validate_ballpark_metadata,
    validate_fences_data,
    validate_geometry_file_hashes,
    would_it_dong,
)


FENCES_PATH = PROJECT_ROOT / "data" / "fences.json"
METADATA_PATH = PROJECT_ROOT / "data" / "ballpark_metadata.json"
RESULT_KEYS = {
    "success",
    "error",
    "analysis_status",
    "analysis_error",
    "analysis_warnings",
    "image_status",
    "image_error",
    "ballpark_data_version",
    "venue_id",
    "venue_name",
    "geometry_team",
    "spray_angle",
    "spray_direction",
    "total_dongs",
    "parks_evaluated",
    "parks_expected",
    "parks_cleared",
    "parks_not_cleared",
    "park_details",
    "image_path",
}


def make_synthetic_verified_fixture():
    """Return a complete verified schema-2 fixture with no production data."""
    venue_id = "9001"
    venue = {
        "team_code": "SYN",
        "geometry_team": "SYN",
        "venue_name": "Synthetic Test Park",
    }
    fences = {
        "SYN": {
            "stadium": "Synthetic Test Park",
            "fence_points": [
                {
                    "spray_angle": -30.0,
                    "d_wall": 330.0,
                    "fence_height": 8.0,
                    "x": -165.0,
                    "y": 285.8,
                },
                {
                    "spray_angle": 0.0,
                    "d_wall": 400.0,
                    "fence_height": 8.0,
                    "x": 0.0,
                    "y": 400.0,
                },
                {
                    "spray_angle": 30.0,
                    "d_wall": 330.0,
                    "fence_height": 8.0,
                    "x": 165.0,
                    "y": 285.8,
                },
            ],
        }
    }
    stadium_paths = {
        "SYN": {
            "foul_lines": [
                {"x": 0.0, "y": 0.0},
                {"x": -165.0, "y": 285.8},
                {"x": 0.0, "y": 0.0},
                {"x": 165.0, "y": 285.8},
            ],
            "outfield_outer": [
                {"x": -165.0, "y": 285.8},
                {"x": 0.0, "y": 400.0},
                {"x": 165.0, "y": 285.8},
            ],
        }
    }
    metadata = {
        "schema_version": 2,
        "data_version": "2099-01-01.synthetic-verified-v1",
        "venue_mapping_verified_at": "2099-01-01",
        "geometry_reviewed_at": "2099-01-01",
        "advanced_analysis_enabled": True,
        "analysis_disabled_reason": "",
        "analysis_release": {
            "status": "verified",
            "verification_schema_version": 1,
            "source_revisions_recorded": True,
            "calibration_complete": True,
            "calculation_rendering_walls_aligned": True,
            "verified_venue_ids": [venue_id],
        },
        "geometry_sources": ["synthetic test fixture"],
        "geometry_source_revision": "synthetic-fixture-revision-1",
        "geometry_source_provenance_note": (
            "Generated deterministic geometry used only by the offline test suite."
        ),
        "geometry_files_sha256": {
            "fences.json": "0" * 64,
            "stadium_paths.json": "0" * 64,
        },
        "expected_active_venues": 1,
        "team_aliases": {"ALT": "SYN"},
        "verified_venues": {venue_id: venue},
        "retained_venue_mappings": {venue_id: venue},
        "unsupported_venues": {},
        "excluded_geometry_teams": [],
    }
    return fences, stadium_paths, metadata


class GoldenPhysicsTests(unittest.TestCase):
    def test_contact_height_and_quadratic_discriminant_match_analytic_fixture(self):
        # This is an intentionally drag-free trajectory. The landing distance
        # makes horizontal acceleration exactly zero, so the expected values
        # follow directly from the two independent kinematic equations.
        gravity = -32.174
        launch_speed_mph = 100.0
        launch_angle_degrees = 30.0
        contact_height = 3.5
        velocity = launch_speed_mph * 5280.0 / 3600.0
        angle_radians = math.radians(launch_angle_degrees)
        horizontal_velocity = velocity * math.cos(angle_radians)
        vertical_velocity = velocity * math.sin(angle_radians)

        expected_flight_time = -(
            vertical_velocity
            + math.sqrt(
                vertical_velocity**2
                - 2.0 * gravity * contact_height
            )
        ) / gravity
        landing_distance = horizontal_velocity * expected_flight_time
        wall_distance = landing_distance / 2.0
        wall_time = wall_distance / horizontal_velocity
        expected_wall_height = (
            contact_height
            + vertical_velocity * wall_time
            + 0.5 * gravity * wall_time**2
        )

        self.assertAlmostEqual(expected_flight_time, 4.605784011150927)
        self.assertAlmostEqual(expected_wall_height, 87.064373537767)
        self.assertAlmostEqual(
            compute_flight_time(
                launch_speed_mph,
                launch_angle_degrees,
                contact_height,
            ),
            expected_flight_time,
        )

        clears, actual_wall_height, fence_height = would_it_dong(
            launch_speed_mph,
            launch_angle_degrees,
            landing_distance,
            contact_height,
            {
                "spray_angle": 0.0,
                "d_wall": wall_distance,
                "fence_height": 86.0,
            },
        )

        # The prior formula omitted contact_height and used the wrong sign in
        # the ground-impact discriminant, incorrectly classifying this as short.
        self.assertTrue(clears)
        self.assertEqual(actual_wall_height, round(expected_wall_height, 1))
        self.assertEqual(fence_height, 86.0)


class VenueMetadataTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fences = load_json_object(FENCES_PATH, "fence data")
        cls.metadata = load_json_object(METADATA_PATH, "ballpark metadata")
        (
            cls.synthetic_fences,
            cls.synthetic_paths,
            cls.synthetic_metadata,
        ) = make_synthetic_verified_fixture()

    def test_checked_in_metadata_quarantines_the_empty_fence_placeholder(self):
        self.assertEqual(self.fences, {})
        validate_ballpark_metadata(self.metadata, self.fences)

    def test_geometry_hashes_pin_the_exact_reviewed_snapshots(self):
        self.assertIn(
            "fence-profiles-removed",
            self.metadata["geometry_source_revision"],
        )
        self.assertTrue(self.metadata["geometry_source_provenance_note"])
        expected_hashes = self.metadata["geometry_files_sha256"]
        self.assertEqual(
            set(expected_hashes),
            {"fences.json", "stadium_paths.json"},
        )
        for file_name, expected_hash in expected_hashes.items():
            actual_hash = hashlib.sha256(
                (PROJECT_ROOT / "data" / file_name).read_bytes()
            ).hexdigest()
            self.assertEqual(actual_hash, expected_hash)

    def test_runtime_rejects_geometry_that_does_not_match_the_reviewed_hash(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            altered_fences = Path(temp_dir) / "fences.json"
            altered_fences.write_bytes(FENCES_PATH.read_bytes() + b"\n")

            with self.assertRaisesRegex(
                AnalysisValidationError,
                "does not match its reviewed SHA-256 snapshot",
            ):
                validate_geometry_file_hashes(
                    self.metadata,
                    {"fences.json": altered_fences},
                )

    def test_washington_alias_normalizes_without_enabling_retained_geometry(self):
        self.assertEqual(normalize_team_code("WAS", self.metadata), "WSH")
        with self.assertRaisesRegex(
            UnsupportedVenueError,
            "Advanced park projections are disabled",
        ):
            resolve_home_venue("WAS", "3309", self.metadata)

    def test_fully_synthetic_verified_fixture_resolves_without_production_data(self):
        validate_fences_data(self.synthetic_fences)
        validate_ballpark_metadata(
            self.synthetic_metadata,
            self.synthetic_fences,
        )
        resolved = resolve_home_venue(
            "ALT",
            "9001",
            self.synthetic_metadata,
        )
        self.assertEqual(
            resolved,
            {
                "venue_id": 9001,
                "venue_name": "Synthetic Test Park",
                "team_code": "SYN",
                "geometry_team": "SYN",
            },
        )

        current_fences = build_current_fences(
            self.synthetic_fences,
            self.synthetic_metadata,
        )
        self.assertEqual(set(current_fences), {"SYN"})
        self.assertEqual(current_fences["SYN"]["geometry_team"], "SYN")

    def test_disabled_production_metadata_cannot_build_a_comparison_set(self):
        with self.assertRaisesRegex(
            UnsupportedVenueError,
            "Advanced park projections are disabled",
        ):
            build_current_fences(self.fences, self.metadata)

    def test_one_bit_cannot_enable_retained_production_geometry(self):
        tampered_metadata = copy.deepcopy(self.metadata)
        tampered_metadata["advanced_analysis_enabled"] = True
        with self.assertRaisesRegex(
            AnalysisValidationError,
            "analysis_release status verified",
        ):
            validate_ballpark_metadata(tampered_metadata, self.fences)

    def test_unknown_synthetic_venue_fails_explicitly(self):
        with self.assertRaisesRegex(
            UnsupportedVenueError,
            "no verified local geometry",
        ):
            resolve_home_venue(
                "SYN",
                "999999",
                self.synthetic_metadata,
            )

    def test_production_park_analysis_is_explicitly_disabled(self):
        self.assertFalse(self.metadata["advanced_analysis_enabled"])
        reason = self.metadata["analysis_disabled_reason"]
        self.assertIn("no redistributable, calibrated fence profiles", reason)
        with self.assertRaisesRegex(
            UnsupportedVenueError,
            "Advanced park projections are disabled",
        ):
            resolve_home_venue("NYY", "3313", self.metadata)


class JsonContractTests(unittest.TestCase):
    def test_nonfinite_metric_is_rejected_before_analysis(self):
        with self.assertRaisesRegex(
            AnalysisValidationError,
            "launch_speed must be finite",
        ):
            validate_analysis_inputs(
                float("nan"),
                25.0,
                400.0,
                125.0,
                150.0,
                3.5,
            )

    def test_error_result_distinguishes_analysis_from_image_state(self):
        result = build_error_result(UnsupportedVenueError("unsupported park"))
        self.assertEqual(set(result), RESULT_KEYS)
        self.assertFalse(result["success"])
        self.assertEqual(result["analysis_status"], "error")
        self.assertEqual(result["analysis_error"], "unsupported park")
        self.assertEqual(result["image_status"], "not_attempted")
        self.assertIsNone(result["image_error"])
        self.assertIsNone(result["spray_angle"])
        self.assertIsNone(result["spray_direction"])
        self.assertEqual(result["parks_evaluated"], 0)

    def test_success_result_uses_fully_synthetic_verified_fixture(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            asset_cache_dir = Path(temp_dir) / "shared-assets"
            (
                synthetic_fences,
                synthetic_paths,
                synthetic_metadata,
            ) = make_synthetic_verified_fixture()
            fences_path = temp_path / "fences.json"
            paths_path = temp_path / "stadium_paths.json"
            metadata_path = temp_path / "metadata.json"
            fences_path.write_text(
                json.dumps(synthetic_fences, sort_keys=True),
                encoding="utf8",
            )
            paths_path.write_text(
                json.dumps(synthetic_paths, sort_keys=True),
                encoding="utf8",
            )
            synthetic_metadata["geometry_files_sha256"] = {
                "fences.json": hashlib.sha256(
                    fences_path.read_bytes()
                ).hexdigest(),
                "stadium_paths.json": hashlib.sha256(
                    paths_path.read_bytes()
                ).hexdigest(),
            }
            metadata_path.write_text(
                json.dumps(synthetic_metadata, sort_keys=True),
                encoding="utf8",
            )
            argv = [
                "hr_analysis.py",
                "--launch_speed",
                "101.2",
                "--launch_angle",
                "27.0",
                "--hit_distance",
                "410.0",
                "--hc_x",
                "125.0",
                "--hc_y",
                "150.0",
                "--plate_z",
                "3.5",
                "--home_team",
                "SYN",
                "--venue_id",
                "9001",
                "--player_name",
                "Fixture Player",
                "--output_image",
                str(Path(temp_dir) / "fixture.png"),
                "--asset_cache_dir",
                str(asset_cache_dir),
                "--fences_path",
                str(fences_path),
                "--stadium_paths",
                str(paths_path),
                "--ballpark_metadata",
                str(metadata_path),
            ]
            output = io.StringIO()
            with (
                patch.object(sys, "argv", argv),
                patch.object(hr_analysis, "generate_image") as generate_image,
                redirect_stdout(output),
            ):
                hr_analysis.main()

        result = json.loads(output.getvalue())
        self.assertEqual(
            generate_image.call_args.kwargs["asset_cache_dir"],
            str(asset_cache_dir),
        )
        self.assertEqual(set(result), RESULT_KEYS)
        self.assertTrue(result["success"])
        self.assertEqual(result["analysis_status"], "ok")
        self.assertEqual(result["image_status"], "ok")
        self.assertEqual(
            result["ballpark_data_version"],
            "2099-01-01.synthetic-verified-v1",
        )
        self.assertEqual(result["venue_id"], 9001)
        self.assertEqual(result["geometry_team"], "SYN")
        self.assertEqual(result["parks_evaluated"], 1)
        self.assertEqual(result["parks_expected"], 1)
        self.assertEqual(len(result["park_details"]), 1)
        self.assertTrue(
            all(
                isinstance(detail["forced_home_result"], bool)
                for detail in result["park_details"]
            )
        )
        self.assertEqual(result["analysis_warnings"], [])


class GalleryContractTests(unittest.TestCase):
    def test_disabled_gallery_is_visibly_watermarked(self):
        metadata = load_json_object(METADATA_PATH, "ballpark metadata")
        self.assertFalse(
            render_stadium_gallery.release_is_verified(metadata)
        )
        stadium_paths = {
            "SYN": {
                "foul_lines": [
                    {"x": 0.0, "y": 0.0},
                    {"x": -100.0, "y": 200.0},
                    {"x": 0.0, "y": 0.0},
                    {"x": 100.0, "y": 200.0},
                ],
                "outfield_outer": [
                    {"x": -100.0, "y": 200.0},
                    {"x": 0.0, "y": 250.0},
                    {"x": 100.0, "y": 200.0},
                ],
            }
        }

        figure = render_stadium_gallery.render_gallery(
            stadium_paths,
            metadata,
            ["SYN"],
            cols=1,
        )
        try:
            text = " ".join(
                item.get_text()
                for item in [
                    *figure.texts,
                    *(label for axis in figure.axes for label in axis.texts),
                ]
            )
            self.assertIn("UNVERIFIED", text)
            self.assertIn("OFFLINE REFERENCE", text)
        finally:
            render_stadium_gallery.plt.close(figure)

    def test_synthetic_attestation_is_recognized_as_verified(self):
        _, _, metadata = make_synthetic_verified_fixture()
        self.assertTrue(
            render_stadium_gallery.release_is_verified(metadata)
        )
        self.assertIsNone(
            render_stadium_gallery.unverified_gallery_message(metadata)
        )

    def test_gallery_rejects_paths_that_do_not_match_metadata_pin(self):
        metadata = load_json_object(METADATA_PATH, "ballpark metadata")
        with tempfile.TemporaryDirectory() as temp_dir:
            paths_path = Path(temp_dir) / "stadium_paths.json"
            metadata_path = Path(temp_dir) / "metadata.json"
            paths_path.write_text('{"SYN": {}}', encoding="utf8")
            metadata_path.write_text(json.dumps(metadata), encoding="utf8")

            with self.assertRaisesRegex(ValueError, "SHA-256"):
                render_stadium_gallery.load_gallery_inputs(
                    paths_path,
                    metadata_path,
                )


class ForcedResultTests(unittest.TestCase):
    def test_home_override_is_marked_when_model_does_not_clear_fence(self):
        fences = {
            "AWAY": {
                "stadium": "Away Park",
                "fence_points": [
                    {
                        "spray_angle": 0.0,
                        "d_wall": 500.0,
                        "fence_height": 100.0,
                    }
                ],
            },
            "HOME": {
                "stadium": "Home Park",
                "fence_points": [
                    {
                        "spray_angle": 0.0,
                        "d_wall": 500.0,
                        "fence_height": 100.0,
                    }
                ],
            },
        }

        cleared, not_cleared, details = analyze_all_parks(
            95.0,
            25.0,
            360.0,
            3.5,
            0.0,
            "HOME",
            fences,
        )
        details_by_team = {detail["team"]: detail for detail in details}

        self.assertIn("HOME", cleared)
        self.assertIn("AWAY", not_cleared)
        self.assertTrue(details_by_team["HOME"]["forced_home_result"])
        self.assertFalse(details_by_team["AWAY"]["forced_home_result"])


class _FakeImageResponse:
    def __init__(self, payload, headers):
        self.payload = payload
        self.headers = headers

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        return False

    def read(self, limit=-1):
        return self.payload if limit < 0 else self.payload[:limit]


class ImageCacheTests(unittest.TestCase):
    @staticmethod
    def make_png():
        payload = io.BytesIO()
        hr_analysis.Image.new(
            "RGBA",
            (1, 1),
            (12, 34, 56, 255),
        ).save(payload, format="PNG")
        return payload.getvalue()

    def test_valid_image_is_size_bounded_and_atomically_cached(self):
        payload = self.make_png()
        response = _FakeImageResponse(
            payload,
            {
                "Content-Type": "image/png",
                "Content-Length": str(len(payload)),
            },
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            with (
                patch.object(
                    hr_analysis.urllib.request,
                    "urlopen",
                    return_value=response,
                ) as urlopen,
                patch.object(
                    hr_analysis.os,
                    "replace",
                    wraps=hr_analysis.os.replace,
                ) as atomic_replace,
            ):
                image = load_cached_image(
                    "https://example.test/image.png",
                    temp_dir,
                    "fixture.png",
                )

            self.assertEqual(image.shape, (1, 1, 4))
            self.assertTrue((Path(temp_dir) / "fixture.png").is_file())
            self.assertEqual(list(Path(temp_dir).glob("*.tmp")), [])
            atomic_replace.assert_called_once()
            self.assertEqual(
                urlopen.call_args.kwargs["timeout"],
                hr_analysis.IMAGE_DOWNLOAD_TIMEOUT_SECONDS,
            )

    def test_non_image_content_type_is_not_cached(self):
        response = _FakeImageResponse(
            self.make_png(),
            {"Content-Type": "text/html"},
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            with patch.object(
                hr_analysis.urllib.request,
                "urlopen",
                return_value=response,
            ):
                image = load_cached_image(
                    "https://example.test/not-an-image",
                    temp_dir,
                    "fixture.png",
                )

            self.assertIsNone(image)
            self.assertEqual(list(Path(temp_dir).iterdir()), [])

    def test_stale_cached_image_is_revalidated(self):
        original_payload = self.make_png()
        replacement_buffer = io.BytesIO()
        hr_analysis.Image.new(
            "RGBA",
            (1, 1),
            (200, 100, 50, 255),
        ).save(replacement_buffer, format="PNG")
        replacement_payload = replacement_buffer.getvalue()
        response = _FakeImageResponse(
            replacement_payload,
            {
                "Content-Type": "image/png",
                "Content-Length": str(len(replacement_payload)),
            },
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            cache_path = Path(temp_dir) / "fixture.png"
            cache_path.write_bytes(original_payload)
            stale_time = (
                time.time()
                - hr_analysis.IMAGE_CACHE_MAX_AGE_SECONDS
                - 60
            )
            os.utime(cache_path, (stale_time, stale_time))
            with patch.object(
                hr_analysis.urllib.request,
                "urlopen",
                return_value=response,
            ) as urlopen:
                image = load_cached_image(
                    "https://example.test/image.png",
                    temp_dir,
                    "fixture.png",
                )

            urlopen.assert_called_once()
            self.assertEqual(tuple(image[0, 0]), (200, 100, 50, 255))

    def test_payload_larger_than_limit_is_not_cached(self):
        response = _FakeImageResponse(
            b"0123456789",
            {"Content-Type": "image/png"},
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            with (
                patch.object(
                    hr_analysis.urllib.request,
                    "urlopen",
                    return_value=response,
                ),
                patch.object(hr_analysis, "MAX_IMAGE_DOWNLOAD_BYTES", 8),
            ):
                image = load_cached_image(
                    "https://example.test/oversized.png",
                    temp_dir,
                    "fixture.png",
                )

            self.assertIsNone(image)
            self.assertEqual(list(Path(temp_dir).iterdir()), [])


@unittest.skipUnless(
    importlib.util.find_spec("matplotlib"),
    "Matplotlib is installed by the project environment and CI",
)
class RenderSmokeTests(unittest.TestCase):
    def test_offline_renderer_writes_a_readable_png(self):
        fences, stadium_paths, metadata = make_synthetic_verified_fixture()
        current_fences = build_current_fences(fences, metadata)

        with tempfile.TemporaryDirectory() as temp_dir:
            output_path = Path(temp_dir) / "render-smoke.png"
            with patch.object(
                hr_analysis,
                "load_cached_image",
                return_value=None,
            ):
                hr_analysis.generate_image(
                    current_fences,
                    "SYN",
                    0.0,
                    410.0,
                    125.0,
                    150.0,
                    "Fixture Player",
                    101.2,
                    27.0,
                    1,
                    1,
                    "Fixture Pitcher",
                    str(output_path),
                    stadium_paths=stadium_paths,
                    player_id="592450",
                    asset_cache_dir=str(Path(temp_dir) / "assets"),
                )

            self.assertGreater(output_path.stat().st_size, 0)
            with hr_analysis.Image.open(output_path) as rendered:
                self.assertEqual(rendered.format, "PNG")
                self.assertGreater(rendered.width, 0)
                self.assertGreater(rendered.height, 0)


if __name__ == "__main__":
    unittest.main()
