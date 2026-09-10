import json
import unittest
from unittest.mock import patch

import server


class FakeProcess:
    def __init__(self):
        self.stdout = object()
        self.terminated = False
        self.killed = False
        self.waited = False

    def terminate(self):
        self.terminated = True

    def wait(self, timeout=None):
        self.waited = True
        return 0

    def kill(self):
        self.killed = True

    def poll(self):
        return None


class DisconnectingWriter:
    def __init__(self):
        self.writes = 0

    def write(self, _data):
        self.writes += 1
        if self.writes >= 2:
            raise BrokenPipeError("client disconnected")

    def flush(self):
        pass


class StreamTests(unittest.TestCase):
    @patch("server.select.select", return_value=([], [], []))
    @patch("server.subprocess.Popen")
    def test_idle_disconnect_reaps_journalctl(self, popen, _select):
        process = FakeProcess()
        popen.return_value = process

        handler = object.__new__(server.Handler)
        handler.send_response = lambda *_args, **_kwargs: None
        handler.send_header = lambda *_args, **_kwargs: None
        handler.end_headers = lambda: None
        handler.wfile = DisconnectingWriter()

        handler.stream_journal()

        self.assertTrue(process.terminated)
        self.assertTrue(process.waited)
        self.assertFalse(process.killed)
        self.assertEqual(handler.wfile.writes, 2)


class ParseTests(unittest.TestCase):
    def test_structured_wcgw_event_keeps_metadata_and_message(self):
        raw = {
            "MESSAGE": 'prefix WCGW_EVENT {"event":"log","message":"hello","thread_id":"abc"}',
            "__REALTIME_TIMESTAMP": "1000000",
        }

        entry = server.parse_journal_line(json.dumps(raw))

        self.assertIsNotNone(entry)
        self.assertEqual(entry["message"], "hello")
        self.assertEqual(entry["meta"]["thread_id"], "abc")
        self.assertEqual(entry["ts"], 1.0)


if __name__ == "__main__":
    unittest.main()
