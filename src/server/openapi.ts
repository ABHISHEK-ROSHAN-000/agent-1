export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Agent-1 API",
    version: "0.1.0",
    description: "Local personal assistant daemon. Phase 1: auth, sessions, and events.",
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
        summary: "Create a one-time pairing link",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        responses: { "200": { description: "Pairing URL and expiry" } },
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
    "/v1/workspaces": {
      get: {
        summary: "List workspace grants",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        responses: { "200": { description: "Workspaces" } },
      },
      post: {
        summary: "Grant a folder for read or write",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        responses: { "201": { description: "Workspace created" } },
      },
    },
    "/v1/workspaces/{id}": {
      delete: {
        summary: "Remove a workspace grant",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Workspace removed" } },
      },
    },
    "/v1/journal": {
      get: {
        summary: "List journaled operations",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        responses: { "200": { description: "Journal entries" } },
      },
    },
    "/v1/journal/{id}": {
      get: {
        summary: "Get a journal entry",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Journal entry" } },
      },
    },
    "/v1/journal/undo": {
      post: {
        summary: "Undo a journal batch",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        responses: { "200": { description: "Undo result" } },
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
    "/v1/model-profiles": {
      get: {
        summary: "List model profiles",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        responses: { "200": { description: "Model profiles" } },
      },
      post: {
        summary: "Create a cloud or local model profile",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        responses: { "201": { description: "Profile created" }, "400": { description: "Invalid profile" } },
      },
    },
    "/v1/model-profiles/{id}": {
      patch: {
        summary: "Update a model profile",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Profile updated" } },
      },
      delete: {
        summary: "Remove a model profile",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Profile removed" } },
      },
    },
    "/v1/model-profiles/{id}/test": {
      post: {
        summary: "Probe a model profile for text and tool calling",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Probe result" } },
      },
    },
    "/v1/model-profiles/{id}/default": {
      post: {
        summary: "Set the default model profile",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Default updated" } },
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
    },
    "/v1/sessions/{id}/messages": {
      get: {
        summary: "List session messages",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Messages" } },
      },
      post: {
        summary: "Send a user message and start a turn",
        security: [{ basicAuth: [] }, { sessionCookie: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "202": { description: "Turn started" } },
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
