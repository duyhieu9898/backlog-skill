# 0016 Linux X11 Desktop Adapter Prerequisites

Date: 2026-07-13

## Status

Accepted

## Context

The OpenClaw-inspired computer-control contract needs more than screenshot and
desktop-entry launch support. The Linux/X11 adapter must discover windows,
resolve accessibility targets, focus a reviewed window, and perform bounded
input without a raw shell tool exposed to the model.

The current host has X11, `scrot`, `gtk-launch`, and an AT-SPI bus, but lacked
the local client dependencies needed to implement or verify those operations.

## Decision

On Debian/Ubuntu Linux, `agent/scripts/my-agent install` installs the X11
desktop adapter prerequisites: `scrot`, `libgtk-3-bin`, `xdotool`, `wmctrl`,
and `python3-pyatspi`. The same operation is available explicitly as
`my-agent desktop-deps`.

The installer imports the active X11 and user-bus environment into the systemd
user manager before installing the service. The runtime continues to advertise
desktop capabilities as unavailable when it is not in an X11 session or the
required dependencies are absent.

## Alternatives Considered

1. Require each operator to install packages manually. Rejected because a
   fresh machine would otherwise silently lack the adapter prerequisites.
2. Expose arbitrary shell commands for window and input control. Rejected by
   the desktop capability boundary.
3. Support every Linux package manager immediately. Deferred: Debian/Ubuntu is
   the verified current host; unsupported package managers fail explicitly.

## Consequences

Positive:

- A fresh Debian/Ubuntu setup installs the same prerequisites as the current
  operator machine.
- The future platform adapter can use typed capabilities rather than adding
  arbitrary command allowlist entries.

Tradeoffs:

- First installation requires local administrator authorization through
  `sudo`.
- The desktop automation path remains Linux/X11-specific until another adapter
  is added.

## Follow-Up

- Install and verify the prerequisites on the current host.
- Implement the OpenClaw-pattern UI snapshot, target binding, and bounded
  input adapter under US-016.
