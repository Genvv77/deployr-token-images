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

/**
 * Gateways to try for a CID, fastest first. Measured Nov 2026: filebase holds
 * these in ~0.4s, 4everland in 1-3s, Pinata in 3-7s. ipfs.io, dweb.link and
 * nftstorage.link now answer 403 to automated requests, which is why tokens
 * whose only source was an ipfs.io URL were never mirrored.
 */
const GATEWAYS = [
    "https://ipfs.filebase.io/ipfs/",
    "https://4everland.io/ipfs/",
    "https://gateway.pinata.cloud/ipfs/",
];
const CID_RE = /(?:ipfs:\/\/|\/ipfs\/)(bafy[a-z0-9]{20,}|bafk[a-z0-9]{20,}|Qm[1-9A-HJ-NP-Za-km-z]{44})/i;

/** The CID a token's image lives at, from imageCid or any IPFS-shaped URL. */
function cidOf(token) {
    if (token.imageCid) return token.imageCid;
    for (const url of [token.imageUrl, token.imageUrlFallback]) {
        const match = url && CID_RE.exec(url);
        if (match) return match[1];
    }
    return null;
}

async function fetchImage(token) {
    const urls = [];
    const cid = cidOf(token);
    if (cid) for (const gw of GATEWAYS) urls.push(`${gw}${cid}`);
    for (const url of [token.imageUrlFallback, token.imageUrl]) {
        if (url && !url.includes("jsdelivr") && !CID_RE.test(url) && !urls.includes(url)) urls.push(url);
    }
    for (const url of urls) {
        for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
            try {
                // A gateway that hangs must not stall the whole run.
                const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
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
