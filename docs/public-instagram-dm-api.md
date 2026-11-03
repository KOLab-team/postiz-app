# Read Instagram DMs through Postiz

The public API exposes read-only Instagram Direct Message endpoints for a connected
Instagram professional account. Both Postiz connection types are supported:

| Postiz provider | Meta login | Required messaging permission |
| --- | --- | --- |
| `instagram-standalone` | Instagram Login | `instagram_business_manage_messages` |
| `instagram` | Facebook Business Login | `instagram_manage_messages`, `pages_manage_metadata` |

Postiz requests these messaging scopes during every new Instagram account
connection. Existing connections keep their current grants until they are
**reconnected in Postiz**. Reconnect an existing account to grant DM access.
Meta may require Advanced Access and app review to read conversations with
people outside the app's roles. The connected account must be an Instagram
professional account.
Because the messaging scopes are requested for every new Instagram connection,
check that the Meta app can request them before deploying this change.

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
available attachment metadata. Conversation IDs are opaque path-safe strings,
including Meta IDs prefixed with `t_`. Neither endpoint sends or changes DMs.
A failed DM token refresh returns an authorization error without disconnecting
the publishing channel.

## Signed-in Postiz inbox

The **Inbox** menu opens `/instagram-dms`. Members of the selected Postiz
organization can choose a connected Instagram account, read its conversations,
page through messages, and send text replies. The browser uses the normal
Postiz session; it never receives a Meta token or public API key. Replies go
through the authenticated Postiz endpoint
`POST /api/instagram-dms/{integrationId}/conversations/{conversationId}/replies`.
Postiz verifies that the conversation belongs to the connected account and
derives the sole recipient from its participants before sending. The public
API and Iris DM tools remain read-only.

Meta permits replies only to eligible conversations started by an Instagram
user. If a send times out or Meta does not confirm it, check the conversation
before retrying to avoid a duplicate reply.

Meta does not return inactive Requests-folder conversations after 30 days, and
the conversation API can expose only a limited recent message history. For
ongoing full history, a later webhook ingestion service would be needed.
