# Twitter Apify Railway Proxy

A small Railway-deployable proxy for the prediction-market backend.

It accepts the backend's Twitter fetch request shape at `POST /fetch`, calls an Apify actor/task, normalizes tweet-like dataset items, and returns the response shape expected by `twitter-fetcher.service.ts`.

## What this solves

Your backend wants these env vars:

```env
TWITTER_SCRAPER_URL=https://your-proxy.up.railway.app/fetch
TWITTER_SCRAPER_API_KEY=your-secret-key
TWITTER_SCRAPER_PROVIDER=apify_proxy
TWITTER_SCRAPER_TIMEOUT_MS=20000
```

This proxy gives you the `TWITTER_SCRAPER_URL`.

You set `TWITTER_SCRAPER_API_KEY` yourself as the same secret you use in Railway as `PROXY_API_KEY`.

## Endpoints

- `GET /health`
- `POST /fetch`

## Incoming request shape

```json
{
  "handle": "elonmusk",
  "userId": null,
  "postId": "1912300000000000000",
  "eventType": "RETWEET_COUNT",
  "measurementStartAt": "2026-04-15T00:00:00.000Z",
  "measurementEndAt": "2026-04-15T06:00:00.000Z"
}
```

## Railway deploy steps

1. Push this folder to a repo, or deploy it directly from the folder in Railway.
2. In Railway, create a new service from this folder.
3. Set the env vars from `.env.example`.
4. Copy the Railway URL and append `/fetch`.
5. Use that URL in your prediction-market backend as `TWITTER_SCRAPER_URL`.

## Recommended env on Railway

```env
PORT=8080
PROXY_API_KEY=generate-a-random-secret
APIFY_TOKEN=your-apify-token
APIFY_RUN_SYNC_URL=https://api.apify.com/v2/actor-tasks/<TASK_ID>/run-sync-get-dataset-items
APIFY_PROVIDER_NAME=apify_proxy
APIFY_TIMEOUT_MS=120000
APIFY_MAX_ITEMS=200
APIFY_STATIC_INPUT_JSON={}
```

### Important notes

- `PROXY_API_KEY` is your own secret. Generate it yourself.
- `APIFY_TOKEN` comes from your Apify account.
- `APIFY_RUN_SYNC_URL` should be the full Apify sync dataset-items endpoint for the actor/task you want to run.
- If you prefer, you can set `APIFY_TASK_ID` or `APIFY_ACTOR_ID` instead of `APIFY_RUN_SYNC_URL`.

## Prediction-market backend wiring

Set these in your backend env:

```env
TWITTER_SCRAPER_URL=https://your-proxy.up.railway.app/fetch
TWITTER_SCRAPER_API_KEY=same-value-as-PROXY_API_KEY
TWITTER_SCRAPER_PROVIDER=apify_proxy
TWITTER_SCRAPER_TIMEOUT_MS=20000
```

## How to get the values

### `TWITTER_SCRAPER_URL`
This is your Railway deployment URL plus `/fetch`.

Example:

```env
TWITTER_SCRAPER_URL=https://twitter-apify-proxy-production.up.railway.app/fetch
```

### `TWITTER_SCRAPER_API_KEY`
This is not issued by Twitter or Apify. You generate it yourself.

Example:

```bash
openssl rand -hex 32
```

Put the same value in:
- Railway: `PROXY_API_KEY`
- prediction-market backend: `TWITTER_SCRAPER_API_KEY`

### `TWITTER_SCRAPER_PROVIDER`
Just a label. Recommended:

```env
TWITTER_SCRAPER_PROVIDER=apify_proxy
```

### `TWITTER_SCRAPER_TIMEOUT_MS`
A timeout you choose. Start with:

```env
TWITTER_SCRAPER_TIMEOUT_MS=20000
```

## Apify setup

You need an Apify actor or task that returns tweet-like dataset items.

The proxy is tolerant and can normalize common fields like:
- `id`, `tweetId`, `rest_id`
- `createdAt`, `created_at`, `timestamp`
- `text`, `fullText`, `full_text`
- `author.username`, `user.screen_name`
- reply / retweet / quote markers

The easiest flow is usually:

1. create or choose an Apify actor/task that fetches Twitter/X activity
2. make sure it returns dataset items with tweet ids and timestamps
3. paste its `run-sync-get-dataset-items` URL into `APIFY_RUN_SYNC_URL`
4. set `APIFY_TOKEN`
5. deploy to Railway

## Local run

```bash
npm install
npm start
```

Health check:

```bash
curl http://localhost:8080/health
```

Example fetch:

```bash
curl -X POST http://localhost:8080/fetch \
  -H 'content-type: application/json' \
  -H 'x-api-key: your-secret-key' \
  -d '{
    "handle": "elonmusk",
    "postId": "1912300000000000000",
    "eventType": "RETWEET_COUNT",
    "measurementStartAt": "2026-04-15T00:00:00.000Z",
    "measurementEndAt": "2026-04-15T06:00:00.000Z"
  }'
```

## Actor fit notes

This proxy now sends several common Apify-friendly fields automatically, including:
- `twitterHandles`
- `author`
- `startUrls` for `https://x.com/<handle>/status/<postId>`
- `searchTerms` for simple `POST_COUNT` cases

It also falls back to aggregate tweet metrics like `replyCount` and `retweetCount` when an actor returns a tweet object instead of separate reply/retweet activity items.

### About `apidojo/tweet-scraper`

It can be made to work for some cases because its output includes fields like:
- `id`
- `createdAt`
- `author.userName`
- `replyCount`
- `retweetCount`
- `isReply`
- `isRetweet`

But it is **not the ideal actor** for market auto-resolution on specific tweet replies/retweets because its own docs say:
- no conversation/reply scraping
- single tweet / low-count use cases are better on `Twitter Scraper Unlimited`
- minimum result expectations can make small resolution windows awkward

Practical recommendation:
- `POST_COUNT` markets: likely okay
- specific tweet `REPLY_COUNT` / `RETWEET_COUNT` markets: prefer `Twitter Scraper Unlimited` or another actor built for tweet URL + replies/engagement use cases

## Caveat

Apify actors differ a lot in their input and output shapes.

This proxy already normalizes many common tweet item shapes, but the exact actor you pick may still need a small tweak in `APIFY_STATIC_INPUT_JSON`, or a tiny code adjustment if its dataset is unusual.

That is normal. The point of this proxy is to keep those provider-specific quirks out of your main backend.
