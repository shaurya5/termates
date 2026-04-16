# Changelog

## v2.0.0

- Switched Termates to an Electron-first desktop app; standalone server launch scripts were removed.
- Updated `termates start` to launch the desktop app instead of the local Node server directly.
- Added linked-terminal messaging in the UI and CLI with persisted message history.
- Fixed server startup, workspace restore/layout persistence, link persistence, tmux reattach behavior, and SSH parsing issues.
- Expanded unit and integration coverage for the restored behavior and new messaging workflows.
