# Reading Room for Zotero

[中文说明](README.md) · [Privacy](PRIVACY.md) · [Security](SECURITY.md)

A local-first, experimental Zotero 10 reading companion. Version **0.1.0** targets Zotero **10.0–10.***; the initial live-test target is **10.0.7**. Synthetic automated tests do not establish live compatibility. See the [test checklist](docs/TESTING.md). This project does not claim inclusion in the official Zotero add-ons directory.

- Manually select **Unread / To read / Reading / Read / Parked**. Completed analysis never means the user has read or fully reviewed the paper.
- Record local notes and a reading checklist; show bibliographic metadata, local PDFs, and note/annotation counts.
- Offline extractive prereading finds **candidate passages**, organized into six dimensions: problem, novelty, contributions, prior work, advantages and boundaries, and technical uniqueness. Contribution cues include theory, algorithm, experiments and engineering.
- Optional model analysis uses an explicitly submitted OpenAI-compatible endpoint. Evidence is checked against extracted text; a literal match does not prove that a claim is supported or true.
- Explicitly export JSON/Markdown, create an analysis note, or save a reading-state snapshot to a plugin-owned note in a personal library. Existing user notes and parent metadata are not overwritten; group-library note writes are forbidden.

Download the `.xpi` and `SHA256SUMS` from [Releases](https://github.com/wuxinxin27/zotero-reading-room/releases), verify the checksum, then use **Tools → Plugins → Install Plugin From File** in Zotero (the option may be under the gear menu). Select a paper and open Reading Room through its menu, context-menu or item-pane entry. Zotero 10 requires an update URL; the build generates versioned `updates.json` with the XPI SHA-256 for Release distribution. Update checks follow Zotero settings; upgrading between released versions is not yet independently verified.

No model request, attachment download or endpoint discovery runs at startup. Extractive prereading is offline and starts only on request. The model dialog defaults to `http://127.0.0.1:11434/v1/chat/completions`; provide an available model name yourself. The plugin does not start or download models. Remote endpoints require HTTPS and explicit consent, and are blocked for group libraries. Requests contain bounded extracted text chunks and page positions: at most the first 12 chunks and 120000 characters, potentially less. Keys remain in request memory and are not saved by the plugin. A local model service may have its own logging/network behavior.

Reading state, excerpts and results live in `reading-room/state-v1.json` inside the Zotero data directory, with a previous-version `.bak`. Zotero synchronization applies only when you explicitly create plugin notes and your Zotero settings sync them. State-note synchronization is an explicit snapshot, not automatic two-way merge or restore. Uninstalling retains state and created notes; export/back up before manually removing them.

This version has no OCR, visual figure interpretation, proof checking or code verification. Page references depend on validated PDF-worker page boundaries and may be unavailable. Extracted PDF page order can differ from printed page labels. Candidate citations and model inferences require manual review. Only the reader can confirm a full review.

Build with **Node.js 22+**, without npm dependencies or installation:

```sh
npm test
npm run check
npm run build
```

Outputs: `dist/zotero-reading-room-0.1.0.xpi` (a deterministic standard ZIP containing runtime addon sources only) and `dist/SHA256SUMS`. Tests use synthetic fixtures only. Never submit personal library data, profile paths, titles, excerpts, screenshots or keys. See [contributing](CONTRIBUTING.md), [development](docs/DEVELOPMENT.md), [roadmap](docs/ROADMAP.md), and the [MIT license](LICENSE).
