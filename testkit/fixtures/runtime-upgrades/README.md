# Saved packages for runtime upgrades

These packages were collected with SDK 0.9.2 (runtime 0.7.0) and SDK 0.9.3 (runtime 0.7.1), before the executor upgrade. The 0.9.2 SDK came from its published release tarball; 0.9.3 came from its unchanged released source. Each fixture records its release and contains the returned package plus the uploaded file bytes, encoded as base64. Runtime fields and package digests were not edited.

The Method reads a supplied folder, appends a line to a test ledger, updates state, checks the saved line and count, and optionally pauses. The tests restore these exact packages with the current SDK. Keep the package bytes fixed; collect a new fixture with an actual older SDK when adding another supported version.
