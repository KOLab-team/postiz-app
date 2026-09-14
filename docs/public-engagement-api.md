# Public post analytics and audience comments

The public API now exposes account analytics and Threads post engagement. All routes below use the existing raw Postiz API key in the `Authorization` header. They are mounted under `/api/public/v1` on the deployed site.

| Method | Route                                      | Purpose                                                                                                                      |
| ------ | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/analytics/:integrationId?date=30`        | Account analytics for providers implementing `analytics`; date is days back, 1–365 (default 30), subject to platform limits. |
| GET    | `/analytics/post/:postId`                  | Threads lifetime views, likes, replies, reposts, quotes, and shares.                                                         |
| GET    | `/posts/:postId/comments?limit=50&after=…` | One page of top-level and nested audience replies.                                                                           |
| POST   | `/posts/:postId/comments`                  | Publish a text reply: `{ "text": "Thanks!", "replyToCommentId": "optional-native-reply-id" }`.                               |
| PUT    | `/posts/:postId/comments/:commentId/hide`  | Hide/unhide a top-level audience reply: `{ "hide": true }` or `{ "hide": false }`.                                           |
| DELETE | `/posts/:postId/comments/:commentId`       | Delete a reply written by the connected Threads account.                                                                     |

By default, `postId` is a Postiz database ID. The API resolves its published `releaseId` and channel using the API key's organization. Drafts and unpublished posts are rejected.

To work with a native Threads post ID, including posts created outside Postiz, supply `?integrationId=<Postiz-channel-id>` on any post route. In that mode `postId` must be the numeric Threads ID. The channel must belong to the authenticated organization, and Graph must confirm that the post belongs to that channel's Threads account. Comment IDs are always native Threads reply IDs; comment mutations verify their relationship to the requested post.

Post insights return `{ postId, period: "lifetime", data: [...] }`, preserving the Graph metric objects, including their names and values. The legacy `date` query parameter is accepted for post insights but has no effect on lifetime metrics. Account analytics return Postiz's existing `{ label, data }` chart series, omitting the hard-coded `percentageChange` placeholders present in some legacy providers.

Reply listing returns `{ data: [...], paging: { hasNext, after? } }`. Pass `paging.after` to retrieve the next page when `hasNext` is true. `limit` is 1–100. Replies retain `root_post`, `replied_to`, `is_reply_owned_by_me`, and `hide_status` where Graph supplies them. GET requests never hide or delete replies. Graph pagination URLs are not exposed because they can contain access tokens.

Replies are text-only (1–500 characters) and publish immediately. A successful reply returns `{ id, postId, repliedTo }`, where `id` is the published native reply ID. Container processing is polled a bounded number of times. Publishing is not retried automatically on transient or ambiguous failures; check the conversation before retrying a failed write.

Only top-level replies can be hidden/unhidden. Threads only permits deleting replies owned by the authenticated account; audience replies must be hidden instead. These routes manage social-platform replies, separate from the existing internal Postiz review-comment routes.

## Permissions and rollout

Threads authentication now requests `threads_read_replies` and `threads_delete` in addition to the existing basic, publishing, insights, and reply-management scopes. Existing connected accounts may need to reconnect and grant the new scopes. App permissions must also be available in the Meta app. Expired tokens are refreshed once through Postiz's existing refresh service; missing permissions return an explicit error.

Audience-comment management and native-ID targeting currently support Threads. Existing Postiz-ID analytics support for other providers on main is preserved. Unsupported operations return HTTP 501; no empty success is fabricated. Account analytics remain available for providers that implement that capability. Invalid input returns 400; missing posts/channels 404; wrong ownership or permissions 403; invalid credentials 401; Graph rate limits 429; other upstream failures 502/504.

Deploy the Postiz backend changes before deploying the corresponding orchestrator MCP changes. No schema migration is required. Iris exposes `postiz_getIntegrationAnalytics`, `postiz_getPostAnalytics`, `postiz_listComments`, `postiz_replyToPost`, `postiz_setCommentHidden`, and `postiz_deleteComment`. Only the three read tools are eligible for read-only batching.

## Validation

Run `pnpm exec jest --config jest.engagement.config.cjs --runInBand`. The suite checks real HTTP routing, public-key authentication, request validation, organization/ownership checks, token refresh, pagination, text publishing, and comment moderation using mocked Graph responses; it does not publish to live accounts.

Implementation references: `KOLab-Threads-Backend/src/application/services/threads.service.ts` (`getThreadsPostInsights`, `getThreadsReplies`, `toggleHideThreadsReply`, publishing, and deletion). API contracts were checked against Meta's [post insights](https://www.postman.com/meta/threads/request/434u2bd/get-post-insights), [conversation](https://www.postman.com/meta/threads/request/34203612-13ebe336-0176-4d2b-b208-c36646093139), [reply visibility](https://www.postman.com/meta/threads/request/34203612-b819fb2c-8315-461f-8f30-365f7a32d1b1), and [deletion](https://www.postman.com/meta/threads/request/34203612-0a51cfc6-6407-4aec-974f-5bcbfbbf9da3) documentation.

## Production compatibility

Production currently runs the older `kolab-prod` runtime, while `main` includes the Temporal migration. The engagement feature is also backported to `kolab-prod` for deployment without upgrading the runtime or database schema. Main retains its existing analytics and OAuth support. A future deployment of the full main runtime requires a separate migration plan.
