// apps/x-intern/src/lib/x-graphql-ids.ts
//
// Pinned operation hashes for x.com/i/api/graphql. X rotates these on UI
// updates (roughly every few months). When a worker starts seeing 404s from
// graphql, edit this file with fresh hashes captured from the web client's
// network tab.
//
// ⚠️  PLACEHOLDER VALUES — The operator must replace these with real queryIds
//     captured from a logged-in x.com session before the discovery + send
//     workers will function in production. See plan Task 14 and spec § 9.1.
//
// How to capture:
//   1. Open https://x.com in Chrome, sign in.
//   2. Open DevTools → Network → filter "graphql".
//   3. Trigger each operation (visit a profile = UserTweets, search = SearchTimeline, etc).
//   4. The request URL is /i/api/graphql/<queryId>/<operationName>. Copy the queryId.

export const X_GRAPHQL = {
  // POST /i/api/graphql/<id>/CreateTweet
  CreateTweet: {
    queryId: "I8YfL7lWvgEHwGYqkqv6Rg",
    operationName: "CreateTweet",
  },
  // GET /i/api/graphql/<id>/UserTweets?variables=...&features=...
  UserTweets: {
    queryId: "ePGdb_KW7tCpYBKwYx1IiQ",
    operationName: "UserTweets",
  },
  // GET /i/api/graphql/<id>/SearchTimeline?variables=...&features=...
  SearchTimeline: {
    queryId: "Aj1nGkAL1S7n9R8z2gxh4Q",
    operationName: "SearchTimeline",
  },
  // GET /i/api/graphql/<id>/UserByScreenName?variables=...&features=...
  UserByScreenName: {
    queryId: "1VOOyvKkiI3FMmkeDNxM9A",
    operationName: "UserByScreenName",
  },
} as const;

// Feature flag blob X requires alongside every graphql call. Captured from
// the web client; copy verbatim when rotating.
export const X_FEATURES = {
  rweb_lists_timeline_redesign_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  tweetypie_unmention_optimization_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: false,
  tweet_awards_web_tipjar_consumer_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_media_download_video_enabled: false,
  responsive_web_enhance_cards_enabled: false,
} as const;
