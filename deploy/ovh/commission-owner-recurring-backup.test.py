import base64
from contextlib import redirect_stdout
import importlib.util
import io
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "backup_commission", Path(__file__).with_name("commission-owner-recurring-backup.py")
)
commissioning = importlib.util.module_from_spec(spec)
spec.loader.exec_module(commissioning)


def result(code=0, stdout=b""):
    return subprocess.CompletedProcess([], code, stdout=stdout)


class CommissionTest(unittest.TestCase):
    def setUp(self):
        root = self.enterContext(tempfile.TemporaryDirectory())
        self.root = Path(root).resolve()
        (self.root / "docker-compose.yml").touch()
        self.enterContext(patch.object(commissioning, "DEPLOY_ROOT", self.root))
        self.enterContext(patch.object(commissioning.os, "geteuid", return_value=0, create=True))
        self.output = self.enterContext(redirect_stdout(io.StringIO()))

    def test_install_starts_one_dump_and_leaves_timer_off(self):
        with (patch.object(commissioning, "validate_payload", return_value={}),
              patch.object(commissioning, "install_once") as install,
              patch.object(commissioning, "check_installed"),
              patch.object(commissioning, "assert_timer_off") as timer_off,
              patch.object(commissioning, "check_published") as fresh,
              patch.object(commissioning, "systemctl", side_effect=[result(3), result()]) as control):
            self.assertEqual(commissioning.commission("install", {}, str(self.root)), 0)
        install.assert_called_once_with({})
        self.assertEqual([call.args for call in control.call_args_list], [
            ("is-active", commissioning.SERVICE), ("start", commissioning.SERVICE)
        ])
        self.assertEqual([call.kwargs for call in timer_off.call_args_list], [{"installed": True}] * 2)
        self.assertGreater(fresh.call_args.kwargs["earliest"], 0)
        self.assertEqual(self.output.getvalue(), "backup_commissioned_timer_disabled\n")

    def test_enable_checks_freshness_then_enables_only_timer(self):
        with (patch.object(commissioning, "validate_payload", return_value={}),
              patch.object(commissioning, "check_installed"),
              patch.object(commissioning, "check_published"),
              patch.object(commissioning, "systemctl",
                           side_effect=[result(), result(stdout=b"enabled\n"), result(stdout=b"active\n")]) as control):
            self.assertEqual(commissioning.commission("enable", {}, str(self.root)), 0)
        self.assertEqual([call.args for call in control.call_args_list], [
            ("enable", "--now", commissioning.TIMER),
            ("is-enabled", commissioning.TIMER),
            ("is-active", commissioning.TIMER),
        ])
        self.assertEqual(self.output.getvalue(), "backup_timer_enabled_active\n")

    def test_failed_readiness_never_enables_timer(self):
        with (patch.object(commissioning, "validate_payload", return_value={}),
              patch.object(commissioning, "check_installed"),
              patch.object(commissioning, "check_published", side_effect=ValueError("secret fixture")),
              patch.object(commissioning, "systemctl") as control):
            self.assertEqual(commissioning.commission("enable", {}, str(self.root)), 1)
        control.assert_not_called()
        self.assertEqual(self.output.getvalue(), "backup_commissioning_failed=check_ready\n")

    def test_payload_rejects_unreviewed_entries(self):
        packed = {name: base64.b64encode(b"synthetic").decode() for name in commissioning.REVIEWED}
        self.assertEqual(commissioning.validate_payload("enable", packed),
                         {name: b"synthetic" for name in commissioning.REVIEWED})
        with self.assertRaises(ValueError):
            commissioning.validate_payload("enable", {**packed, "../extra": "YQ=="})


if __name__ == "__main__":
    unittest.main()
