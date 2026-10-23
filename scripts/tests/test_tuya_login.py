import importlib.util
import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

SPEC = importlib.util.spec_from_file_location("tl", Path(__file__).resolve().parent.parent / "tuya-login.py")
tl = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(tl)

REFRESH = "SUPERSECRETREFRESHTOKEN"
INFO = {"terminal_id": "term1", "endpoint": "https://apigw.tuyaeu.com", "uid": "u1", "access_token": "ACCESSTOKEN", "refresh_token": REFRESH, "expire_time": 7200, "t": 1700000000000}


def fn(type, values="{}"):
    return SimpleNamespace(type=type, values=values)


def valve(**kw):
    base = dict(id="valveid", name="Valve Controller", category="sfkzq", online=True, status={"switch_1": False, "battery_percentage": 80},
                function={"switch_1": fn("Boolean"), "countdown_1": fn("Integer", '{"max":86400}')})
    base.update(kw)
    return SimpleNamespace(**base)


class Helpers(unittest.TestCase):
    def test_upsert_keeps_other_lines(self):
        d = Path(tempfile.mkdtemp())
        env = d / ".env"
        env.write_text("# keep\nCLOUDFLARE_API_TOKEN=abc\nTF_VAR_tuya_session=old\n")
        tl.upsert(env, "TF_VAR_tuya_session", "NEW", False)
        self.assertEqual(env.read_text(), "# keep\nCLOUDFLARE_API_TOKEN=abc\nTF_VAR_tuya_session=NEW\n")
        tf = d / "t.tfvars"
        tf.write_text('zone_name = "x"\ntuya_device_id = ""\n# c\n')
        tl.upsert(tf, "tuya_device_id", "bf4b", True)
        tl.upsert(tf, "tuya_switch_code", "switch_1", True)
        self.assertIn('tuya_device_id = "bf4b"', tf.read_text())
        self.assertIn('zone_name = "x"', tf.read_text())
        self.assertIn('tuya_switch_code', tf.read_text())

    def test_seed_json_has_what_the_worker_reads(self):
        seed = json.loads(tl.seed_json(INFO, "UC1"))
        self.assertEqual(seed["client_id"], tl.CLIENT_ID)
        self.assertEqual(seed["user_code"], "UC1")
        for k in ("terminal_id", "endpoint", "uid", "access_token", "refresh_token", "expire_time", "t"):
            self.assertEqual(seed[k], INFO[k])
        with self.assertRaises(ValueError):
            tl.seed_json({**INFO, "refresh_token": ""}, "UC1")

    def test_pick_valve(self):
        other = valve(id="plug", name="Lamp", category="cz")
        self.assertEqual(tl.pick_valve([valve(), other], None)[0].id, "valveid")
        self.assertEqual(tl.pick_valve([valve(), other], "plug")[0].id, "plug")
        self.assertIn("exactly one", tl.pick_valve([valve(), valve(id="b")], None)[1])
        self.assertIn("exactly one", tl.pick_valve([other], None)[1])

    def test_data_point_codes(self):
        self.assertEqual(tl.data_point_codes(valve()), ("switch_1", "countdown_1"))
        self.assertEqual(tl.data_point_codes(valve(function={"switch": fn("Boolean")})), ("switch", ""))
        self.assertEqual(tl.data_point_codes(valve(function={"countdown_1": fn("Integer")})), ("", "countdown_1"))
        self.assertEqual(tl.data_point_codes(valve(function={})), ("", ""))


class Run(unittest.TestCase):
    def setUp(self):
        d = Path(tempfile.mkdtemp())
        self.env, self.tf = d / ".env", d / "terraform.tfvars"
        self.env.write_text("CLOUDFLARE_API_TOKEN=abc\nTUYA_USER_CODE=UC1\n")
        self.tf.write_text('zone_name = "venkatesh.cloud"\n')
        self.patches = [mock.patch.object(tl, n, v) for n, v in [("ENV", self.env), ("TFVARS", self.tf), ("ROOT", d)]]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def go(self, devices=None, signed_in=True, **kw):
        manager = SimpleNamespace(device_map={d.id: d for d in (devices if devices is not None else [valve(), valve(id="plug", name="Lamp", category="cz")])})
        args = SimpleNamespace(user_code=kw.get("user_code"), device=kw.get("device"), dry_run=kw.get("dry_run", False))
        out = io.StringIO()
        with redirect_stdout(out), mock.patch.object(tl, "sign_in", return_value=(manager, INFO) if signed_in else (None, None)):
            code = tl.run(args, say=lambda m: print(m))
        return code, out.getvalue()

    def test_saves_session_and_codes_and_never_prints_the_tokens(self):
        code, out = self.go()
        self.assertEqual(code, 0)
        session = json.loads(self.env.read_text().split("TF_VAR_tuya_session=")[1].splitlines()[0])
        self.assertEqual(session["refresh_token"], REFRESH)
        self.assertIn("CLOUDFLARE_API_TOKEN=abc", self.env.read_text())
        text = self.tf.read_text()
        for expected in ['tuya_user_code', 'tuya_device_id', 'valveid', 'tuya_switch_code', 'switch_1', 'tuya_countdown_code', 'countdown_1', 'zone_name = "venkatesh.cloud"']:
            self.assertIn(expected, text)
        self.assertNotIn(REFRESH, out)
        self.assertNotIn("ACCESSTOKEN", out)
        self.assertIn("battery_percentage=80", out)  # the valve's own state is shown

    def test_dry_run_saves_nothing(self):
        before = (self.env.read_text(), self.tf.read_text())
        code, out = self.go(dry_run=True)
        self.assertEqual(code, 0)
        self.assertEqual((self.env.read_text(), self.tf.read_text()), before)
        self.assertIn("dry run", out)

    def test_valve_without_a_countdown_is_saved_with_an_empty_code(self):
        code, out = self.go(devices=[valve(function={"switch_1": fn("Boolean")})])
        self.assertEqual(code, 0)
        self.assertIn("none (no valve-side failsafe)", out)
        self.assertIn('tuya_countdown_code = ""', self.tf.read_text())

    def test_refuses_to_save_without_an_on_off_command(self):
        before = self.env.read_text()
        code, out = self.go(devices=[valve(function={})])
        self.assertEqual(code, 1)
        self.assertEqual(self.env.read_text(), before)

    def test_failure_paths(self):
        self.assertEqual(self.go(signed_in=False)[0], 1)
        self.assertEqual(self.go(devices=[valve(category="cz")])[0], 1)
        self.env.write_text("CLOUDFLARE_API_TOKEN=abc\n")
        code, out = self.go()
        self.assertEqual(code, 1)
        self.assertIn("TUYA_USER_CODE", out)


if __name__ == "__main__":
    unittest.main()
