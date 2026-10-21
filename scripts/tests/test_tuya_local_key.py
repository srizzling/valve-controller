import importlib.util
import io
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

SPEC = importlib.util.spec_from_file_location("tlk", Path(__file__).resolve().parent.parent / "tuya-local-key.py")
tlk = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(tlk)

SECRET = "SUPERSECRETLOCALKEY123"
LAN = {"valveid": {"ip": "192.168.1.95", "version": "3.4"}, "plugid": {"ip": "192.168.1.112", "version": "3.5"}}


def dev(id, name, category, key="k"):
    return SimpleNamespace(id=id, name=name, category=category, local_key=key)


class FakeManager:
    def __init__(self, devices):
        self.device_map = {d.id: d for d in devices}
        self.unloaded = False

    def unload(self):
        self.unloaded = True


class Upsert(unittest.TestCase):
    def test_keeps_other_lines_and_replaces_or_appends(self):
        d = Path(tempfile.mkdtemp())
        env = d / ".env"
        env.write_text("# keep\nCLOUDFLARE_API_TOKEN=abc\nTF_VAR_tuya_local_key=old\n")
        tlk.upsert(env, "TF_VAR_tuya_local_key", "NEW", False)
        tlk.upsert(env, "TF_VAR_x", "1", False)
        self.assertEqual(env.read_text(), "# keep\nCLOUDFLARE_API_TOKEN=abc\nTF_VAR_tuya_local_key=NEW\nTF_VAR_x=1\n")
        tf = d / "t.tfvars"
        tf.write_text('docker_host = "ssh://a"\ntuya_device_id = ""\n# c\n')
        tlk.upsert(tf, "tuya_device_id", "bf60", True)
        tlk.upsert(tf, "tuya_ip", "1.2.3.4", True)
        self.assertIn('tuya_device_id = "bf60"', tf.read_text())
        self.assertIn('docker_host = "ssh://a"', tf.read_text())
        self.assertIn('tuya_ip', tf.read_text())


class ChooseValve(unittest.TestCase):
    def test_picks_by_category_or_by_id(self):
        devices = [dev("valveid", "Garden valve", "sfkzq"), dev("plugid", "Lamp", "cz")]
        self.assertEqual(tlk.choose_valve(devices, LAN, None)[0].id, "valveid")
        self.assertEqual(tlk.choose_valve(devices, LAN, "plugid")[0].id, "plugid")

    def test_refuses_ambiguous_missing_or_unseen(self):
        two = [dev("valveid", "A", "sfkzq"), dev("plugid", "B", "sfkzq")]
        self.assertIn("exactly one", tlk.choose_valve(two, LAN, None)[1])
        self.assertIn("exactly one", tlk.choose_valve([dev("plugid", "B", "cz")], LAN, None)[1])
        self.assertIn("not seen on the LAN", tlk.choose_valve([dev("ghost", "Valve", "sfkzq")], LAN, None)[1])


class Run(unittest.TestCase):
    def setUp(self):
        d = Path(tempfile.mkdtemp())
        self.env, self.tf = d / ".env", d / "homelab.tfvars"
        self.env.write_text("CLOUDFLARE_API_TOKEN=abc\nTUYA_USER_CODE=ABC123\n")
        self.tf.write_text('docker_host = "ssh://sriram@192.168.1.94"\ntuya_device_id = ""\ntuya_ip = ""\ntuya_version = "3.4"\n')
        # run() prints paths relative to the repo, so point ROOT at the temp dir
        self.patches = [mock.patch.object(tlk, n, v) for n, v in [("ENV", self.env), ("TFVARS", self.tf), ("ROOT", d)]]
        for p in self.patches:
            p.start()
        self.manager = FakeManager([dev("valveid", "Garden valve", "sfkzq", SECRET), dev("plugid", "Lamp", "cz", "other")])

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def go(self, **kw):
        args = SimpleNamespace(user_code=kw.get("user_code"), device=kw.get("device"), dry_run=kw.get("dry_run", False))
        out = io.StringIO()
        with redirect_stdout(out), mock.patch.object(tlk, "scan_lan", return_value=kw.get("lan", LAN)), mock.patch.object(tlk, "sign_in", return_value=kw.get("manager", self.manager)):
            code = tlk.run(args, say=lambda m: print(m))
        return code, out.getvalue()

    def test_saves_key_id_ip_version_keeps_the_rest_and_signs_out(self):
        code, out = self.go()
        self.assertEqual(code, 0)
        self.assertIn(f"TF_VAR_tuya_local_key={SECRET}", self.env.read_text())
        self.assertIn("CLOUDFLARE_API_TOKEN=abc", self.env.read_text())
        text = self.tf.read_text()
        for expected in ['tuya_device_id = "valveid"', 'tuya_ip', '192.168.1.95', 'tuya_version   = "3.4"', 'docker_host = "ssh://sriram@192.168.1.94"']:
            self.assertIn(expected, text)
        self.assertNotIn(SECRET, out)  # the key is never printed
        self.assertTrue(self.manager.unloaded)

    def test_dry_run_changes_nothing_but_still_signs_out(self):
        before = (self.env.read_text(), self.tf.read_text())
        code, out = self.go(dry_run=True)
        self.assertEqual(code, 0)
        self.assertEqual((self.env.read_text(), self.tf.read_text()), before)
        self.assertIn("dry run", out)
        self.assertTrue(self.manager.unloaded)

    def test_signs_out_even_when_no_valve_matches(self):
        m = FakeManager([dev("plugid", "Lamp", "cz")])
        code, out = self.go(manager=m)
        self.assertEqual(code, 1)
        self.assertTrue(m.unloaded)

    def test_needs_a_user_code(self):
        self.env.write_text("CLOUDFLARE_API_TOKEN=abc\n")
        code, out = self.go()
        self.assertEqual(code, 1)
        self.assertIn("TUYA_USER_CODE", out)

    def test_stops_when_nothing_is_on_the_lan_or_login_fails(self):
        self.assertEqual(self.go(lan={})[0], 1)
        self.assertEqual(self.go(manager=None)[0], 1)


if __name__ == "__main__":
    unittest.main()
