# Bundled binaries

Termates ships with platform-specific copies of `abduco`, a tiny (~30 KB) C
program that keeps PTY processes alive across server restarts. Abduco replaces
the tmux-based persistence we used to ship — tmux's aggressive redraw
coalescing was the source of the rendering glitches we hit with multiple
simultaneous streaming TUIs (Claude Code, Codex, etc).

electron-builder copies this directory into the packaged app under
`process.resourcesPath/binaries/`. At runtime `persistence-backend.js`
probes for `abduco-<process.platform>-<process.arch>` and falls back to
`$PATH` → tmux → no-persistence if nothing is found.

## Filenames

| File                       | Target                 |
|----------------------------|------------------------|
| `abduco-darwin-arm64`      | Apple Silicon macOS    |
| `abduco-darwin-x64`        | Intel macOS            |
| `abduco-linux-x64`         | x86_64 Linux           |
| `abduco-linux-arm64`       | ARM64 Linux            |

## Rebuilding

```sh
./scripts/build-abduco.sh
```

Runs on the host you invoke it from — produces the binary for *that* platform
and arch. For a multi-arch release build, run the script on each target
(or on a CI matrix).

## Upstream

- Project: <https://github.com/martanne/abduco>
- Tarball: <https://www.brain-dump.org/projects/abduco/>
- License: ISC (permissive — redistribution is fine)
