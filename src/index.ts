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
  const allowed = origin && origin === allowedOrigin ? origin : allowedOrigin;

  return {
    "access-control-allow-origin": allowed,
    "access-control-allow-headers": "Authorization, Content-Type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

function withCors(response: Response, request: Request, env: Env): Response {
  const headers = new Headers(response.headers);
  const origin = request.headers.get("origin");

  for (const [key, value] of Object.entries(cors(origin, env.ALLOWED_ORIGIN))) {
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

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: cors(origin, env.ALLOWED_ORIGIN),
      });
    }

    if (origin && origin !== env.ALLOWED_ORIGIN) {
      return new Response(JSON.stringify({
        ok: false,
        message: "Origin not allowed.",
      }), {
        status: 403,
        headers: {
          "content-type": "application/json",
          ...cors(origin, env.ALLOWED_ORIGIN),
        },
      });
    }

    if (url.pathname === "/api/health") {
      return new Response(JSON.stringify({
        ok: true,
        version: "1.2.0",
        service: "night-chamber-worker",
        durableObjects: true,
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          ...cors(origin, env.ALLOWED_ORIGIN),
        },
      });
    }

    let auth: any = null;

    if (url.pathname.startsWith("/api/")) {
      const result = await requireAuth(
        request,
        env.FIREBASE_PROJECT_ID
      );

      if (result instanceof Response) {
        return withCors(result, request, env);
      }

      auth = result;
    }

    try {
      const lobbyId = env.LOBBY.idFromName("global");
      const lobby = env.LOBBY.get(lobbyId);

      if (request.method === "POST" && url.pathname === "/api/rooms") {
        const body = await request.json().catch(() => ({}));

        const response = await lobby.fetch(
          new Request("https://lobby/create", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              ...body,
              uid: auth.uid,
            }),
          })
        );

        return withCors(response, request, env);
      }

      if (request.method === "GET" && url.pathname === "/api/rooms/public") {
        const response = await lobby.fetch(
          new Request("https://lobby/public")
        );

        return withCors(response, request, env);
      }

      const roomInfo = url.pathname.match(
        /^\/api\/rooms\/([A-Z0-9]{6})$/
      );

      if (request.method === "GET" && roomInfo) {
        const roomCode = roomInfo[1];

        const response = await lobby.fetch(
          new Request(`https://lobby/room/${roomCode}`)
        );

        return withCors(response, request, env);
      }

      const joinMatch = url.pathname.match(
        /^\/api\/rooms\/([A-Z0-9]{6})\/join$/
      );

      if (request.method === "POST" && joinMatch) {
        const roomCode = joinMatch[1];

        const roomResponse = await lobby.fetch(
          new Request(`https://lobby/room/${roomCode}`)
        );

        if (!roomResponse.ok) {
          return withCors(roomResponse, request, env);
        }

        const data = await roomResponse.json() as any;

        if (!data.room) {
          return withCors(new Response(JSON.stringify({
            ok: false,
            message: "Room data unavailable.",
          }), {
            status: 500,
            headers: { "content-type": "application/json" },
          }), request, env);
        }

        const room = data.room;

        if (room.status === "finished") {
          return withCors(new Response(JSON.stringify({
            ok: false,
            message: "Match finished.",
          }), {
            status: 409,
            headers: { "content-type": "application/json" },
          }), request, env);
        }

        if (room.players >= room.maxPlayers) {
          return withCors(new Response(JSON.stringify({
            ok: false,
            message: "Room is full.",
          }), {
            status: 409,
            headers: { "content-type": "application/json" },
          }), request, env);
        }

        const joinResponse = await lobby.fetch(
          new Request(`https://lobby/room/${roomCode}/join`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ uid: auth.uid }),
          })
        );

        return withCors(joinResponse, request, env);
      }

      const websocketMatch = url.pathname.match(
        /^\/ws\/([A-Z0-9]{6})$/
      );

      if (websocketMatch) {
        if (request.headers.get("Upgrade") !== "websocket") {
          return new Response("WebSocket upgrade required", {
            status: 426,
          });
        }

        const roomCode = websocketMatch[1];

        const roomResponse = await lobby.fetch(
          new Request(`https://lobby/room/${roomCode}`)
        );

        if (!roomResponse.ok) {
          return roomResponse;
        }

        const data = await roomResponse.json() as any;

        if (!data.room) {
          return new Response("Room unavailable", { status: 404 });
        }

        if (data.room.players >= data.room.maxPlayers) {
          return new Response("Room full", { status: 409 });
        }

        const gameRoomId = env.GAME_ROOM.idFromName(data.room.id);
        const gameRoom = env.GAME_ROOM.get(gameRoomId);
        const forwardedRequest = new Request(request);

        forwardedRequest.headers.set("x-room-code", roomCode);
        forwardedRequest.headers.set("x-user-id", auth.uid);

        return gameRoom.fetch(forwardedRequest);
      }

      return withCors(new Response(JSON.stringify({
        ok: false,
        message: "Not found.",
      }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }), request, env);

    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : "Internal server error.";

      return withCors(new Response(JSON.stringify({
        ok: false,
        message,
      }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }), request, env);
    }
  },
};
