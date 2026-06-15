# Hotel Skansen — Facebook Dynamic Ads Feed

Genererar en Facebook DPA-feed (RSS 2.0 + `g:`-namespace, samma format som övriga feeds i repot) för Hotel Skansens hotellpaket på <https://www.hotelskansen.com/paket/>.

## Hur den skiljer sig från de andra feedsen

De andra feedsen (borasbil, rejmes, frivio …) läser ett rent JSON-API. Hotel Skansen har inget produkt-API, så `generate-feed.js` **skrapar WordPress-sidorna**:

1. Hämtar alla `/paket/<slug>/`-länkar från listsidan.
2. För varje paketsida extraheras:
   | Fält | Källa |
   |------|-------|
   | **Titel** | `<h1>` (det korta paketnamnet, t.ex. *Whiskypaket*) |
   | **Pris** | Lägsta per-person-priset på sidan (se prisregel nedan) |
   | **Bild** | `og:image` (paket-specifik bild), fallback `twitter:image` |
   | **Beskrivning** | `meta name="description"` |
3. Varje bild laddas ner och **beskärs till 1:1 (1080×1080)** med `sharp` (smart "attention"-crop, eftersom bilderna har blandade porträtt-/landskapsformat). Sparas i `output/images/<slug>.jpg`.
4. Skriver feed-filerna till `output/` (se nedan).

## Feed-filer (kataloggtyp)

Hotel Skansens Meta-katalog är en **Destinations-/rese-katalog**, så den feeden ligger på den primära länken `feed.xml`:

| Fil | Format | Använd för |
|-----|--------|-----------|
| **`feed.xml` / `feed.csv`** | **Destinations (rese)** | **Den länk som klistras in i Commerce Manager** |
| `destinations.xml` / `destinations.csv` | Destinations (rese) | Alias, identiskt med `feed.xml` |
| `products.xml` / `products.csv` | E-handel / produkter | Reserv om katalogen byts till produkttyp |

Destinations-schemat: `destination_id, name, type/types, description, url, image, address` (Tingshusgatan 1, Färjestaden, Öland), `latitude/longitude`, `price/currency`. RSS:en använder listing-formatet (`<address format="simple">`, nästlad `<image>`) — samma konvention som rese-/fordonskatalogerna.

## Prisregel

**"Lägsta seriösa paketpris/person"** (bekräftat med teamet): det lägsta priset på sidan som bär ett **per-person-suffix** (`/person`, `per person`, `/pers`).

Detta utesluter automatiskt:
- tillägg, t.ex. *Enkelrumstillägg 449:-* (saknar per-person-suffix)
- den site-wide eventbannern *Ölprovning 500:-* (saknar per-person-suffix)
- priser per rum/natt, t.ex. `295:-/rum`, `355:-/natt`

Paket utan extraherbart per-person-pris **hoppas över och loggas** (Meta kräver pris per produkt). Vid senaste körningen: 20 paket i feeden, 1 hoppad (`spa-paket-njuta` — borttagen sida som redirectar till listan).

## ⚠️ Viktigt: FEED_BASE_URL

Bilderna self-hostas i `output/images/`. Feedens `image_link` måste vara en **absolut URL**, så sätt miljövariabeln `FEED_BASE_URL` till den publicerade GitHub Pages-adressen innan feeden går live:

```bash
FEED_BASE_URL="https://<user>.github.io/hotelskansen-feed" node generate-feed.js
```

I GitHub Actions sätts den via repo-variabeln `FEED_BASE_URL` (Settings → Secrets and variables → Actions → Variables). Utan den pekar bildlänkarna på en `REPLACE-ME`-platshållare och feeden varnar i loggen.

## Köra lokalt

```bash
npm install
FEED_BASE_URL="https://<user>.github.io/hotelskansen-feed" npm run generate
```

## Deployment

GitHub Actions (`.github/workflows/update-feed.yml`) kör **dagligen kl 04:00 UTC** (paketpriser ändras inte varje timme), installerar beroenden, genererar feeden och deployar `output/` till `gh-pages`-branchen via GitHub Pages.

Feed-URL att klistra in i Facebook Commerce Manager:
`https://<user>.github.io/hotelskansen-feed/feed.xml`
