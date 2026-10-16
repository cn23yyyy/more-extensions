# more-extensions

Paperback 0.8 extensions — ports of their Paperback 0.9 counterparts, adapted for 0.8:

- **MangaDex** — api.mangadex.org
- **MangaFire** — mangafire.to (requests are signed with the site's own protection module, embedded)

**Removed**: **Comix** (comix.to) and **MangaNato** (manganato.gg) were removed from this
repository — comix.to's WAF blocks extension clients after a small number of requests and now
serves Cloudflare Turnstile checks that Paperback 0.8 cannot solve in-app, and manganato.gg's
Cloudflare protection made it unreliable. Their files remain in the repository history and can be
re-added later.

## Add to Paperback

Base URL: `https://cn23yyyy.github.io/more-extensions/0.8`

Open that URL in a browser for an "Add to Paperback" button, or paste the base URL into
Paperback's repository settings.

## Updating

Each source's `versioning.json` entry is bumped independently; refresh the repository in
Paperback to pick up updates.
