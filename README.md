# Instant Dictionary

A Firefox extension that shows you the definition of any word or phrase without leaving the page. Double-click a word, drag to select a phrase, or use your keyboard — a tooltip pops up right where you're reading.

No popups. No new tabs. No searching.

---

## What it does

You're reading something and hit a word you don't know. Instead of copying it, switching tabs, Googling it, and losing your place — you just double-click it. The definition appears right there, next to the word, and disappears on its own after a few seconds.

It works on pretty much any page — articles, Wikipedia, PDFs in the browser, documentation, whatever.

---

## How to trigger it

**Double-click** any single word → instant definition.

**Click and drag** to highlight a word or short phrase → a small **Define** pill appears near your cursor. Click it to look up the selection. (This gate exists so dragging to copy doesn't accidentally trigger a lookup every time.)

**Keyboard** → make a selection any way you like, then press **Shift** to trigger the lookup.

**Close it** → click the × button, click anywhere outside, or press **Escape**.

The tooltip auto-closes after 6 seconds so it won't get in your way if you ignore it. Hovering over it pauses the countdown.

---

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

The extension tries sources in sequence and stops at the first one that returns a result. Which sources are tried, and in what order, depends on your [Lookup Priority](#lookup-priority) setting and whether you have API keys saved.

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
| **Standard (Recommended)** *(default)* | Free sources lead. For single words: Free Dictionary → Wiktionary → MW Collegiate → MW Thesaurus → STANDS4 Vocab. For phrases: Wiktionary → Free Dictionary → STANDS4 Idioms → MW Collegiate → MW Thesaurus. |
| **Enhanced** | Configured APIs lead. For single words: MW Collegiate → MW Thesaurus → STANDS4 Vocab → Wiktionary → Free Dictionary. For phrases: STANDS4 Idioms → MW Collegiate → MW Thesaurus → Wiktionary → Free Dictionary. |

The source sequence is printed to the **Logs** tab on every lookup so you can see exactly what was tried and in what order.

> **Note:** "Free first" was a previous setting. It is no longer available and is treated as **Standard** if found in saved storage.

Setting has no effect if no API keys are saved — free sources are always tried regardless.

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

**It adapts to the page's colour scheme.** The tooltip reads the computed background colour of the page and adjusts its own colours to match — so it looks at home on dark-mode sites, light sites, and anything in between.

**Lookups are cached per session.** Looking up the same word twice in a tab is instant — the result is served from an in-memory LRU cache (up to 200 entries). The cache is keyed by priority setting, so switching from Standard to Enhanced and back correctly triggers a fresh fetch rather than serving a stale cached result.

**The MW toggle is also cached.** Once you switch between Collegiate and Thesaurus for a word, the alternate result is stored in a separate LRU cache. Toggling back is instant without another network request.

**Short inputs are filtered.** Single characters are only accepted if they're "a" or "I" — the only single-letter English words with dictionary entries. Avoids pointless calls when you accidentally double-click whitespace or punctuation.

**Selections must be letters only (plus spaces, hyphens, apostrophes).** Numbers, URLs, code, and emoji are not looked up.

**Max lookup length is 60 characters.** Long selections are silently ignored. The extension is built for words and short phrases, not sentences.

**Lookups are debounced (300 ms).** If you make a selection and immediately adjust it, the extension waits 300 ms before firing. This prevents spamming the API while you're dragging to find the right selection endpoint. Any in-flight request from a previous lookup is cancelled the moment a new one starts.

**Exponential backoff on rate limits.** If an API returns HTTP 429, the extension retries automatically — up to 3 times, with 1 s → 2 s → 4 s delays — before falling back to the next source in the sequence. The backoff sleep is abort-aware: if you dismiss the tooltip mid-wait, the retry is cancelled immediately.

**Tooltip tracks the page as you scroll.** The tooltip is pinned to the position where it was spawned, not a fixed screen position, so it doesn't drift away from the word when you scroll.

**Audio playback pauses the auto-close countdown.** The tooltip won't disappear while pronunciation audio is playing. The countdown resumes once playback ends.

**The extension is style-isolated.** The tooltip and pill live inside a closed Shadow DOM element that the host page's CSS cannot reach. The extension's own CSS cannot bleed out into the page either.

**Works after extension updates in already-open tabs.** If the extension is reloaded (e.g. after an update), the content script detects the invalidated runtime context and stops making API calls gracefully rather than throwing errors.

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

Network requests go only to the dictionary API endpoints. No data is collected, no analytics run, and nothing is transmitted anywhere except the word you looked up — sent to whichever dictionary API handles that request.

---

## License

MIT
