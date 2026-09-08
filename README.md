# wcgw-live

A small local web viewer for live `wcgw` activity. It reads a user-level systemd journal, exposes recent entries over HTTP, and streams new entries to a lightweight browser UI with Server-Sent Events.

## Features

- Live journald stream over Server-Sent Events
- Recent activity history
- Shell, file, and tool filters
- Search across commands, paths, and output
- Pause/resume and compact views
- No external Python dependencies

## Requirements

- Linux with systemd/journald
- Python 3.10+
- A user service whose journal contains wcgw activity

## Run

```sh
WCGW_LIVE_UNIT=wcgw.service python3 server.py
```

Then open `http://127.0.0.1:18117`.

Configuration is available through environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `WCGW_LIVE_HOST` | `127.0.0.1` | HTTP bind address |
| `WCGW_LIVE_PORT` | `18117` | HTTP port |
| `WCGW_LIVE_UNIT` | `wcgw.service` | user-level systemd unit to read |

## Security

`wcgw-live` displays journal contents verbatim. Tool output, commands, paths, and other log entries may contain credentials, personal information, or other sensitive data.

For that reason, the server binds to `127.0.0.1` by default. Do not expose it to an untrusted network without an authenticated reverse proxy and an explicit review of the journal data being shown.

The repository contains no credentials or machine-specific configuration. Put local settings in environment variables rather than committing them.

## License

MIT
