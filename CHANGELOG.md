# Changelog

## Unreleased — reading workspace

- Replace extractive prereading with AI-only analysis. Model output now includes a natural overview, reading guide, verified six-dimension evidence and figure/table text references; legacy extractive results remain only as archived records that prompt for replacement.
- Add a searchable cross-library paper catalog with library selection, all/focused filters, paging, focused-paper chips and a collapsible navigation pane. Focus state uses library ID plus item key and remains local.
- Add side-by-side embedded source and AI reading, with a keyboard-adjustable splitter and a stacked layout for narrow windows. Evidence buttons jump to physical PDF pages and attempt text highlighting; missing page numbers are never guessed.
- Add lazy, serialized previews of “the source page containing the figure or table” from Zotero's local PDF.js document. Previews cache at most eight pages and are not presented as cropped or visually interpreted figures.
- Move AI configuration into an independent settings view. Saved analysis is reused without configuration, credentials, PDF extraction or HTTP; only explicit reanalysis sets `force: true`.
- Persist non-secret model configuration in the sidecar, and API keys only after explicit opt-in through Zotero `OSKeyStore` encryption plus `Services.logins`. Remote permissions are bound to both current origin and provider, and model/paper text is never sent by startup, selection or ordinary reading.
- Add the separately loaded `content/reader.js` adapter for Zotero's bundled PDF.js 5.7 viewer. It loads local attachment bytes through `IOUtils`, supports page navigation, native text selection, find/highlight, bounded page rendering and full cancellation/cleanup. Integration must load this file before `room.js`.
- Add synthetic tests for catalog/focus behavior, saved-analysis reuse, explicit analysis, pre-switch note flushing, independent settings, origin/provider consent binding and PDF.js lifecycle. Live Zotero 10.0.7 checks cover embedded PDF rendering, citation page jumps, source-page images, secure configuration reload, cache reuse and focused-paper switching; see docs/TESTING.md.

- Fix Gecko chrome/content event delivery and awaited PDF page wrappers; prevent stale page previews after switching papers, preserve pending notes on switching/closing, and keep settings checkboxes within their labels.

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
