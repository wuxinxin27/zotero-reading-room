# Reading Room for Zotero

[中文说明](README.md) · [Privacy](PRIVACY.md) · [Security](SECURITY.md)

A local-first, experimental Zotero 10 reading companion. The latest released version remains **0.2.0**; the two-pane reader and workspace described below are unreleased development changes. Zotero **10.0–10.*** is the declared range, with **10.0.7** as the initial live-test target. Synthetic automated tests do not establish live compatibility. See the [test checklist](docs/TESTING.md). This project does not claim inclusion in the official Zotero add-ons directory.

- Manually select **Unread / To read / Reading / Read / Parked**. Completed analysis never means the user has read or fully reviewed the paper.
- Record local notes and a reading checklist; show bibliographic metadata, local PDFs, and note/annotation counts.
- Browse every accessible Zotero library, search and page through papers, select a library, filter focused papers, and switch quickly among focused-paper chips. The navigation pane collapses.
- Read local source PDFs in a left pane and AI analysis plus notes in a right pane, with a keyboard-adjustable splitter and stacked narrow layout. Evidence buttons jump to physical PDF pages and attempt to highlight literal text. Missing page numbers are never guessed.
- AI analysis returns a natural overview, a reading guide, six source-backed dimensions, and text references to figures and tables. Figure cards lazily render the “source page containing the reference”; they do not claim a precise crop or visual interpretation.
- OpenAI-compatible, Anthropic Messages, Google Gemini, and native Ollama configurations are independent from analysis. Analysis is cached per paper and attachment and is reused without a model request; only an explicit reanalysis sets `force: true`.
- Explicitly export JSON/Markdown, create an analysis note, or save a reading-state snapshot to a plugin-owned note in a personal library. Existing user notes and parent metadata are not overwritten; group-library note writes are forbidden.

Download the `.xpi` and `SHA256SUMS` from [Releases](https://github.com/wuxinxin27/zotero-reading-room/releases), verify the checksum, then use **Tools → Plugins → Install Plugin From File** in Zotero (the option may be under the gear menu). Select a paper and open Reading Room through its menu, context-menu or item-pane entry. Zotero 10 requires an update URL; the build generates versioned `updates.json` with the XPI SHA-256 for Release distribution. Update checks follow Zotero settings; upgrading between released versions is not yet independently verified.

No model request, attachment download or endpoint discovery runs at startup. Selecting or switching papers also makes no model request and can show a saved analysis without a configured key. The independent model settings accept four protocols and a base URL or the corresponding legacy full request URL; endpoint normalization is handled by the backend, as documented in [API providers](docs/API-PROVIDERS.md). The OpenAI-compatible default remains `http://127.0.0.1:11434/v1/chat/completions`.

Model discovery begins only after you open AI settings. Changes to the endpoint, protocol, or key are debounced by about 700ms; superseded requests are cancelled and late results are ignored. The returned list is searchable and manual model IDs remain available. Unsupported listing endpoints, authentication failures, timeouts, and empty lists show a clear fallback message. The plugin does not ship a list of supposedly available model names, and it does not start or download models.

Loopback endpoints can discover models automatically. Remote HTTPS discovery requires a separate explicit permission and does not send a PDF or paper text. Starting analysis requires another permission before bounded text chunks and page positions are sent. Group-library remote analysis is blocked. Each remote permission is bound to both origin and provider, and changing either revokes the old permission and clears unsubmitted key input. Keys are not saved by default. With explicit opt-in, Zotero `OSKeyStore` encrypts a key and `Services.logins` stores only the encrypted value; the sidecar contains non-secret configuration and the UI reports only whether a key exists. A local model service may have its own logging or network behavior.

Reading state, focus marks, notes, excerpts and results live in `reading-room/state-v1.json` inside the Zotero data directory, with a previous-version `.bak`. Focus marks and analysis caches are local and do not merge automatically across devices. Zotero synchronization applies only when you explicitly create plugin notes and your Zotero settings sync them. State-note synchronization is an explicit snapshot, not automatic two-way merge or restore. Uninstalling retains state and created notes; export/back up before manually removing them.

This unreleased work has no OCR, visual figure interpretation, proof checking or code verification. Native PDF embedding and page previews were verified on Zotero 10.0.7; narrow layouts and other host versions still need live verification. Page references use physical PDF pages and can differ from printed page labels. Candidate citations and model inferences require manual review. Only the reader can confirm a full review.

Build with **Node.js 22+**, without npm dependencies or installation:

```sh
npm test
npm run check
npm run build
```

Outputs: `dist/zotero-reading-room-0.2.0.xpi` (a deterministic standard ZIP containing runtime addon sources only) plus `dist/SHA256SUMS` and `dist/updates.json`. Tests use synthetic fixtures only. Never submit personal library data, profile paths, titles, excerpts, screenshots or keys. See [contributing](CONTRIBUTING.md), [development](docs/DEVELOPMENT.md), [roadmap](docs/ROADMAP.md), and the [MIT license](LICENSE).
