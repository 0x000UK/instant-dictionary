# Instant Dictionary

A Firefox extension that shows you the definition of any word or phrase without leaving the page. Double-click a word, drag to select a phrase, or use your keyboard — a tooltip pops up right where you're reading.

No popups. No new tabs. No searching.

---

## What it does

You're reading something and hit a word you don't know. Instead of copying it, switching tabs, Googling it, and losing your place — you just double-click it. The definition appears right there, next to the word, and disappears on its own after a few seconds.

It works on pretty much any page — articles, Wikipedia, web PDFs, local documents, documentation, whatever.

---

## How to trigger it

**Double-click** any single word → instant definition.

**Click and drag** to highlight a word or short phrase → a small **Define** pill appears near your cursor. Click it to look up the selection. (This gate exists so dragging to copy doesn't accidentally trigger a lookup every time).

**Right-click (Context Menu)** → Select text, right-click, and choose **"Define '...'"**.

**Keyboard** → Make a selection any way you like, then press the designated hotkey (**Alt+Q**) to trigger the lookup. (**Note: Hotkey(Alt+Q) and 'double-click on a word to trigger the tooltip' will not work in Reader Mode (`about:reader`). To define a word in Reader Mode, highlight the text, right click to open Context Menu & click "Define".**)

**Toggle Sidebar & Search** → Press **Alt+W** (Mac: **Cmd+W**) to instantly open or close the Instant Dictionary sidebar. From here, you can manage local files or use the dedicated search bar to look up words manually.
<br><br><span style="color: #d32f2f; font-size: 1.15em; font-weight: bold;">⚠️ IMPORTANT NOTE: A brief visual flash of the dictionary sidebar opening and closing upon browser launch is expected behavior. This occurs exclusively if Firefox was closed while the sidebar was active, and is an unavoidable artifact of Firefox's native Session Restore sequence.</span>

**Close it** → click the × button, click anywhere outside the tooltip, or press **Alt+Q** or **Escape**.

The tooltip auto-closes after 6 seconds so it won't get in your way if you ignore it. Hovering over it pauses the countdown, if you want to take your time reading the meaning(s).

---

## Reading PDFs & Local Files

Web browsers heavily restrict extensions from running on local files (`file:///`) and native PDF viewers for security reasons. To bypass this, Instant Dictionary comes with a built-in, fully integrated document viewer.

**Web PDFs:** Firefox's built-in PDF viewer doesn't allow extensions to run inside it, so the dictionary would have no way to work on PDFs opened that way. To get around this, Instant Dictionary quietly watches for any PDF links you click on the web. The moment you click one, it steps in before Firefox can open it in the default viewer, and loads the document in its own built-in PDF viewer instead — one that already has the dictionary fully active. By the time the PDF appears on your screen, everything is ready to go. Just double-click or select any word as usual.

**Local Files (PDF, EPUB, DOCX):** To open documents stored on your computer, you need to access the Instant Dictionary Sidebar. You can do this in two ways:

* **Method 1: The Quick Shortcut (Recommended)**
  Simply press **Alt+W** (Mac: **Cmd+W**) to instantly open the sidebar.
* **Method 2: The Permanent Toolbar Button**
  Go to Firefox **Settings** > **General** > type "Sidebar" in the search box at the top > Check the **"Show sidebar"** box. A sidebar icon will permanently appear at the top-left of your browser toolbar. Click it and select "Instant Dictionary" from the dropdown.

Once the sidebar is open:
1. Click the 📂 **Open Local Files** button at the top.
2. Drag and drop your document into the **Dropzone**, or click it to browse your computer.
3. The file opens seamlessly with full dictionary support. *(Note: PDF is fully supported; EPUB and DOCX viewers are coming soon).*
---

## Recent Files & Memory Management:

1. **Bookshelf Storage:** Your last 5 opened local files are saved securely inside the extension's database for quick, 1-click access. Older files are automatically evicted to save space.
2. **Smart Tab Routing:** Every unique document opens in its own tab. If you click a file in the sidebar that is already open, the extension will instantly pull your browser focus to that existing tab, rather than creating an annoying duplicate.
3. **Session Resumption:** If you close Firefox and reopen it, the document will load and instantly jump to your exact last-read page and scroll position!

## What shows up in the tooltip

- The word or phrase you looked up
- Phonetic pronunciation where available (e.g. `/ˈwɜːd/`)
- Part of speech — noun, verb, adjective, etc.
- Up to 3 definitions per part of speech, across up to 3 parts of speech
- Example sentences where available
- Synonyms and antonyms (Free Dictionary source)
- A **🔊 Listen** button for audio pronunciation playback (Merriam-Webster sources only)
- A **⇄ Thesaurus / ⇄ Collegiate** toggle button when both Merriam-Webster keys are configured — lets you switch between the Collegiate and Thesaurus results for the same word without a new lookup
- The source the definition was pulled from

---

## Where it gets definitions from

The extension tries sources in sequence and stops at the first one that returns a result. Which sources are tried, and in what order, depends on your **Lookup Priority** setting and whether you have API keys saved.

**Free sources (no setup required):**

| # | Source | Best for |
|---|---|---|
| 1 | **[Free Dictionary API](https://dictionaryapi.dev/)** | Common English words — clean structured data with phonetics, examples, synonyms, antonyms |
| 2 | **[Wiktionary](https://en.wiktionary.org/)** | Broader coverage — technical terms, loanwords, archaic words, proper nouns |

**Optional premium sources:**

| # | Source | Best for |
|---|---|---|
| 3 | **[STANDS4 Vocabulary API](https://www.stands4.com/)** | Single-word definitions with part-of-speech, example, and pronunciation |
| 4 | **[STANDS4 Phrases API](https://www.stands4.com/)** | Idioms, phrasal verbs, and multi-word expressions (e.g. "kick the bucket", "on the fence") — only called for multi-word selections |
| 5 | **[Merriam-Webster Collegiate](https://dictionaryapi.com/)** | Authoritative single-word definitions + **audio pronunciation**. Free accounts: up to 1,000 lookups/day |
| 6 | **[Merriam-Webster Thesaurus](https://dictionaryapi.com/)** | Synonyms and related words. Complements the Collegiate key; shares the same daily limit counter |

If no source returns a result, the tooltip says so explicitly rather than silently showing nothing. If a configured API key was rejected or over quota, that detail is surfaced in the tooltip so you know why the fallback kicked in.

---

## Optional API keys

The extension works out of the box with no accounts or setup. The free sources cover most everyday words well. API keys unlock audio pronunciation, richer single-word entries, and idiom coverage.

Keys are saved in the extension's popup (click the toolbar icon).

### Merriam-Webster

MW issues **two separate keys** — one per API product. Each is a UUID in the format `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`.

| Key | What it unlocks |
|---|---|
| **Collegiate Dictionary API Key** | Authoritative definitions + **🔊 audio pronunciation playback** |
| **Thesaurus Dictionary API Key** | Synonyms and related words; enables the ⇄ toggle button |

→ [Register for free API keys](https://dictionaryapi.com/register/index) — create separate accounts (or separate products) for Collegiate and Thesaurus.

You can save either or both. Saving only the Collegiate key gives you definitions and audio. Saving both unlocks the in-tooltip ⇄ toggle so you can flip between dictionary and thesaurus views for the same word.

> **Important:** The two MW keys are different UUIDs. Entering the same key in both fields is detected and flagged as an error in the popup.

### STANDS4

Adds richer single-word entries and, more importantly, coverage for **idioms and multi-word expressions** that standard dictionaries miss.

→ [Get your free API key at STANDS4's Phrase API](https://www.phrases.com/api.php) — your **User ID** (numeric) and **Token** (alphanumeric) are on your profile page after login. Both fields are required; entering only one is flagged as an error.

---

## Lookup Priority

Configurable in Settings → **Lookup** tab. Controls the source order when API keys are configured.

| Setting | Behaviour |
|---|---|
| **Standard (Recommended)** *(default)* | Queries publicly available sources first. API credentials are consulted only if primary sources return no result. |
| **Enhanced** | Queries your configured API sources first, then falls back to public sources. |

The source sequence is printed to the **Logs** tab on every lookup so you can see exactly what was tried and in what order.

---

## API usage tracking

The settings popup **API Usage** tab shows:

- How many calls you've made today to each premium API (MW combined, STANDS4 separately)
- A progress bar showing usage against your configured daily limit
- A slider to set your own daily cap per API (below the provider's hard ceiling)
- A **Reset today's counters to zero** button to clear today's counters manually

Counters auto-reset at midnight based on local date. Everything is stored locally — nothing is sent anywhere.

---

## Activity log

The settings popup **Logs** tab records every lookup in the current session:

- What was looked up, in what priority mode, via which source sequence
- Which source resolved the result, or why all sources returned nothing
- API errors (quota exceeded, key rejected, network failure) highlighted in red

Logs are capped at 200 entries (oldest evicted first) and persist across popup opens within the same browser session. Use **Clear all logs** to wipe them.

---

## A few things worth knowing

**It adapts to the page's colour scheme.** The tooltip reads the computed background colour of the page and adjusts its own colours to match.

**Lookups are cached per session.** Looking up the same word twice in a tab is instant — the result is served from an in-memory LRU cache. The cache is keyed by priority setting, so switching from Standard to Enhanced and back correctly triggers a fresh fetch.

**Short inputs are filtered.** Single characters are only accepted if they're "a" or "I".

**Selections must be letters only.** Numbers, URLs, code, and emoji are not looked up.

**Max lookup length is 60 characters.** Long selections are silently ignored.

---

## Installation

### From the Firefox Add-ons store
*(Link here once listed)*

### Manual install (`.xpi`)
1. Download the latest `.xpi` from [Releases](https://github.com/0x000UK/instant-dictionary/releases)
2. Open Firefox → `about:addons`
3. Click the gear icon → **Install Add-on From File…**
4. Select the `.xpi`

### Load unpacked (development)
1. Clone this repo
2. Open Firefox → `about:debugging` → **This Firefox**
3. Click **Load Temporary Add-on…**
4. Select `manifest.json` from the repo root

---

## Permissions

| Permission | Why |
|---|---|
| **`<all_urls>`** | So the extension works on any site, not just a hardcoded list |
| **`storage`** | To save your API keys, priority setting, daily limits, and usage counters locally in the browser |
| **`contextMenus`** / **`menus`** | To add the "Define '...'" option to the right-click menu |
| **`webRequest`** / **`webRequestBlocking`** | To automatically intercept web PDFs and route them to the dictionary-enabled custom viewer |

Network requests go only to the dictionary API endpoints. No data is collected, no analytics run, and nothing is transmitted anywhere except the word you looked up. Local files are processed entirely on your machine and stored locally in IndexedDB.

---

## License

MIT