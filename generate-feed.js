/**
 * Facebook Dynamic Ads (DPA) Feed Generator for Hotel Skansen packages.
 *
 * Unlike the other feeds in this repo (which read a clean JSON API), Hotel
 * Skansen has no product API, so we scrape the WordPress "/paket/" pages:
 *   1. Discover every /paket/<slug>/ URL from the listing page.
 *   2. For each package page extract:
 *        - title       -> the <h1> (the short package name, e.g. "Whiskypaket")
 *        - price        -> LOWEST per-person price on the page (see PRICE RULE)
 *        - image        -> og:image (package-specific hero image)
 *        - description  -> meta description
 *   3. Download each hero image and CENTER-CROP it to 1:1 (square), required
 *      because Hotel Skansen images come in mixed portrait/landscape ratios.
 *      Cropped squares are written to output/images/<slug>.jpg and referenced
 *      via the GitHub Pages URL (FEED_BASE_URL).
 *   4. Emit feed.xml (RSS 2.0 + g: namespace), feed.csv and index.html.
 *
 * PRICE RULE (confirmed with the team):
 *   "Lägsta seriösa paketpris/person" — the lowest price on the page that
 *   carries a per-person suffix (/person, per person, /pers). This automatically
 *   excludes supplements (e.g. "Enkelrumstillägg 449:-") and the site-wide
 *   event banner ("Ölprovning 500:-"), since those have no per-person suffix.
 *
 * Runs daily via GitHub Actions (package prices don't change hourly).
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const LISTING_URL = 'https://www.hotelskansen.com/paket/';
const SITE_HOST = 'www.hotelskansen.com';
const OUTPUT_DIR = './output';
const IMAGE_DIR = path.join(OUTPUT_DIR, 'images');
const SQUARE_SIZE = 1080; // px — Meta recommends >=600, square

// IMPORTANT: the absolute base URL where output/ is published (GitHub Pages).
// Cropped images are served from `${FEED_BASE_URL}/images/<slug>.jpg`.
// Set the FEED_BASE_URL env var (or GitHub Actions variable) to the real URL,
// e.g. https://<user>.github.io/hotelskansen-feed
const FEED_BASE_URL = (process.env.FEED_BASE_URL || 'https://REPLACE-ME.github.io/hotelskansen-feed').replace(/\/+$/, '');

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function get(url, { binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https
      .get(
        {
          hostname: u.hostname,
          path: u.pathname + u.search,
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HotelSkansenFeedBot/1.0)' },
        },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            // follow redirect
            const next = new URL(res.headers.location, url).toString();
            res.resume();
            return resolve(get(next, { binary }));
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          }
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const buf = Buffer.concat(chunks);
            resolve(binary ? buf : buf.toString('utf8'));
          });
        }
      )
      .on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// HTML parsing helpers
// ---------------------------------------------------------------------------
function decodeEntities(s) {
  if (!s) return '';
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&rsquo;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&ouml;/g, 'ö')
    .replace(/&auml;/g, 'ä')
    .replace(/&aring;/g, 'å')
    .replace(/&ndash;/g, '–')
    // generic numeric entities, e.g. &#038; -> & , &#8211; -> –
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/\s+/g, ' ')
    .trim();
}

function metaContent(html, attr, value) {
  // matches <meta property="og:image" content="..."> in either attr order
  const re = new RegExp(
    `<meta[^>]+(?:${attr}=["']${value}["'][^>]*content=["']([^"']*)["']|content=["']([^"']*)["'][^>]*${attr}=["']${value}["'])`,
    'i'
  );
  const m = html.match(re);
  return m ? decodeEntities(m[1] || m[2] || '') : '';
}

function firstH1(html) {
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (!m) return '';
  return decodeEntities(m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
}

/**
 * Discover every package URL from the listing page.
 */
async function discoverPackageUrls() {
  const html = await get(LISTING_URL);
  const re = /https:\/\/www\.hotelskansen\.com\/paket\/[a-z0-9-]+\//gi;
  const urls = new Set();
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = m[0];
    if (url !== LISTING_URL) urls.add(url);
  }
  return [...urls].sort();
}

/**
 * PRICE RULE: lowest price carrying a per-person suffix.
 * Matches numbers like 1750:-/person, 349:- per person, 580 kr/person,
 * 1795:- /person, "3 150:-/person". Ignores /rum, /natt, bare 449:-, 500:-.
 */
function extractLowestPerPersonPrice(html) {
  const text = html
    .replace(/<[^>]+>/g, ' ') // strip tags
    .replace(/\\\//g, '/') // unescape JSON-LD style \/
    .replace(/&nbsp;|&#160;/g, ' ');
  const re = /(\d[\d\s. ]{0,7}\d|\d)\s*(?::-|(?:kr|sek)(?![a-zåäö]))\.?\s*\/?\s*(?:per\s+person|person|pers)\b/gi;
  let m;
  let lowest = null;
  const found = [];
  while ((m = re.exec(text)) !== null) {
    const value = parseInt(m[1].replace(/[^\d]/g, ''), 10);
    if (!Number.isFinite(value) || value <= 0) continue;
    found.push(value);
    if (lowest === null || value < lowest) lowest = value;
  }
  return { lowest, all: found };
}

/**
 * Classify package for custom_label_0 segmentation (the set is heterogeneous:
 * overnight packages vs spa day-passes).
 */
function classify(slug, html) {
  const text = html.toLowerCase();
  // Strong overnight signals only ("frukost" is too common — day-spa pages
  // mention breakfast too).
  const hasOvernight = /(övernattning|övernatta|\bnätter\b|\bnatt\b|\bnätt\b|incheckning|utcheckning)/.test(text);
  if (hasOvernight) return 'Övernattningspaket';
  if (slug.includes('spa') || /spaentr|kvallsmys|kvällsmys|morgonmys|halvdag|heldag|seniorer|relax/.test(slug)) return 'Spa & dagpaket';
  return 'Paket';
}

async function parsePackage(url) {
  const slug = url.replace(/\/$/, '').split('/').pop();
  const html = await get(url);

  const title = firstH1(html) || metaContent(html, 'property', 'og:title').replace(/\s*[|–-]\s*Hotel Skansen.*$/i, '').trim();
  const description =
    metaContent(html, 'name', 'description') ||
    metaContent(html, 'property', 'og:description');
  const ogImage =
    metaContent(html, 'property', 'og:image') ||
    metaContent(html, 'name', 'twitter:image') ||
    metaContent(html, 'property', 'twitter:image');
  const { lowest, all } = extractLowestPerPersonPrice(html);
  const category = classify(slug, html);

  return { slug, url, title, description, ogImage, price: lowest, pricesFound: all, category };
}

/**
 * Download the hero image and center-crop it to a SQUARE_SIZE x SQUARE_SIZE 1:1 JPEG.
 */
async function buildSquareImage(pkg) {
  if (!pkg.ogImage) return null;
  const buf = await get(pkg.ogImage, { binary: true });
  const outPath = path.join(IMAGE_DIR, `${pkg.slug}.jpg`);
  await sharp(buf)
    .resize(SQUARE_SIZE, SQUARE_SIZE, { fit: 'cover', position: 'attention' }) // smart center crop to 1:1
    .jpeg({ quality: 85 })
    .toFile(outPath);
  return `${FEED_BASE_URL}/images/${pkg.slug}.jpg`;
}

// ---------------------------------------------------------------------------
// Output: XML + CSV
// ---------------------------------------------------------------------------
function escapeXml(unsafe) {
  if (unsafe === null || unsafe === undefined) return '';
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function escapeCsv(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\n;]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
  return str;
}

function generateXMLFeed(items) {
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">\n';
  xml += '  <channel>\n';
  xml += '    <title>Hotel Skansen - Hotellpaket &amp; weekendpaket</title>\n';
  xml += '    <link>https://www.hotelskansen.com/paket/</link>\n';
  xml += '    <description>Hotellpaket och weekendpaket på Hotel Skansen, Öland / Kalmar</description>\n';

  for (const it of items) {
    const price = `${it.price} SEK`;
    xml += '    <item>\n';
    xml += `      <g:id>${escapeXml(it.slug)}</g:id>\n`;
    xml += `      <g:title>${escapeXml(it.title)}</g:title>\n`;
    xml += `      <title>${escapeXml(it.title)}</title>\n`;
    xml += `      <g:description>${escapeXml(it.description)}</g:description>\n`;
    xml += `      <description>${escapeXml(it.description)}</description>\n`;
    xml += `      <g:link>${escapeXml(it.url)}</g:link>\n`;
    xml += `      <link>${escapeXml(it.url)}</link>\n`;
    xml += `      <g:image_link>${escapeXml(it.imageLink)}</g:image_link>\n`;
    xml += '      <image>\n';
    xml += `        <url>${escapeXml(it.imageLink)}</url>\n`;
    xml += '      </image>\n';
    xml += `      <g:price>${escapeXml(price)}</g:price>\n`;
    xml += `      <price>${escapeXml(price)}</price>\n`;
    xml += '      <g:availability>in stock</g:availability>\n';
    xml += '      <availability>in stock</availability>\n';
    xml += '      <g:condition>new</g:condition>\n';
    xml += '      <g:brand>Hotel Skansen</g:brand>\n';
    xml += `      <g:custom_label_0>${escapeXml(it.category)}</g:custom_label_0>\n`;
    xml += '    </item>\n';
  }

  xml += '  </channel>\n';
  xml += '</rss>';
  return xml;
}

function generateCSVFeed(items) {
  const headers = [
    'id',
    'title',
    'description',
    'availability',
    'condition',
    'price',
    'link',
    'image_link',
    'brand',
    'custom_label_0',
  ];
  let csv = headers.join(',') + '\n';
  for (const it of items) {
    csv +=
      [
        escapeCsv(it.slug),
        escapeCsv(it.title),
        escapeCsv(it.description),
        escapeCsv('in stock'),
        escapeCsv('new'),
        escapeCsv(`${it.price} SEK`),
        escapeCsv(it.url),
        escapeCsv(it.imageLink),
        escapeCsv('Hotel Skansen'),
        escapeCsv(it.category),
      ].join(',') + '\n';
  }
  return csv;
}

function generateIndexHtml(items, skipped) {
  const rows = items
    .map(
      (it) =>
        `<tr><td>${escapeXml(it.title)}</td><td>${it.price} SEK</td><td>${escapeXml(it.category)}</td></tr>`
    )
    .join('\n');
  return `<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="utf-8">
  <title>Hotel Skansen Facebook Feed</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 820px; margin: 50px auto; padding: 20px; }
    h1 { color: #333; }
    .feed-url { background: #e8f5e9; padding: 15px; border-radius: 5px; margin: 20px 0; word-break: break-all; }
    code { background: #f5f5f5; padding: 2px 6px; border-radius: 3px; }
    table { border-collapse: collapse; width: 100%; margin-top: 20px; }
    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; font-size: 14px; }
    th { background: #f0f0f0; }
  </style>
</head>
<body>
  <h1>Hotel Skansen — Facebook Dynamic Ads Feed</h1>
  <div class="feed-url">
    <strong>Use this URL in Facebook Commerce Manager:</strong><br><br>
    <code id="feedUrl">Loading...</code>
  </div>
  <p>Packages in feed: <strong>${items.length}</strong>${skipped.length ? ` &nbsp;|&nbsp; skipped (no price): <strong>${skipped.length}</strong>` : ''}</p>
  <ul>
    <li><a href="feed.xml">View XML feed</a></li>
    <li><a href="feed.csv">View CSV feed</a></li>
  </ul>
  <table>
    <tr><th>Package</th><th>From price</th><th>Category</th></tr>
    ${rows}
  </table>
  <script>
    document.getElementById('feedUrl').textContent =
      window.location.origin + window.location.pathname.replace(/index\\.html$/, '') + 'feed.xml';
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('Starting Hotel Skansen feed generation...');
  if (FEED_BASE_URL.includes('REPLACE-ME')) {
    console.warn('⚠️  FEED_BASE_URL is not set — image links will point to a placeholder host.');
    console.warn('    Set the FEED_BASE_URL env var to your GitHub Pages URL before going live.');
  }

  fs.mkdirSync(IMAGE_DIR, { recursive: true });

  const urls = await discoverPackageUrls();
  console.log(`Discovered ${urls.length} package pages.`);

  const items = [];
  const skipped = [];

  for (const url of urls) {
    let pkg;
    try {
      pkg = await parsePackage(url);
    } catch (e) {
      console.warn(`  ✗ ${url} — fetch/parse failed: ${e.message}`);
      skipped.push({ url, reason: 'fetch failed' });
      continue;
    }

    if (!pkg.price) {
      console.warn(`  ⊘ ${pkg.slug} — no per-person price found, skipping.`);
      skipped.push({ url, reason: 'no price' });
      continue;
    }
    if (!pkg.title) {
      console.warn(`  ⊘ ${pkg.slug} — no title, skipping.`);
      skipped.push({ url, reason: 'no title' });
      continue;
    }

    try {
      pkg.imageLink = await buildSquareImage(pkg);
    } catch (e) {
      console.warn(`  ! ${pkg.slug} — image crop failed (${e.message}), skipping.`);
      skipped.push({ url, reason: 'image failed' });
      continue;
    }
    if (!pkg.imageLink) {
      console.warn(`  ⊘ ${pkg.slug} — no og:image, skipping.`);
      skipped.push({ url, reason: 'no image' });
      continue;
    }

    console.log(`  ✓ ${pkg.title} — from ${pkg.price} SEK [${pkg.category}]`);
    items.push(pkg);
  }

  if (items.length === 0) throw new Error('No packages processed — aborting.');

  fs.writeFileSync(path.join(OUTPUT_DIR, 'feed.xml'), generateXMLFeed(items), 'utf8');
  fs.writeFileSync(path.join(OUTPUT_DIR, 'feed.csv'), '﻿' + generateCSVFeed(items), 'utf8');
  fs.writeFileSync(path.join(OUTPUT_DIR, 'index.html'), generateIndexHtml(items, skipped), 'utf8');

  console.log(`\nDone. ${items.length} packages in feed, ${skipped.length} skipped.`);
  if (skipped.length) {
    console.log('Skipped:');
    skipped.forEach((s) => console.log(`  - ${s.url} (${s.reason})`));
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
