# more-extensions

Paperback 0.8 extensions — ports of their Paperback 0.9 counterparts, adapted for 0.8:

- **Comix** — comix.to (embedded site secure module, signed requests; see the comix-extensions repo for details)
- **MangaDex** — api.mangadex.org
- **MangaFire** — mangafire.to (requests are signed with the site's own protection module, embedded)

**MangaNato** was removed from this repository (it did not work reliably against manganato.gg's
Cloudflare protection). Its files remain in the repository history and it can be re-added later.

## Add to Paperback

Base URL: `https://cn23yyyy.github.io/more-extensions/0.8`

Open that URL in a browser for an "Add to Paperback" button, or paste the base URL into
Paperback's repository settings.

## Updating

Each source's `versioning.json` entry is bumped independently; refresh the repository in
Paperback to pick up updates.
