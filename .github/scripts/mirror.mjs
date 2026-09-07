/**
 * Copy any token artwork that is not mirrored yet.
 *
 * Runs from GitHub Actions with no credentials: the token list and every CID
 * come from Deployr's public API, and the images come from Pinata, which is
 * where pump.fun pins and therefore the only gateway that reliably holds them.
 *
 * Pinata rate-limits, and it tightens as a run goes on — ten requests at a time
 * failed 1,155 of 1,178 when this was first done by hand. Two at a time with a
 * pause between them is what works, so this is slow by design and skips
 * anything already present rather than starting over.
 */

import fs from "fs";
import path from "path";
import sharp from "sharp";

const API = process.env.DEPLOYR_API || "https://deployr-api-production.up.railway.app";
const OUT = path.join(process.cwd(), "tokens");
const MANIFEST = path.join(process.cwd(), "manifest.json");
const SIZE = 256;
const CONCURRENCY = 2;
const PAUSE_MS = 500;
const RETRIES = 2;
/** One run should finish inside the job's time budget; the rest waits for the
 *  next schedule rather than being retried into a rate limit. */
const MAX_PER_RUN = 400;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function allTokens() {
    const out = [];
    let cursor = "0";
    for (let page = 0; page < 40; page += 1) {
        const res = await fetch(`${API}/v1/tokens?limit=250&cursor=${cursor}&market=0`);
        if (!res.ok) break;
        const body = await res.json();
        for (const token of body.tokens || []) out.push(token);
        if (!body.nextCursor) break;
        cursor = body.nextCursor;
    }
    return out;
}

async function fetchImage(token) {
    const urls = [];
    if (token.imageCid) urls.push(`https://gateway.pinata.cloud/ipfs/${token.imageCid}`);
    for (const url of [token.imageUrlFallback, token.imageUrl]) {
        if (url && !url.includes("jsdelivr") && !urls.includes(url)) urls.push(url);
    }
    for (const url of urls) {
        for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
            try {
                const res = await fetch(url);
                if (res.ok) {
                    const buf = Buffer.from(await res.arrayBuffer());
                    if (buf.length > 0) return buf;
                }
                if (res.status === 429 && attempt < RETRIES) {
                    await sleep(3000 * (attempt + 1));
                    continue;
                }
                break;
            } catch {
                if (attempt < RETRIES) await sleep(1500 * (attempt + 1));
            }
        }
    }
    return null;
}

async function main() {
    fs.mkdirSync(OUT, { recursive: true });
    const tokens = await allTokens();
    const have = new Set(
        fs.readdirSync(OUT).filter((f) => f.endsWith(".webp")).map((f) => path.basename(f, ".webp"))
    );
    const missing = tokens
        .filter((t) => t.tokenId && !have.has(t.tokenId))
        .filter((t) => t.imageCid || t.imageUrlFallback || t.imageUrl)
        .slice(0, MAX_PER_RUN);

    console.log(`${tokens.length} tokens, ${have.size} mirrored, ${missing.length} to fetch`);

    let built = 0, failed = 0;
    const queue = [...missing];
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
        while (queue.length > 0) {
            const token = queue.shift();
            try {
                const raw = await fetchImage(token);
                if (!raw) { failed += 1; continue; }
                const out = await sharp(raw)
                    .resize(SIZE, SIZE, { fit: "cover", position: "centre" })
                    .webp({ quality: 80 })
                    .toBuffer();
                fs.writeFileSync(path.join(OUT, `${token.tokenId}.webp`), out);
                built += 1;
            } catch {
                failed += 1;
            }
            await sleep(PAUSE_MS);
        }
    }));

    // Rewritten every run: the API reads this to decide whether a token gets a
    // CDN URL, so a stale list would point at files that are not there.
    const mirrored = fs.readdirSync(OUT)
        .filter((f) => f.endsWith(".webp"))
        .map((f) => path.basename(f, ".webp"))
        .sort();
    fs.writeFileSync(MANIFEST, JSON.stringify({
        updatedAt: new Date().toISOString(),
        count: mirrored.length,
        tokens: mirrored,
    }, null, 0));

    console.log(`built ${built}, failed ${failed}, manifest ${mirrored.length}`);
}

await main();
