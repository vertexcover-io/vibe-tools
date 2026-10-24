# Phase 2: Google Open and Manual Sync

> **Status:** complete

## Overview

Connect the core to OAuth and Drive APIs, open the web editor, and explicitly export remote
changes with conflict checks and atomic replacement.

## Implementation

**Files:**
- Modify: `open-in-google-workspace/open-in-google-workspace.py`
- Modify: `open-in-google-workspace/test_open_in_google_workspace.py`

**What to test:**
- Existing mappings open without importing.
- Initial import records a mapping.
- Local modifications block sync before an export or write.
- Export is atomically written and updates the baseline.

## Done When

- [ ] Tests pass using injected Drive/browser adapters.
- [ ] The CLI exposes `open`, `sync`, and `status`.
