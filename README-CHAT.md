# Panel of Experts chat assistant

A closed-circuit RAG chat for the UN Sanctions Evasion site. It answers **only** from
`data/knowledge-base.json` (34 passages from 7 sources) and never searches the web.

## Try it now

**Option 1 - full mode (recommended).** Needs Node 18+, no `npm install`.

    node server/server.js
    # open http://localhost:3000

**Option 2 - no server.** Double-click `index.html`. The chat button still works in an
"offline demo" mode that searches the same database inside the browser.

## Answer modes

| Mode | How | Where your data goes |
|---|---|---|
| Retrieval-only (default) | nothing to configure | nowhere - passages are quoted from the database |
| Claude | copy `.env.example` to `.env`, set `ANTHROPIC_API_KEY` | the retrieved passages + the question go to the Claude API |
| Local model | `LLM_PROVIDER=ollama` in `.env`, with Ollama running | nowhere - stays on your machine |

In every mode the model sees only the retrieved passages, has no tools or web access, is
told to cite every claim, and is **not called at all** when retrieval finds nothing relevant.
Answers with no valid citation are replaced by "I can't answer that from the database".

Note: the Claude API call (endpoint, headers, model name `claude-sonnet-5-5`) was written
from memory and tested only against a mock server - check it against the current API docs
the first time you use a real key.

## How it works

    question -> retrieve (BM25 + synonyms, js/rag.js) -> relevance gate
             -> [optional LLM, passages only] -> citation check -> answer + sources

## Adding to the database

1. Edit `data/knowledge-base.json`: add an entry to `sources`, then add `chunks`
   (one short passage each, ~60-120 words, with `keywords` people might search for).
2. Run `node scripts/build-kb.js` (refreshes the offline copy).
3. The server reloads the JSON automatically.

## Files

- `data/knowledge-base.json` - the database (edit this); `data/knowledge-base.js` is generated
- `js/rag.js` - retrieval, prompt building, citation checking (shared by server and browser)
- `js/chat-widget.js`, `css/chat.css` - the floating chat window (added to every page)
- `server/server.js` - local server: serves the site and `/api/chat`
- `scripts/build-kb.js` - validates the database and builds the offline copy

## Hosting the site elsewhere

Run the server somewhere reachable, set `ALLOWED_ORIGIN=https://your-site` in `.env`, and
change `data-endpoint="/api/chat"` on the `chat-widget.js` script tag to the full server URL.
Never put an API key in the HTML or JavaScript files.

## Important

The passages are short paraphrased summaries I prepared from public reports and press
coverage of them, not verbatim quotes. Some figures (the 2021 and March 2024 DPRK reports)
come from secondary coverage, as flagged in each source's note. Verify against the linked
originals before relying on or publishing any figure.
