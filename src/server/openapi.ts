export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Agent-1 API",
    version: "0.1.0",
    description: "Local personal assistant daemon. Phase 8A: auth, sessions, tools, checkpoints, web client, remote access, and memory.",
  },
  servers: [{ url: "http://127.0.0.1:{port}", variables: { port: { default: "0" } } }],
  components: {
    securitySchemes: {
      basicAuth: { type: "http", scheme: "basic" },
      sessionCookie: { type: "apiKey", in: "cookie", name: "agent1_session" },
    },
  },
  paths: {
    "/v1/health": {
      get: {
        summary: "Unauthenticated health check",
        responses: { "200": { description: "Daemon is healthy" } },
      },
    },
    "/v1/info": {
      get: {
        summary: "Authenticated daemon information",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        responses: { "200": { description: "Daemon information" }, "401": { description: "Unauthorized" } },
      },
    },
    "/v1/auth/login": {
      post: {
        summary: "Exchange the shared password for a session cookie",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["password"],
                properties: { password: { type: "string" } },
              },
            },
          },
        },
        responses: {
          "200": { description: "Session created" },
          "401": { description: "Invalid password" },
          "429": { description: "Too many attempts" },
        },
      },
    },
    "/v1/auth/logout": {
      post: {
        summary: "Delete the current session cookie",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        responses: { "200": { description: "Logged out" } },
      },
    },
    "/v1/auth/pair": {
      post: {
        summary: "Create one-time pairing code and links",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        responses: { "200": { description: "Pairing code, URLs, and expiry" } },
      },
    },
    "/auth/connect/{code}": {
      get: {
        summary: "Redeem a one-time pairing code and set a session cookie",
        parameters: [{ name: "code", in: "path", required: true, schema: { type: "string" } }],
        responses: { "303": { description: "Session created" }, "400": { description: "Invalid or expired code" } },
      },
    },
    "/v1/remote": {
      get: {
        summary: "Get remote tunnel status",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        responses: { "200": { description: "Remote status" } },
      },
    },
    "/v1/remote/accept": {
      post: {
        summary: "Persist remote-access consent",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        responses: { "200": { description: "Remote status" } },
      },
    },
    "/v1/remote/enable": {
      post: {
        summary: "Enable and start remote access",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        responses: { "200": { description: "Remote status" } },
      },
    },
    "/v1/remote/disable": {
      post: {
        summary: "Disable remote access and close the tunnel",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        responses: { "200": { description: "Remote status" } },
      },
    },
    "/v1/auth/rotate": {
      post: {
        summary: "Rotate the shared password and sign out all sessions",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        responses: { "200": { description: "New password returned once" } },
      },
    },
    "/v1/tools": {
      get: {
        summary: "List available tools and risk classes",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        responses: { "200": { description: "Tools" } },
      },
    },
    "/v1/memory": {
      get: {
        summary: "Read USER and MEMORY stores, pending changes, and history",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        responses: { "200": { description: "Memory state" } },
      },
      patch: {
        summary: "Apply foreground memory operations",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        responses: { "200": { description: "Memory mutation" }, "400": { description: "Invalid memory operation" } },
      },
    },
    "/v1/memory/pending": {
      get: {
        summary: "List pending background memory changes",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        responses: { "200": { description: "Pending memory changes" } },
      },
    },
    "/v1/memory/pending/{id}/decision": {
      post: {
        summary: "Approve or reject a pending memory change",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Decision applied" }, "409": { description: "Stale or already decided" } },
      },
    },
    "/v1/memory/undo": {
      post: {
        summary: "Undo a memory history entry",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        responses: { "200": { description: "Memory undo" }, "400": { description: "Nothing to undo" } },
      },
    },
    "/v1/memory/export": {
      get: {
        summary: "Export USER and MEMORY stores as Markdown",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        responses: { "200": { description: "Markdown export" } },
      },
    },
    "/v1/sessions/search": {
      get: {
        summary: "Discover, read, browse, or scroll past sessions using FTS5",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        parameters: [
          { name: "query", in: "query", schema: { type: "string" } },
          { name: "sessionId", in: "query", schema: { type: "string" } },
          { name: "aroundMessageId", in: "query", schema: { type: "string" } },
          { name: "window", in: "query", schema: { type: "integer" } },
          { name: "limit", in: "query", schema: { type: "integer" } },
          { name: "sort", in: "query", schema: { type: "string", enum: ["relevance", "newest", "oldest"] } },
          { name: "roleFilter", in: "query", schema: { type: "string" } },
        ],
        responses: { "200": { description: "Session search result" } },
      },
    },
    "/v1/settings": {
      get: {
        summary: "Read unified Agent-1 settings",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        responses: { "200": { description: "Settings" } },
      },
      patch: {
        summary: "Patch unified Agent-1 settings",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        responses: { "200": { description: "Updated settings" } },
      },
    },
    "/v1/approval-config": {
      get: {
        summary: "Read the Agent-1 approval policy",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        responses: { "200": { description: "Approval config" } },
      },
      patch: {
        summary: "Update the Agent-1 approval policy",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        responses: { "200": { description: "Approval config" } },
      },
    },
    "/v1/approval-grants": {
      get: {
        summary: "List session and permanent approval grants",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        responses: { "200": { description: "Approval grants" } },
      },
    },
    "/v1/approval-grants/{id}": {
      delete: {
        summary: "Remove an approval grant",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Approval grant removed" } },
      },
    },
    "/v1/checkpoints": {
      get: {
        summary: "List filesystem checkpoints",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        parameters: [
          { name: "limit", in: "query", required: false, schema: { type: "integer" } },
          { name: "sessionId", in: "query", required: false, schema: { type: "string" } },
        ],
        responses: { "200": { description: "Checkpoint list" } },
      },
    },
    "/v1/checkpoints/{id}": {
      get: {
        summary: "Get a filesystem checkpoint",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Checkpoint" } },
      },
    },
    "/v1/checkpoints/{id}/diff": {
      get: {
        summary: "Diff a checkpoint against the current filesystem root",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Checkpoint diff" } },
      },
    },
    "/v1/checkpoints/{id}/restore": {
      post: {
        summary: "Restore a checkpoint, optionally with safe user-edit preservation",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Restore result" } },
      },
    },
    "/v1/rules": {
      get: {
        summary: "List permission rules",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        responses: { "200": { description: "Rules" } },
      },
      post: {
        summary: "Create a permission rule",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        responses: { "201": { description: "Rule created" } },
      },
    },
    "/v1/rules/{id}": {
      patch: {
        summary: "Update a permission rule",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Rule updated" } },
      },
      delete: {
        summary: "Delete a permission rule",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Rule deleted" } },
      },
    },
    "/v1/approvals": {
      get: {
        summary: "List approvals, optionally by status",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        responses: { "200": { description: "Approvals" } },
      },
    },
    "/v1/approvals/{id}": {
      get: {
        summary: "Get an approval",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Approval" } },
      },
    },
    "/v1/approvals/{id}/decision": {
      post: {
        summary: "Approve or reject an approval",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Approval decision" }, "409": { description: "Arguments changed or already decided" } },
      },
    },
    "/v1/audit": {
      get: {
        summary: "Read the permission audit log",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        responses: { "200": { description: "Audit entries" } },
      },
    },
    "/v1/providers": {
      get: {
        summary: "List providers and credential sources",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        responses: { "200": { description: "Providers" } },
      },
      post: {
        summary: "Create a custom OpenAI-compatible provider",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        responses: { "201": { description: "Provider created" } },
      },
    },
    "/v1/providers/{id}/connect": {
      post: {
        summary: "Store a provider credential",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Provider connected" } },
      },
    },
    "/v1/providers/{id}/connect-env": {
      post: {
        summary: "Store the configured environment credential",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Provider connected" } },
      },
    },
    "/v1/providers/{id}/refresh": {
      post: {
        summary: "Refresh a provider model catalog",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Catalog refreshed" } },
      },
    },
    "/v1/providers/{id}/credentials/{credentialId}/activate": {
      post: {
        summary: "Activate a provider credential",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "credentialId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: { "200": { description: "Credential activated" } },
      },
    },
    "/v1/models": {
      get: {
        summary: "List connected provider models",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        responses: { "200": { description: "Models" } },
      },
    },
    "/v1/models/default": {
      get: {
        summary: "Get the default model",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        responses: { "200": { description: "Default model" } },
      },
      put: {
        summary: "Set the default model",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        responses: { "200": { description: "Default updated" } },
      },
    },
    "/v1/sessions/active": {
      get: {
        summary: "Hydrate active turns by session",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        responses: { "200": { description: "Active session map" } },
      },
    },
    "/v1/sessions": {
      get: {
        summary: "List sessions",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        responses: { "200": { description: "Session list" } },
      },
      post: {
        summary: "Create a session",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        responses: { "201": { description: "Session created" } },
      },
    },
    "/v1/sessions/{id}": {
      get: {
        summary: "Get a session",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Session" }, "404": { description: "Not found" } },
      },
      patch: {
        summary: "Rename a session",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Session renamed" }, "404": { description: "Not found" } },
      },
      delete: {
        summary: "Delete a session and its owned data",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Session deleted" }, "404": { description: "Not found" } },
      },
    },
    "/v1/media/{hash}": {
      get: {
        summary: "Read an attachment blob referenced by a message or inbox item",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        parameters: [{ name: "hash", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Attachment bytes" }, "404": { description: "Not found" } },
      },
    },
    "/v1/sessions/{id}/messages": {
      get: {
        summary: "List session messages",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Messages" } },
      },
      post: {
        summary: "Admit a user message as steer or queue work",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "202": { description: "Prompt admitted" }, "409": { description: "Inbox conflict" } },
      },
    },
    "/v1/sessions/{id}/inbox": {
      get: {
        summary: "List pending session inbox items",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Pending inbox items" } },
      },
    },
    "/v1/sessions/{id}/inbox/{inboxID}": {
      patch: {
        summary: "Change pending inbox delivery",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "inboxID", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: { "200": { description: "Delivery changed" }, "409": { description: "Inbox conflict" } },
      },
      delete: {
        summary: "Cancel pending inbox input",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "inboxID", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: { "200": { description: "Inbox item cancelled or already delivered" } },
      },
    },
    "/v1/sessions/{id}/interrupt": {
      post: {
        summary: "Interrupt the active session execution",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "resume", in: "query", required: false, schema: { type: "boolean" } },
        ],
        responses: { "200": { description: "Interrupt result" } },
      },
    },
    "/v1/turns/{id}": {
      get: {
        summary: "Get a turn and its messages",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Turn" } },
      },
    },
    "/v1/turns/{id}/stream": {
      get: {
        summary: "Live turn stream (deltas, tools, done)",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "text/event-stream" } },
      },
    },
    "/v1/turns/{id}/cancel": {
      post: {
        summary: "Cancel a running turn",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Cancelled turn" } },
      },
    },
    "/v1/events": {
      get: {
        summary: "Server-sent events with Last-Event-ID replay",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        responses: { "200": { description: "text/event-stream" } },
      },
    },
    "/v1/system/stop": {
      post: {
        summary: "Gracefully stop the daemon",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        responses: { "200": { description: "Stopping" } },
      },
    },
    "/v1/openapi.json": {
      get: {
        summary: "This document",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        responses: { "200": { description: "OpenAPI document" } },
      },
    },
  },
} as const
