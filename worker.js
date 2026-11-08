export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sockets = new Set();
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/init") {
      const room = await request.json();
      await this.state.storage.put("room", room);
      this.broadcast({ type: "state", room });
      return Response.json({ ok: true });
    }

    if (url.pathname === "/ws" || url.pathname.endsWith("/ws")) {
      return this.handleWebSocket(request);
    }

    if (request.method === "GET" && (url.pathname === "/state" || url.pathname.endsWith("/state"))) {
      const room = await this.state.storage.get("room");
      return Response.json(room || { status: "empty", players: [] });
    }

    if (request.method === "POST" && (url.pathname === "/join" || url.pathname.endsWith("/join"))) {
      const body = await request.json().catch(() => ({}));
      const name = String(body.name || "ผู้เล่น").trim().slice(0, 20) || "ผู้เล่น";
      const room = await this.state.storage.get("room");

      if (!room) {
        return Response.json({ error: "ไม่พบห้องนี้" }, { status: 404 });
      }

      const playerId = body.playerId || crypto.randomUUID();

      if (room.players.length >= 2 && !room.players.some(p => p.id === playerId)) {
        return Response.json({ error: "ห้องเต็มแล้ว" }, { status: 409 });
      }

      if (!room.players.some(p => p.id === playerId)) {
        room.players.push({ id: playerId, name, joinedAt: Date.now() });
      }

      room.status = room.players.length === 2 ? "ready" : "waiting";
      await this.state.storage.put("room", room);
      this.broadcast({ type: "state", room });
      return Response.json({ playerId, room });
    }

    if (request.method === "POST" && (url.pathname === "/leave" || url.pathname.endsWith("/leave"))) {
      const body = await request.json().catch(() => ({}));
      const room = await this.state.storage.get("room");

      if (room) {
        room.players = room.players.filter(p => p.id !== body.playerId);
        room.status = room.players.length === 2 ? "ready" : "waiting";
        await this.state.storage.put("room", room);
        this.broadcast({ type: "state", room });
      }

      return Response.json({ ok: true });
    }

    return new Response("Not found", { status: 404 });
  }

  async handleWebSocket(request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    server.accept();
    this.sockets.add(server);

    const remove = () => this.sockets.delete(server);
    server.addEventListener("close", remove);
    server.addEventListener("error", remove);

    const room = await this.state.storage.get("room");
    if (room) {
      server.send(JSON.stringify({ type: "state", room }));
    } else {
      server.send(JSON.stringify({ type: "error", message: "ไม่พบห้องนี้" }));
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  broadcast(data) {
    const message = JSON.stringify(data);

    for (const ws of this.sockets) {
      try {
        ws.send(message);
      } catch {
        this.sockets.delete(ws);
      }
    }
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(request) });
    }

    if (url.pathname === "/health") {
      return withCors(json({ ok: true, service: "BR2 online rooms" }), request);
    }

    if (request.method === "POST" && url.pathname === "/create") {
      const body = await request.json().catch(() => ({}));
      const name = String(body.name || "ผู้เล่น 1").trim().slice(0, 20) || "ผู้เล่น 1";
      const code = randomCode();
      const id = env.ROOMS.idFromName(code);
      const stub = env.ROOMS.get(id);

      const room = {
        code,
        status: "waiting",
        players: [{ id: crypto.randomUUID(), name, joinedAt: Date.now() }],
        createdAt: Date.now()
      };

      await stub.fetch("https://room.internal/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(room)
      });

      return withCors(await (async () => {
        const stored = await stub.fetch("https://room.internal/state");
        return json({ room: await stored.json() });
      })(), request);
    }

    const match = url.pathname.match(/^\/room\/([A-Z0-9]{6})(\/.*)?$/);
    if (match) {
      const id = env.ROOMS.idFromName(match[1]);
      const stub = env.ROOMS.get(id);
      const subpath = match[2] || "/state";
      const response = await stub.fetch(request);

      // A WebSocket upgrade response (101) must pass through unchanged.
      // Wrapping it in a new Response breaks the WebSocket handshake.
      if (response.status === 101 || response.webSocket) {
        return response;
      }

      return withCors(response, request);
    }

    return withCors(json({ error: "Not found" }, 404), request);
  }
};

function randomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, b => chars[b % chars.length]).join("");
}

function corsHeaders(request) {
  return {
    "access-control-allow-origin": request.headers.get("Origin") || "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "Content-Type",
    "access-control-max-age": "86400",
    "vary": "Origin"
  };
}

function withCors(response, request) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(request))) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}