# Read Instagram DMs through Postiz

The public API exposes read-only Instagram Direct Message endpoints for a connected
Instagram professional account. Both Postiz connection types are supported:

| Postiz provider | Meta login | Required messaging permission |
| --- | --- | --- |
| `instagram-standalone` | Instagram Login | `instagram_business_manage_messages` |
| `instagram` | Facebook Business Login | `instagram_manage_messages`, `pages_manage_metadata` |

Postiz requests these scopes during account connection. An account connected before
this change must be **reconnected in Postiz** to grant the new scopes. Meta may
require Advanced Access and app review to read conversations with people outside
the app's roles. The connected account must be an Instagram professional account.

Use the existing Postiz public API key as the raw `Authorization` header. The key's
organization must own the integration. Tokens stay in Postiz and are never
returned by the endpoints.

For multiple Iris instances, connect each account in the matching Postiz
organization and give that Iris instance only that organization's public API
key. Integration IDs from another organization return 404.

```http
GET /api/public/v1/integrations/{integrationId}/instagram-dms/conversations?limit=20&after={cursor}
GET /api/public/v1/integrations/{integrationId}/instagram-dms/conversations/{conversationId}/messages?limit=20&after={cursor}
Authorization: {postiz-api-key}
```

Both endpoints return `{ integrationId, data, paging: { after } }`; the messages
endpoint also returns `conversationId`. Pass a non-null `paging.after` into the
next call. Limits are 1–20. The message endpoint checks that the conversation
contains the connected Instagram account. Message records include text and
available attachment metadata. Neither endpoint sends or changes DMs.

Meta does not return inactive Requests-folder conversations after 30 days, and
the conversation API can expose only a limited recent message history. For
ongoing full history, a later webhook ingestion service would be needed.
