import { Lobby } from "./lobby";
import { GameRoom } from "./room";
import { requireAuth } from "./auth";

export { Lobby, GameRoom };

export interface Env {
  GAME_ROOM: DurableObjectNamespace<GameRoom>;
  LOBBY: DurableObjectNamespace<Lobby>;
  FIREBASE_PROJECT_ID: string;
  ALLOWED_ORIGIN: string;
}

function cors(origin: string | null, allowedOrigin: string) {
  return {
    "access-control-allow-origin":
      origin === allowedOrigin ? origin : allowedOrigin,
    "access-control-allow-headers": "Authorization, Content-Type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

function withCors(response: Response, request: Request, env: Env) {
  const headers = new Headers(response.headers);

  for (const [key, value] of Object.entries(
    cors(request.headers.get("origin"), env.ALLOWED_ORIGIN),
  )) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: cors(origin, env.ALLOWED_ORIGIN),
      });
    }

    // Origin protection
    if (origin && origin !== env.ALLOWED_ORIGIN) {
      return new Response(
        JSON.stringify({
          ok: false,
          message: "Origin not allowed.",
        }),
        {
          status: 403,
          headers: {
            "content-type": "application/json",
            ...cors(origin, env.ALLOWED_ORIGIN),
          },
        },
      );
    }

    // Health check does not require authentication
    if (url.pathname === "/api/health") {
      return Response.json({
        ok: true,
        version: "1.2.0",
        service: "night-chamber-worker",
        durableObjects: true,
      });
    }

    let auth: any = null;

    // Authenticate API requests
    if (url.pathname.startsWith("/api/")) {
      const result = await requireAuth(
        request,
        env.FIREBASE_PROJECT_ID,
      );

      if (result instanceof Response) {
        return withCors(result, request, env);
      }

      auth = result;
    }

    try {
      const lobby = env.LOBBY.get(
        env.LOBBY.idFromName("global"),
      );

      // Create room
      if (
        request.method === "POST" &&
        url.pathname === "/api/rooms"
      ) {
        const body = await request.json().catch(() => ({}));

        const response = await lobby.fetch(
          new Request("https://lobby/create", {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify({
              ...body,
              uid: auth.uid,
            }),
          }),
        );

        return withCors(response, request, env);
      }

      // Public rooms
      if (
        request.method === "GET" &&
        url.pathname === "/api/rooms/public"
      ) {
        const response = await lobby.fetch(
          new Request("https://lobby/public"),
        );

        return withCors(response, request, env);
      }

      // Get room
      const roomInfo = url.pathname.match(
        /^\/api\/rooms\/([A-Z0-9]{6})$/,
      );

      if (
        request.method === "GET" &&
        roomInfo
      ) {
        const response = await lobby.fetch(
          new Request(
            "https://lobby/room/" + roomInfo[1],
          ),
        );

        return withCors(response, request, env);
      }

      // Join room
      const joinInfo = url.pathname.match(
        /^\/api\/rooms\/([A-Z0-9]{6})\/join$/,
      );

      if (
        request.method === "POST" &&
        joinInfo
      ) {
        const response = await lobby.fetch(
          new Request(
            "https://lobby/room/" + joinInfo[1],
          ),
        );

        if (!response.ok) {
          return withCors(response, request, env);
        }

        const data = (await response.json()) as any;

        if (!data.room) {
          return withCors(
            new Response(
              JSON.stringify({
                ok: false,
                message: "Room data unavailable.",
              }),
              {
                status: 500,
                headers: {
                  "content-type": "application/json",
                },
              },
            ),
            request,
            env,
          );
        }

        if (data.room.status === "finished") {
          return withCors(
            new Response(
              JSON.stringify({
                ok: false,
                message: "Match finished.",
              }),
              {
                status: 409,
                headers: {
                  "content-type": "application/json",
                },
              },
            ),
            request,
            env,
          );
        }

        if (data.room.players >= data.room.maxPlayers) {
          return withCors(
            new Response(
              JSON.stringify({
                ok: false,
                message: "Room is full.",
              }),
              {
                status: 409,
                headers: {
                  "content-type": "application/json",
                },
              },
            ),
            request,
            env,
          );
        }

        return withCors(
          new Response(JSON.stringify(data.room), {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          }),
          request,
          env,
        );
      }

      // WebSocket game connection
      const wsInfo = url.pathname.match(
        /^\/ws\/([A-Z0-9]{6})$/,
      );

      if (wsInfo) {
        if (
          request.headers.get("Upgrade") !==
          "websocket"
        ) {
          return new Response(
            "WebSocket upgrade required",
            { status: 426 },
          );
        }

        const response = await lobby.fetch(
          new Request(
            "https://lobby/room/" + wsInfo[1],
          ),
        );

        if (!response.ok) {
          return withCors(response, request, env);
        }

        const data = (await response.json()) as any;

        if (!data.room) {
          return new Response(
            "Room unavailable",
            { status: 404 },
          );
        }

        if (
          data.room.players >=
          data.room.maxPlayers
        ) {
          return new Response(
            "Room full",
            { status: 409 },
          );
        }

        const room = env.GAME_ROOM.get(
          env.GAME_ROOM.idFromName(
            data.room.id,
          ),
        );

        const forwardedRequest = new Request(
          request,
        );

        forwardedRequest.headers.set(
          "x-room-code",
          wsInfo[1],
        );

        return room.fetch(forwardedRequest);
      }

      return new Response(
        "Night Chamber Worker 1.2.0",
      );
    } catch (error) {
      return withCors(
        new Response(
          JSON.stringify({
            ok: false,
            message:
              error instanceof Error
                ? error.message
                : "Internal server error.",
          }),
          {
            status: 500,
            headers: {
              "content-type": "application/json",
            },
          },
        ),
        request,
        env,
      );
    }
  },
};
