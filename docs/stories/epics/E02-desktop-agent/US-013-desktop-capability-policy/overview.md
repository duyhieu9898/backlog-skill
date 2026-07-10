# Overview

## Current Behavior

The agent can use files and allowlisted commands. It now has typed desktop
capability, app-registry, permission, confirmation, and trace contracts, but
the default adapter reports every desktop capability unavailable. No screen
capture or app launch can run yet.

## Target Behavior

The runtime discovers declared desktop capabilities, display metadata, and OS
permission state through one platform-neutral interface.

## Non-Goals

- No screenshot capture or app launch in this story.
- No raw shell capability for the model.
