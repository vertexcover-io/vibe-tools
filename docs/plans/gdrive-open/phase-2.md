# Phase 2: Google Open and Manual Sync

> **Status:** complete

## Overview

Connect the core to OAuth and Drive APIs, open the web editor, and explicitly export remote
changes with conflict checks and atomic replacement.

## Implementation

**Files:**
- Modify: `gdrive-open/gdrive-open.py`
- Modify: `gdrive-open/test_gdrive_open.py`

**What to test:**
- Existing mappings open without importing.
- Initial import records a mapping.
- Local modifications block sync before an export or write.
- Export is atomically written and updates the baseline.

## Done When

- [ ] Tests pass using injected Drive/browser adapters.
- [ ] The CLI exposes `open`, `sync`, and `status`.
