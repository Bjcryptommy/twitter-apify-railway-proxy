const express = require("express");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || "8080");
const PROXY_API_KEY = (process.env.PROXY_API_KEY || "").trim();
const PROXY_BEARER_TOKEN = (process.env.PROXY_BEARER_TOKEN || "").trim();

// Apify config
const APIFY_TOKEN = (process.env.APIFY_TOKEN || "").trim();
const APIFY_RUN_SYNC_URL = (process.env.APIFY_RUN_SYNC_URL || "").trim();
const APIFY_TASK_ID = (process.env.APIFY_TASK_ID || "").trim();
const APIFY_ACTOR_ID = (process.env.APIFY_ACTOR_ID || "").trim();
const APIFY_BASE_URL = (process.env.APIFY_BASE_URL || "https://api.apify.com/v2").trim().replace(/\/$/, "");
const APIFY_TIMEOUT_MS = Number(process.env.APIFY_TIMEOUT_MS || "120000");
const APIFY_MAX_ITEMS = Number(process.env.APIFY_MAX_ITEMS || "200");

// Twitter API v2 config
const TWITTER_API_BEARER_TOKEN = (process.env.TWITTER_API_BEARER_TOKEN || "").trim();
const TWITTER_API_KEY = (process.env.TWITTER_API_KEY || "").trim();
const TWITTER_API_SECRET = (process.env.TWITTER_API_SECRET || "").trim();
const TWITTER_API_TIMEOUT_MS = Number(process.env.TWITTER_API_TIMEOUT_MS || "30000");

function parseJsonEnv(name, fallback = {}) {
  const raw = (process.env[name] || "").trim();
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {}
  return fallback;
}

const APIFY_STATIC_INPUT_JSON = parseJsonEnv("APIFY_STATIC_INPUT_JSON", {});

function json(res, status, payload) {
  res.status(status).json(payload);
}

function normalizeHandle(handle) {
  return String(handle || "").trim().replace(/^@+/, "").toLowerCase();
}

function toDate(value) {
  if (!value) return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function toIso(value) {
  const date = value instanceof Date ? value : toDate(value);
  return date ? date.toISOString() : null;
}

function ensureAuth(req, res, next) {
  if (!PROXY_API_KEY && !PROXY_BEARER_TOKEN) return next();
  const providedApiKey = String(req.headers["x-api-key"] || "").trim();
  const authorization = String(req.headers.authorization || "").trim();
  const providedBearer = authorization.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() : "";
  if ((PROXY_API_KEY && providedApiKey === PROXY_API_KEY) || (PROXY_BEARER_TOKEN && providedBearer === PROXY_BEARER_TOKEN)) {
    return next();
  }
  return json(res, 401, { ok: false, message: "Missing or invalid proxy auth" });
}

// ==================== Apify Provider ====================

function buildApifyRunUrl() {
  if (APIFY_RUN_SYNC_URL) return new URL(APIFY_RUN_SYNC_URL);
  if (APIFY_TASK_ID) return new URL(`${APIFY_BASE_URL}/actor-tasks/${APIFY_TASK_ID}/run-sync-get-dataset-items`);
  if (APIFY_ACTOR_ID) return new URL(`${APIFY_BASE_URL}/acts/${APIFY_ACTOR_ID}/run-sync-get-dataset-items`);
  return null;
}

function appendApifyToken(url) {
  const next = new URL(url.toString());
  if (APIFY_TOKEN) next.searchParams.set("token", APIFY_TOKEN);
  return next;
}

function buildApifyInput(body) {
  const handle = normalizeHandle(body.handle);
  const startUrl = handle && body.postId ? `https://x.com/${handle}/status/${body.postId}` : null;
  return {
    ...APIFY_STATIC_INPUT_JSON,
    handle,
    username: handle,
    twitterHandles: handle ? [handle] : [],
    author: handle || null,
    startUrls: startUrl ? [startUrl] : [],
    userId: body.userId || null,
    postId: body.postId || null,
    tweetId: body.postId || null,
    targetPostId: body.postId || null,
    eventType: body.eventType,
    measurementStartAt: toIso(body.measurementStartAt),
    measurementEndAt: toIso(body.measurementEndAt),
    since: body.measurementStartAt ? body.measurementStartAt.slice(0, 10) : null,
    until: body.measurementEndAt ? body.measurementEndAt.slice(0, 10) : null,
    maxItems: APIFY_MAX_ITEMS,
    includeReplies: true,
    includeRetweets: true,
    includeQuotes: true,
  };
}

async function fetchFromApify(input) {
  const runUrl = buildApifyRunUrl();
  if (!runUrl) throw new Error("Apify not configured");
  
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), APIFY_TIMEOUT_MS);
  
  try {
    const targetUrl = appendApifyToken(runUrl);
    const response = await fetch(targetUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildApifyInput(input)),
      signal: controller.signal,
    });
    const raw = await response.json().catch(() => null);
    return { ok: response.ok, source: "apify", raw };
  } finally {
    clearTimeout(timeout);
  }
}

// ==================== Twitter API v2 Provider ====================

async function fetchTweetMetrics(tweetId) {
  const url = `https://api.twitter.com/2/tweets/${tweetId}?tweet.fields=public_metrics,created_at,author_id`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${TWITTER_API_BEARER_TOKEN}` },
  });
  if (!response.ok) throw new Error(`Twitter API error: ${response.status}`);
  return response.json();
}

async function fetchUserTweets(userId, startTime, endTime) {
  const params = new URLSearchParams({
    "tweet.fields": "public_metrics,created_at,referenced_tweets",
    "max_results": "100",
  });
  if (startTime) params.set("start_time", startTime);
  if (endTime) params.set("end_time", endTime);
  
  const url = `https://api.twitter.com/2/users/${userId}/tweets?${params}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${TWITTER_API_BEARER_TOKEN}` },
  });
  if (!response.ok) throw new Error(`Twitter API error: ${response.status}`);
  return response.json();
}

async function fetchFromTwitterAPI(input) {
  if (!TWITTER_API_BEARER_TOKEN) throw new Error("Twitter API not configured");
  
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TWITTER_API_TIMEOUT_MS);
  
  try {
    let result = {
      ok: true,
      source: "twitter_api_v2",
      metrics: { postCount: 0, replyCount: 0, retweetCount: 0, observedValue: 0 },
      activities: [],
    };
    
    if (input.postId) {
      // Get specific tweet metrics
      const tweetData = await fetchTweetMetrics(input.postId);
      if (tweetData.data) {
        const metrics = tweetData.data.public_metrics || {};
        result.metrics = {
          postCount: 1,
          replyCount: metrics.reply_count || 0,
          retweetCount: metrics.retweet_count || 0,
          likeCount: metrics.like_count || 0,
          quoteCount: metrics.quote_count || 0,
          observedValue: input.eventType === "REPLY_COUNT" ? (metrics.reply_count || 0) : 
                        input.eventType === "RETWEET_COUNT" ? (metrics.retweet_count || 0) : 1,
        };
        result.activities = [{
          tweetId: tweetData.data.id,
          createdAt: tweetData.data.created_at,
          type: "post",
          text: tweetData.data.text,
        }];
      }
    } else if (input.handle) {
      // Would need to lookup user ID first - simplified for now
      result.metrics.observedValue = 0;
      result.notes = "Twitter API: handle lookup not implemented in this version";
    }
    
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

// ==================== Provider Router ====================

async function fetchMetrics(input, provider) {
  if (provider === "twitter_api_v2") {
    return fetchFromTwitterAPI(input);
  }
  // Default to Apify
  return fetchFromApify(input);
}

// ==================== Routes ====================

app.get("/health", (_req, res) => {
  const apifyConfigured = Boolean(buildApifyRunUrl());
  const twitterConfigured = Boolean(TWITTER_API_BEARER_TOKEN);
  
  json(res, 200, {
    ok: true,
    service: "twitter-proxy-v2",
    authConfigured: Boolean(PROXY_API_KEY || PROXY_BEARER_TOKEN),
    providers: {
      apify: { configured: apifyConfigured },
      twitter_api_v2: { configured: twitterConfigured },
    },
  });
});

app.post("/fetch", ensureAuth, async (req, res) => {
  const { handle, eventType, postId, provider } = req.body || {};
  const normalizedHandle = normalizeHandle(handle);
  
  if (!normalizedHandle) {
    return json(res, 400, { ok: false, message: "handle is required" });
  }
  
  if (!["POST_COUNT", "REPLY_COUNT", "RETWEET_COUNT"].includes(eventType)) {
    return json(res, 400, { ok: false, message: "invalid eventType" });
  }
  
  const selectedProvider = provider || "apify";
  const requestedAt = new Date();
  
  try {
    const result = await fetchMetrics({
      handle: normalizedHandle,
      userId: req.body.userId,
      postId: postId || null,
      eventType,
      measurementStartAt: req.body.measurementStartAt,
      measurementEndAt: req.body.measurementEndAt,
    }, selectedProvider);
    
    return json(res, 200, {
      ok: result.ok,
      source: result.source || selectedProvider,
      fetchedAt: requestedAt.toISOString(),
      targetHandle: normalizedHandle,
      targetPostId: postId || null,
      eventType,
      metrics: result.metrics || { observedValue: null },
      coverageStart: toIso(req.body.measurementStartAt),
      coverageEnd: toIso(req.body.measurementEndAt),
      isComplete: result.ok,
      activities: result.activities || [],
      notes: result.notes || null,
    });
  } catch (error) {
    return json(res, 502, {
      ok: false,
      source: selectedProvider,
      fetchedAt: requestedAt.toISOString(),
      targetHandle: normalizedHandle,
      targetPostId: postId || null,
      eventType,
      metrics: { observedValue: null },
      isComplete: false,
      activities: [],
      notes: error.message || "Provider request failed",
    });
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  json(res, 500, { ok: false, message: err?.message || "Unexpected error" });
});

app.listen(PORT, () => {
  console.log(`Twitter proxy v2 listening on :${PORT}`);
  console.log(`Providers: Apify=${Boolean(buildApifyRunUrl())}, Twitter API=${Boolean(TWITTER_API_BEARER_TOKEN)}`);
});
