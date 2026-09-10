---
name: GitHub push quirks
description: Replit Git-pane behavior when a GitHub repository starts with a placeholder README.
---

The Replit Git pane can show a generic merge-conflict or push-rejected error even when the GitHub branch is only the initial placeholder README and the local branch already contains that commit. It can also auto-commit uploaded chat attachments.

**Why:** A push attempt became confusing because the UI's sync state did not match the actual remote ancestry, and an attached screenshot was added to the local history.

**How to apply:** Verify `github/main` ancestry before pulling or force-pushing; keep `attached_assets/` and generated caches ignored; prefer a clean local commit followed by Push, not Sync or Pull.