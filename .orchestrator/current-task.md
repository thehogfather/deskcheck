# Current Task

- **Feature ID**: feature-4
- **Title**: PII capture modes
- **Priority**: Next
- **Persona**: Bug Reporter
- **Branch**: feature/pii-capture-modes
- **Session**: orch-20260407-193920-41095
- **Started**: 2026-04-07

## Goal

Let users control how much form input data is recorded, based on sensitivity of the site being debugged.

## Description

Three input recording modes selectable at session start:
- **Full** (current behaviour — capture field values, passwords masked, values truncated to 200 chars)
- **Metadata** (capture that input occurred, field selector, value length, word count, character class breakdown like emoji/special chars — but never the actual value)
- **None** (skip input events entirely)

Mode is stored in session metadata and noted in the export.

## Definition of Done

- [ ] Mode selector appears in popup before session start (Full / Metadata / None)
- [ ] "Full" mode behaves identically to current implementation (passwords masked, values truncated to 200 chars)
- [ ] "Metadata" mode records: element selector, field type, value length, word count, whether value contains digits/emoji/special characters — but never the raw value
- [ ] "None" mode suppresses all input events from the timeline
- [ ] Selected mode is recorded in `session.json` metadata
- [ ] Default mode is "Full" (no behaviour change for existing users)
