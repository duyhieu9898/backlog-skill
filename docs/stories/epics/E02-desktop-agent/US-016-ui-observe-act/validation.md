# Validation

## Test Plan

| Layer | Cases |
| --- | --- |
| Setup | Debian/Ubuntu installer installs `scrot`, `libgtk-3-bin`, `xdotool`, `wmctrl`, and `python3-pyatspi`; user service inherits the X11/user-bus environment. |
| Unit | Target ambiguity, stale snapshots, action schemas, stop conditions. |
| Integration | Fake desktop verifies observe-plan-act-observe sequence. |
| E2E | Harmless local app interaction after explicit confirmation. |
| Security | Cross-app targets, stale plans, and raw coordinates are refused. |

## Acceptance Evidence

TBD
