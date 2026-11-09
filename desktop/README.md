# Desktop shell

Phase 12.

Electron window hosting the web app, plus the Windows tray:

- service state and approval count
- open the app
- keep-awake while a turn is running or an approval is pending
- pause/resume
- autostart at login
- resume notification
- update integration in the installer phase

Electron is pinned to **40.10.2** until the 44.9.1 binary download issue is resolved. The tray in the retired prototype proved `Tray`, `powerMonitor`, `powerSaveBlocker`, and `setLoginItemSettings` work on this machine.

The daemon must run without the desktop shell.
