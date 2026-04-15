const express = require("express");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || "8080");
const PROXY_API_KEY = (process.env.PROXY_API_KEY || "").trim();
const PROXY_BEARER_TOKEN = (process.env.PROXY_BEARER_TOKEN || "").trim();
const APIFY_TOKEN = (process.env.APIFY_TOKEN || "").trim();
const APIFY_RUN_SYNC_URL = (process.env.APIFY_RUN_SYNC_URL || "").trim();
const APIFY_TASK_ID = (process.env.APIFY_TASK_ID || "").trim();
const APIFY_ACTOR_ID = (process.env.APIFY_ACTOR_ID || "").trim();
const APIFY_BASE_URL = (process.env.APIFY_BASE_URL || "https://api.apify.com/v2").trim().replace(/\/$/, "");
const APIFY_PROVIDER_NAME = (process.env.APIFY_PROVIDER_NAME || "apify_proxy").trim();
const APIFY_TIMEOUT_MS = Number(process.env.APIFY_TIMEOUT_MS || "120000");
const APIFY_MAX_ITEMS = Number(process.env.APIFY_MAX_ITEMS || "200");
const APIFY_PUBLIC_SOURCE_URL = (process.env.APIFY_PUBLIC_SOURCE_URL || "").trim();

function parseJsonEnv(name, fallback = {}) {
  const raw = (process.env[name] || "").trim();
  if (!raw) return fallback;

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch (error) {
    console.warn(`${name} is not valid JSON, ignoring it.`);
  }

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

function toYmd(value) {
  const iso = toIso(value);
  return iso ? iso.slice(0, 10) : null;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function ensureAuth(req, res, next) {
  if (!PROXY_API_KEY && !PROXY_BEARER_TOKEN) {
    return next();
  }

  const providedApiKey = String(req.headers["x-api-key"] || "").trim();
  const authorization = String(req.headers.authorization || "").trim();
  const providedBearer = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : "";

  const apiKeyOk = PROXY_API_KEY && providedApiKey && providedApiKey === PROXY_API_KEY;
  const bearerOk = PROXY_BEARER_TOKEN && providedBearer && providedBearer === PROXY_BEARER_TOKEN;

  if (apiKeyOk || bearerOk) {
    return next();
  }

  return json(res, 401, {
    ok: false,
    message: "Missing or invalid proxy auth",
  });
}

function buildApifyRunUrl() {
  if (APIFY_RUN_SYNC_URL) {
    return new URL(APIFY_RUN_SYNC_URL);
  }

  if (APIFY_TASK_ID) {
    return new URL(`${APIFY_BASE_URL}/actor-tasks/${APIFY_TASK_ID}/run-sync-get-dataset-items`);
  }

  if (APIFY_ACTOR_ID) {
    return new URL(`${APIFY_BASE_URL}/acts/${APIFY_ACTOR_ID}/run-sync-get-dataset-items`);
  }

  return null;
}

function appendApifyToken(url) {
  const next = new URL(url.toString());
  if (APIFY_TOKEN) {
    next.searchParams.set("token", APIFY_TOKEN);
  }
  return next;
}

function buildSearchTerms({ handle, eventType, measurementStartAt, measurementEndAt }) {
  if (!handle || eventType !== "POST_COUNT") {
    return [];
  }

  const parts = [`from:${handle}`];
  const since = toYmd(measurementStartAt);
  const until = toYmd(measurementEndAt);

  if (since) parts.push(`since:${since}`);
  if (until) parts.push(`until:${until}`);

  return [parts.join(" ")];
}

function buildApifyInput(body) {
  const handle = normalizeHandle(body.handle);
  const measurementStartAt = toIso(body.measurementStartAt);
  const measurementEndAt = toIso(body.measurementEndAt);
  const eventType = String(body.eventType || "").trim();
  const postId = body.postId ? String(body.postId).trim() : null;
  const userId = body.userId ? String(body.userId).trim() : null;
  const startUrl = handle && postId ? `https://x.com/${handle}/status/${postId}` : null;

  return {
    ...APIFY_STATIC_INPUT_JSON,
    handle,
    username: handle,
    screenName: handle,
    userName: handle,
    twitterHandles: handle ? [handle] : [],
    author: handle || null,
    startUrls: startUrl ? [startUrl] : [],
    searchTerms: buildSearchTerms({ handle, eventType, measurementStartAt, measurementEndAt }),
    userId,
    postId,
    tweetId: postId,
    targetPostId: postId,
    eventType,
    measurementStartAt,
    measurementEndAt,
    startDate: measurementStartAt,
    endDate: measurementEndAt,
    start: measurementStartAt,
    end: measurementEndAt,
    since: toYmd(measurementStartAt),
    until: toYmd(measurementEndAt),
    maxItems: APIFY_MAX_ITEMS,
    limit: APIFY_MAX_ITEMS,
    includeReplies: true,
    includeRetweets: true,
    includeQuotes: true,
    proxyRequest: {
      handle,
      userId,
      postId,
      eventType,
      measurementStartAt,
      measurementEndAt,
    },
  };
}

function getValue(item, paths) {
  for (const path of paths) {
    const parts = path.split(".");
    let current = item;

    for (const part of parts) {
      if (!current || typeof current !== "object" || !(part in current)) {
        current = undefined;
        break;
      }
      current = current[part];
    }

    if (current !== undefined && current !== null && current !== "") {
      return current;
    }
  }

  return null;
}

function guessType(item) {
  const explicit = String(
    getValue(item, [
      "type",
      "tweetType",
      "kind",
      "recordType",
      "__typename",
    ]) || ""
  )
    .trim()
    .toLowerCase();

  if (explicit.includes("retweet") || explicit === "retweets") return "retweet";
  if (explicit.includes("repl")) return "reply";
  if (explicit.includes("quote")) return "quote";

  if (Boolean(getValue(item, ["isRetweet", "retweeted", "retweetedTweet", "retweetedStatus"]))) {
    return "retweet";
  }

  if (Boolean(getValue(item, ["isQuote", "quotedTweet", "quotedStatus"]))) {
    return "quote";
  }

  if (
    Boolean(
      getValue(item, [
        "isReply",
        "inReplyToStatusId",
        "inReplyToStatusIdStr",
        "inReplyToTweetId",
        "inReplyToTweetIdStr",
        "inReplyToId",
        "referencedTweetId",
        "conversationId",
      ])
    )
  ) {
    return "reply";
  }

  return "post";
}

function normalizeActivity(item) {
  const tweetId = String(
    getValue(item, [
      "tweetId",
      "id",
      "id_str",
      "rest_id",
      "tweet_id",
    ]) || ""
  ).trim();

  const createdAt = toDate(
    getValue(item, [
      "createdAt",
      "created_at",
      "timestamp",
      "timeParsed",
      "date",
      "publishedAt",
    ])
  );

  if (!tweetId || !createdAt) {
    return null;
  }

  const authorHandle = normalizeHandle(
    getValue(item, [
      "author.userName",
      "author.username",
      "author.screen_name",
      "user.userName",
      "user.username",
      "user.screen_name",
      "handle",
      "username",
      "screenName",
    ])
  );

  const referencedTweetId = String(
    getValue(item, [
      "referencedTweetId",
      "retweetedTweet.id",
      "retweetedStatus.id",
      "retweeted_status_id_str",
      "inReplyToStatusId",
      "inReplyToStatusIdStr",
      "inReplyToTweetId",
      "inReplyToTweetIdStr",
      "inReplyToId",
      "quotedTweet.id",
    ]) || ""
  ).trim() || null;

  const conversationId = String(
    getValue(item, [
      "conversationId",
      "conversation_id",
      "threadId",
      "inReplyToConversationId",
    ]) || ""
  ).trim() || null;

  return {
    tweetId,
    createdAt,
    type: guessType(item),
    text:
      getValue(item, ["text", "full_text", "fullText", "content", "noteText"]) || null,
    conversationId,
    referencedTweetId,
    authorHandle: authorHandle || null,
    aggregateReplyCount: Number(getValue(item, ["replyCount", "reply_count"]) || 0),
    aggregateRetweetCount: Number(getValue(item, ["retweetCount", "retweet_count"]) || 0),
    rawPayloadJson: item,
  };
}

function extractRawItems(raw) {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.items)) return raw.items;
  if (Array.isArray(raw?.data?.items)) return raw.data.items;
  if (Array.isArray(raw?.tweets)) return raw.tweets;
  if (Array.isArray(raw?.activities)) return raw.activities;
  if (Array.isArray(raw?.results)) return raw.results;
  return [];
}

function matchesWindow(activity, startAt, endAt) {
  const time = activity.createdAt.getTime();
  if (startAt && time < startAt.getTime()) return false;
  if (endAt && time > endAt.getTime()) return false;
  return true;
}

function matchesHandle(activity, requestedHandle) {
  if (!requestedHandle) return true;
  if (!activity.authorHandle) return true;
  return activity.authorHandle === requestedHandle;
}

function includesPostId(activity, postId) {
  if (!postId) return true;
  const haystacks = [
    activity.referencedTweetId,
    activity.conversationId,
    activity.text,
    JSON.stringify(activity.rawPayloadJson || {}),
  ]
    .filter(Boolean)
    .map((value) => String(value));

  return haystacks.some((value) => value.includes(postId));
}

function filterActivities(allActivities, input) {
  const requestedHandle = normalizeHandle(input.handle);
  const eventType = String(input.eventType || "").trim();
  const postId = input.postId ? String(input.postId).trim() : null;
  const startAt = toDate(input.measurementStartAt);
  const endAt = toDate(input.measurementEndAt);

  return allActivities.filter((activity) => {
    if (!matchesWindow(activity, startAt, endAt)) return false;
    if (!matchesHandle(activity, requestedHandle)) return false;

    if (eventType === "POST_COUNT") {
      return activity.type === "post" || activity.type === "quote";
    }

    if (eventType === "REPLY_COUNT") {
      if (activity.type !== "reply") return false;
      return includesPostId(activity, postId);
    }

    if (eventType === "RETWEET_COUNT") {
      if (activity.type !== "retweet") return false;
      return includesPostId(activity, postId);
    }

    return includesPostId(activity, postId);
  });
}

function summarizeMetrics(activities) {
  const postCount = activities.filter((item) => item.type === "post" || item.type === "quote").length;
  const replyCount = activities.filter((item) => item.type === "reply").length;
  const retweetCount = activities.filter((item) => item.type === "retweet").length;

  return {
    postCount,
    replyCount,
    retweetCount,
  };
}

function getAggregateObservedValue(normalizedActivities, input) {
  const eventType = String(input.eventType || "").trim();
  const postId = input.postId ? String(input.postId).trim() : null;
  if (!postId) return null;

  const matchingTweet = normalizedActivities.find((item) => item.tweetId === postId);
  if (!matchingTweet) return null;

  if (eventType === "REPLY_COUNT" && Number.isFinite(matchingTweet.aggregateReplyCount)) {
    return {
      observedValue: matchingTweet.aggregateReplyCount,
      mode: "tweet_aggregate_reply_count",
    };
  }

  if (eventType === "RETWEET_COUNT" && Number.isFinite(matchingTweet.aggregateRetweetCount)) {
    return {
      observedValue: matchingTweet.aggregateRetweetCount,
      mode: "tweet_aggregate_retweet_count",
    };
  }

  return null;
}

app.get("/health", (_req, res) => {
  const runUrl = buildApifyRunUrl();

  json(res, 200, {
    ok: true,
    service: "twitter-apify-railway-proxy",
    authConfigured: Boolean(PROXY_API_KEY || PROXY_BEARER_TOKEN),
    apifyConfigured: Boolean((APIFY_TOKEN || APIFY_RUN_SYNC_URL.includes("token=")) && runUrl),
    runUrlConfigured: Boolean(runUrl),
    provider: APIFY_PROVIDER_NAME,
  });
});

app.post("/fetch", ensureAuth, async (req, res) => {
  const { handle, eventType, postId } = req.body || {};
  const normalizedHandle = normalizeHandle(handle);
  const normalizedEventType = String(eventType || "").trim();

  if (!normalizedHandle) {
    return json(res, 400, { ok: false, message: "handle is required" });
  }

  if (!["POST_COUNT", "REPLY_COUNT", "RETWEET_COUNT"].includes(normalizedEventType)) {
    return json(res, 400, {
      ok: false,
      message: "eventType must be one of POST_COUNT, REPLY_COUNT, RETWEET_COUNT",
    });
  }

  if (["REPLY_COUNT", "RETWEET_COUNT"].includes(normalizedEventType) && !String(postId || "").trim()) {
    return json(res, 400, {
      ok: false,
      message: "postId is required for REPLY_COUNT and RETWEET_COUNT",
    });
  }

  const runUrl = buildApifyRunUrl();
  if (!runUrl) {
    return json(res, 500, {
      ok: false,
      message: "Apify run URL is not configured. Set APIFY_RUN_SYNC_URL, APIFY_TASK_ID, or APIFY_ACTOR_ID.",
    });
  }

  if (!APIFY_TOKEN && !runUrl.searchParams.get("token")) {
    return json(res, 500, {
      ok: false,
      message: "Apify token is not configured. Set APIFY_TOKEN or include token in APIFY_RUN_SYNC_URL.",
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), APIFY_TIMEOUT_MS);
  const requestedAt = new Date();
  const input = buildApifyInput(req.body || {});
  const targetUrl = appendApifyToken(runUrl);

  try {
    const response = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
      signal: controller.signal,
    });

    const raw = await response.json().catch(() => null);
    const rawItems = extractRawItems(raw);
    const normalizedActivities = rawItems.map(normalizeActivity).filter(Boolean);
    const filteredActivities = filterActivities(normalizedActivities, req.body || {});
    const metrics = summarizeMetrics(filteredActivities);
    const aggregateObserved = getAggregateObservedValue(normalizedActivities, req.body || {});

    const observedValue =
      normalizedEventType === "POST_COUNT"
        ? metrics.postCount
        : aggregateObserved?.observedValue ??
          (normalizedEventType === "REPLY_COUNT" ? metrics.replyCount : metrics.retweetCount);

    return json(res, response.ok ? 200 : 502, {
      ok: response.ok,
      source: APIFY_PROVIDER_NAME,
      sourceUrl: APIFY_PUBLIC_SOURCE_URL || null,
      fetchedAt: requestedAt.toISOString(),
      targetHandle: normalizedHandle,
      targetUserId: req.body?.userId ? String(req.body.userId).trim() : null,
      targetPostId: req.body?.postId ? String(req.body.postId).trim() : null,
      eventType: normalizedEventType,
      metrics: {
        ...metrics,
        observedValue,
      },
      coverageStart: toIso(req.body?.measurementStartAt),
      coverageEnd: toIso(req.body?.measurementEndAt),
      isComplete: response.ok,
      activities: filteredActivities.map((activity) => ({
        tweetId: activity.tweetId,
        createdAt: activity.createdAt.toISOString(),
        type: activity.type,
        text: activity.text,
        conversationId: activity.conversationId,
        referencedTweetId: activity.referencedTweetId,
      })),
      notes: response.ok
        ? `Normalized ${filteredActivities.length} matching activities from ${rawItems.length} Apify dataset items.${aggregateObserved ? ` Used ${aggregateObserved.mode}.` : ""}`
        : raw?.message || "Apify returned a non-success response",
      rawPayloadJson: {
        apifyStatus: response.status,
        apifyOk: response.ok,
        requestedInput: input,
        rawItemCount: rawItems.length,
        normalizedCount: normalizedActivities.length,
        aggregateObservedMode: aggregateObserved?.mode || null,
        firstRawItemPreview: rawItems[0] || null,
      },
    });
  } catch (error) {
    return json(res, 502, {
      ok: false,
      source: APIFY_PROVIDER_NAME,
      sourceUrl: APIFY_PUBLIC_SOURCE_URL || null,
      fetchedAt: requestedAt.toISOString(),
      targetHandle: normalizedHandle,
      targetUserId: req.body?.userId ? String(req.body.userId).trim() : null,
      targetPostId: req.body?.postId ? String(req.body.postId).trim() : null,
      eventType: normalizedEventType,
      metrics: {
        observedValue: null,
      },
      coverageStart: toIso(req.body?.measurementStartAt),
      coverageEnd: toIso(req.body?.measurementEndAt),
      isComplete: false,
      activities: [],
      notes: error?.message || "Apify request failed",
      rawPayloadJson: {
        error: error?.message || "Apify request failed",
      },
    });
  } finally {
    clearTimeout(timeout);
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  return json(res, 500, {
    ok: false,
    message: err?.message || "Unexpected proxy error",
  });
});

app.listen(PORT, () => {
  console.log(`twitter-apify-railway-proxy listening on :${PORT}`);
});
