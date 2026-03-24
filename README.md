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

**Click and drag** to highlight a word or short phrase → definition appears when you release.

**Keyboard** → hold Shift to extend a selection, then release Shift to trigger the lookup.

**Close it** → click the × button, click anywhere outside, or press Escape.

It auto-closes after 8 seconds anyway, so it won't get in your way if you ignore it.

---

## What shows up in the tooltip

- The word + phonetic pronunciation (e.g. `/ˈwɜːd/`)
- Part of speech — noun, verb, adjective, etc.
- Up to 3 definitions per part of speech
- Example sentences where available
- Synonyms and antonyms
- A **🔊 Listen** button if an audio pronunciation is available
- The source it pulled from (Free Dictionary or Wiktionary)

---

## Where it gets definitions from

It tries two sources, in order:

1. **[Free Dictionary API](https://dictionaryapi.dev/)** — clean structured data, good for common English words. Tried first.
2. **[Wiktionary](https://en.wiktionary.org/)** — much broader coverage, including technical terms, loanwords, and less common words. Used as a fallback if the first source comes up empty.

If neither has a definition, it tells you that too instead of just showing nothing.

---

## A few things worth knowing

**It adapts to the page theme.** The tooltip reads the background colour of the page you're on and adjusts its own colours to match — so it looks reasonable on dark-mode sites, light sites, and anything in between. It's not perfect for every site but it's a lot better than a fixed white box on a dark page.

**Short inputs are filtered.** Single characters are ignored unless they're "a" or "I" — the only single-letter English words that have real dictionary entries. This just avoids pointless API calls when you accidentally double-click whitespace or a bullet point.

**Max lookup length is 60 characters.** Long selections are ignored. The extension is built for words and short phrases, not sentences.

**Lookups are debounced.** If you make a selection and immediately adjust it, it waits 300ms before firing the request. Prevents spamming the API when you're dragging to find the right selection.

---

## Installation

### From the Firefox Add-ons store
*(Link here once listed)*

### Manual install (Developer Mode)
1. Download the latest `.xpi` from [Releases](https://github.com/0x000UK/instant-dictionary/releases)
2. Open Firefox → `about:addons`
3. Click the gear icon → **Install Add-on From File…**
4. Select the `.xpi`

### Load unpacked (for development)
1. Clone this repo
2. Open Firefox → `about:debugging` → **This Firefox**
3. Click **Load Temporary Add-on…**
4. Select `manifest.json` from the repo folder

---

## Files

```
instant-dictionary/
├── manifest.json     # Extension config (MV2)
├── content.js        # All the logic — event listeners, API calls, tooltip rendering
├── content.css       # Tooltip styles + countdown bar animation
├── updates.json      # Auto-update manifest for Firefox
└── icons/
    └── icon.png
```

There's no build step, no dependencies, no bundler. It's plain JS injected directly into pages as a content script.

---

## Updating

When a new version is released:

1. Upload the new `.xpi` to GitHub Releases under a new tag (e.g. `v1.0.1`)
2. Add the new version entry to `updates.json`:

```json
{
  "version": "1.0.1",
  "update_link": "https://github.com/0x000UK/instant-dictionary/releases/download/v1.0.1/instant-dictionary.xpi"
}
```

Firefox checks `updates.json` automatically and prompts users to update.

---

## Permissions

- **`activeTab`** — needed to inject the tooltip into the current page
- **`<all_urls>`** — so it works on any site you visit, not just a hardcoded list

Network access is limited (via CSP) to only the two dictionary APIs. No data is collected, no analytics, nothing is sent anywhere except the word you looked up.

---

## License

MIT
