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
    @patch("server.subprocess.Popen", side_effect=OSError("journalctl missing"))
    def test_stream_spawn_failure_returns_service_unavailable(self, _popen):
        handler = object.__new__(server.Handler)
        errors = []
        handler.send_error = lambda status, message=None: errors.append((status, message))
        handler.send_response = lambda *_args, **_kwargs: None
        handler.send_header = lambda *_args, **_kwargs: None
        handler.end_headers = lambda: None

        handler.stream_journal()

        self.assertEqual(errors, [(503, "journalctl unavailable")])

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


class ServerTests(unittest.TestCase):
    @patch("server.subprocess.run", side_effect=server.subprocess.TimeoutExpired("journalctl", 5))
    def test_history_timeout_returns_empty_history(self, run):
        self.assertEqual(server.get_history(100), [])
        self.assertEqual(run.call_args.kwargs["timeout"], server.COMMAND_TIMEOUT_SECONDS)

    @patch("server.subprocess.run", side_effect=server.subprocess.TimeoutExpired("systemctl", 5))
    def test_status_timeout_returns_unknown(self, run):
        self.assertEqual(server.service_state(), "unknown")
        self.assertEqual(run.call_args.kwargs["timeout"], server.COMMAND_TIMEOUT_SECONDS)

    def test_request_threads_do_not_block_shutdown(self):
        with patch.object(server, "HOST", "127.0.0.1"), patch.object(server, "PORT", 0):
            httpd = server.create_server()
        try:
            self.assertTrue(httpd.daemon_threads)
        finally:
            httpd.server_close()


class ParseTests(unittest.TestCase):
    def test_non_object_json_is_ignored(self):
        self.assertIsNone(server.parse_journal_line("[]"))
        self.assertIsNone(server.parse_journal_line('"message"'))

    @patch("server.time.time", return_value=1234.5)
    def test_missing_or_nonpositive_timestamp_uses_current_time(self, _time):
        self.assertEqual(server.parse_journal_line('{"MESSAGE":"missing"}')["ts"], 1234.5)
        self.assertEqual(
            server.parse_journal_line('{"MESSAGE":"zero","__REALTIME_TIMESTAMP":"0"}')["ts"],
            1234.5,
        )

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
