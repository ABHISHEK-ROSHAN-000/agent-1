# Desktop shell

The desktop client is an Electron window and Windows tray that connects to the local Agent-1 daemon.

Planned responsibilities:

- service state and pending approval count
- open the app
- keep the system awake while a turn is running or an approval is pending
- pause and resume
- start at user sign-in
- resume notifications
- update integration

Electron is pinned to `40.10.2` until newer binary distribution is verified in this environment.

The daemon must continue to run without the desktop shell.
