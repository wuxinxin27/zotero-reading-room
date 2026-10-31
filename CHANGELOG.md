# Changelog

## 0.2.0 — Experimental release

- Add OpenAI-compatible, Anthropic Messages, Google Gemini, and native Ollama API settings.
- Discover models from the selected endpoint with debounce, cancellation, stale-result protection, search, manual entry, and clear unsupported/authentication/empty-list states.
- Separate remote model-discovery permission from remote paper-text analysis permission; clear stale lists, consent, and retained keys when changing provider or endpoint origin. Group-library remote analysis remains forbidden.
- Fix dialog close and backdrop paths so all close routes resolve cancellation and cancel discovery work; improve small-screen scrolling and accessible status/model controls.
- Preserve proxy prefixes that end in model-route names, reject credential echoes after nested JSON decoding, and use live select values in Zotero.
- Documentation updated for provider-specific endpoints and network/privacy boundaries. Synthetic tests and real Zotero loopback protocol integration are recorded separately; no real cloud provider or model has been validated.

## 0.1.0 — Initial experimental version

- Five manual reading states, local notes/checklist, bibliographic overview and library counts.
- Offline extractive candidates across six dimensions, contribution cues, source quotes and conservative page handling.
- Optional explicitly requested OpenAI-compatible model analysis with loopback default, remote HTTPS consent, bounded chunks and evidence checks.
- Local side-file persistence; explicit personal-library analysis notes and owned state-note snapshots with conflict protection; no group note writes.
- Explicit local JSON/Markdown export, deterministic standard-ZIP XPI build, SHA-256 checksums and synthetic automated tests.

Target: Zotero 10.0–10.*, initial live-test target 10.0.7. Automated checks do not establish live compatibility; see [test checklist](docs/TESTING.md). The manifest includes a GitHub Release update URL; upgrading from an earlier version still requires live verification. No OCR, visual figure interpretation, proof/code verification, automatic model startup or automatic cloud sync in this version.
