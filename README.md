# deployr-token-images

Token artwork for every coin launched through [Deployr](https://x.com/PrintrDeployr),
served over a CDN so a page of them loads at once.

## Why this exists

The original artwork lived on `cdn.printr.money`, which stopped resolving when
PrintrFi shut down — its nameservers now return no A record. Every image was
copied to IPFS before that happened, and IPFS remains the durable record.

IPFS is not fast enough to render a grid from. A CID nobody has requested is a
504 after 28 seconds on `ipfs.io`, and Pinata — the only gateway holding these,
since that is where pump.fun pins — answers reliably but takes 3-7 seconds every
time, cached or not.

So the images are copied here and served through jsDelivr's CDN. IPFS stays the
fallback: if this repository disappears the artwork is not lost.

## Layout

    tokens/<tokenId>.webp

256×256 WebP, quality 80, around 8KB each. The token id is the same one the
Deployr API returns, so no lookup is needed.

## Use

    https://cdn.jsdelivr.net/gh/Genvv77/deployr-token-images@main/tokens/<tokenId>.webp

The API returns this as `imageUrlThumb`, with `imageUrlFallback` pointing at
IPFS for anything not yet mirrored here.

## Regenerating

From the Deployr repository:

    node scripts/build-token-image-set.mjs --out=<path>/tokens

It only builds images that are missing, so it is safe to re-run after a batch of
launches.
