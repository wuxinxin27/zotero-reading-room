# Changelog

## Unreleased — reading workspace

- Move default entry points into the right sidebar of Zotero's normal PDF reader instead of opening a top-level Reading Room window. Paper selection and evidence navigation follow the current reader attachment. Native UI acceptance for this migration remains pending; earlier standalone-window checks below describe that earlier implementation.
- Add full editing/reset of the analysis system prompt, multi-chunk synthesis instruction and paper-chat system prompt, with verbatim defaults in docs/AI-PROMPTS.md. Prompt saves do not call models or invalidate cached analyses; explicit reanalysis stores prompt provenance.
- Add reviewed, explicit batch selections of up to 1000 papers, sequential processing, per-paper progress/cache/error states, cancellation and failed-item retry. Freeze batch scope and prompts; stop later sends if model/endpoint/permission/credential configuration changes. Completed results survive cancellation; queues do not automatically resume after restart.
- Add current-paper chat over bounded extracted-text excerpts and recent history across all four API protocols. Persist only successful question/answer pairs and validated source quotes per paper/attachment; preserve history on failure/cancellation and label unsupported answers unverified. Remote paper-text consent and group restrictions also apply to chat.
- On manual reading-status changes only, save local state then synchronize exactly one of the five reserved tags: `阅读室/未读`, `阅读室/待读`, `阅读室/在读`, `阅读室/已读`, `阅读室/搁置`. Preserve unrelated tags and fields; retain local status with an explicit warning when native writes are unavailable or fail. Native tags may sync through Zotero; local sidecar records are not automatically merged or restored from tags. AI never marks papers read.

- Fix Zotero chrome-window dropdowns with in-document listboxes, solid popup surfaces, real DOM change events, HTMLCollection-compatible option enumeration, keyboard navigation and popup cleanup; refresh PDF choices after each paper loads.
- Preserve library and nested collection hierarchy, including empty collections, and filter the catalog by direct collection membership while keeping global focused-paper shortcuts.
- Reclaim navigation space at the root grid when collapsed, re-fit the PDF to the wider pane and preserve the source/AI split ratio. Add installed-host API and native UI verification records.

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
