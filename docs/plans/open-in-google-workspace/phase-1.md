# Phase 1: Mapping and Safety Core

> **Status:** complete

## Overview

Create the typed data model, supported-format registry, local hash and SQLite mapping
repository, along with pure sync-decision logic.

## Implementation

**Files:**
- Create: `open-in-google-workspace/open-in-google-workspace.py`
- Create: `open-in-google-workspace/test_open_in_google_workspace.py`

**What to test:**
- Format selection maps CSV/XLSX/DOCX/PPTX to correct Workspace and export types.
- A mapping round-trips through SQLite.
- Sync decisions distinguish unchanged, remote-changed, local-changed, and conflicting states.

**Commit:** `add open-in-google-workspace: open local office files in Google Workspace`

## Done When

- [ ] Tests for the pure core pass.
- [ ] State has no network or browser dependency.
