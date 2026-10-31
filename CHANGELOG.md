# Changelog

## 0.1.0 — Initial experimental version

- Five manual reading states, local notes/checklist, bibliographic overview and library counts.
- Offline extractive candidates across six dimensions, contribution cues, source quotes and conservative page handling.
- Optional explicitly requested OpenAI-compatible model analysis with loopback default, remote HTTPS consent, bounded chunks and evidence checks.
- Local side-file persistence; explicit personal-library analysis notes and owned state-note snapshots with conflict protection; no group note writes.
- Explicit local JSON/Markdown export, deterministic standard-ZIP XPI build, SHA-256 checksums and synthetic automated tests.

Target: Zotero 10.0–10.*, initial live-test target 10.0.7. Automated checks do not establish live compatibility; see [test checklist](docs/TESTING.md). The manifest includes a GitHub Release update URL; upgrading from an earlier version still requires live verification. No OCR, visual figure interpretation, proof/code verification, automatic model startup or automatic cloud sync in this version.
