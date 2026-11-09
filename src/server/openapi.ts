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
