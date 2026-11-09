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

    if (url.pathname === "/ws") {
      return this.handleWebSocket(request);
    }

    if (request.method === "GET" && url.pathname === "/state") {
      const room = await this.state.storage.get("room");
      return Response.json(room || {
        status: "empty",
        players: []
      });
    }

    if (request.method === "POST" && url.pathname === "/join") {
      const body = await request.json().catch(() => ({}));
      const name = String(body.name || "ผู้เล่น")
        .trim().slice(0, 20) || "ผู้เล่น";

      const room = await this.state.storage.get("room");

      if (!room) {
        return Response.json(
          { error: "ไม่พบห้องนี้" },
          { status: 404 }
        );
      }

      const playerId = body.playerId || crypto.randomUUID();

      if (
        room.players.length >= 2 &&
        !room.players.some(p => p.id === playerId)
      ) {
        return Response.json(
          { error: "ห้องเต็มแล้ว" },
          { status: 409 }
        );
      }

      if (!room.players.some(p => p.id === playerId)) {
        room.players.push({
          id: playerId,
          name,
          joinedAt: Date.now()
        });
      }

      room.status = room.players.length === 2
        ? "ready"
        : "waiting";

      await this.state.storage.put("room", room);
      this.broadcast({ type: "state", room });

      return Response.json({ playerId, room });
    }

    if (request.method === "POST" && url.pathname === "/leave") {
      const body = await request.json().catch(() => ({}));
      const room = await this.state.storage.get("room");

      if (room) {
        room.players = room.players.filter(
          p => p.id !== body.playerId
        );

        room.status = room.players.length === 2
          ? "ready"
          : "waiting";

        await this.state.storage.put("room", room);
        this.broadcast({ type: "state", room });
      }

      return Response.json({ ok: true });
    }

    return new Response("Not found", { status: 404 });
  }

  async handleWebSocket(request) {
    if (
      request.headers.get("Upgrade")?.toLowerCase()
      !== "websocket"
    ) {
      return new Response(
        "Expected WebSocket upgrade",
        { status: 426 }
      );
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    server.accept();
    this.sockets.add(server);

    const remove = () => this.sockets.delete(server);

    server.addEventListener("close", remove);
    server.addEventListener("error", remove);

    server.addEventListener("message", event => {
      this.handleSocketMessage(server, event.data);
    });

    const room = await this.state.storage.get("room");

    if (room) {
      server.send(JSON.stringify({
        type: "state",
        room
      }));
    } else {
      server.send(JSON.stringify({
        type: "error",
        message: "ไม่พบห้องนี้"
      }));
    }

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  async handleSocketMessage(socket, raw) {
    try {
      const messageText = typeof raw === "string"
        ? raw
        : new TextDecoder().decode(raw);

      if (messageText.length > 2048) return;

      const data = JSON.parse(messageText);
      const room = await this.state.storage.get("room");

      if (!room) return;

      const playerId = String(data.playerId || "");

      if (!room.players.some(p => p.id === playerId)) {
        socket.send(JSON.stringify({
          type: "error",
          message: "ไม่พบผู้เล่นในห้อง"
        }));
        return;
      }

      // รับคำสั่งปุ่มควบคุม
      if (data.type === "input") {
        const button = String(data.button || "").toLowerCase();
        const action = String(data.action || "");

        if (
          !/^[a-z0-9_]{1,24}$/.test(button) ||
          !["down", "up"].includes(action)
        ) {
          return;
        }

        this.broadcast({
          type: "input",
          playerId,
          button,
          action,
          sentAt: Date.now()
        });

        return;
      }

      // รับตำแหน่งผู้เล่น
      if (data.type === "position") {
        const x = Number(data.x);
        const y = Number(data.y);

        if (
          !Number.isFinite(x) ||
          !Number.isFinite(y) ||
          x < 0 || x > 100 ||
          y < 0 || y > 100
        ) {
          return;
        }

        this.broadcast({
          type: "position",
          playerId,
          x,
          y,
          direction: data.direction || "right"
        });

        return;
      }

    } catch (error) {
      try {
        socket.send(JSON.stringify({
          type: "error",
          message: "ข้อมูลไม่ถูกต้อง"
        }));
      } catch (_) {}
    }
  }

  broadcast(data) {
    const message = JSON.stringify(data);

    for (const ws of this.sockets) {
      try {
        ws.send(message);
      } catch (_) {
        this.sockets.delete(ws);
      }
    }
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8"
    }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: corsHeaders(request)
      });
    }

    if (url.pathname === "/health") {
      return withCors(
        json({
          ok: true,
          service: "BR2 online rooms"
        }),
        request
      );
    }

    if (
      request.method === "POST" &&
      url.pathname === "/create"
    ) {
      const body = await request.json().catch(() => ({}));

      const name = String(body.name || "ผู้เล่น 1")
        .trim().slice(0, 20) || "ผู้เล่น 1";

      const code = randomCode();

      const id = env.ROOMS.idFromName(code);
      const stub = env.ROOMS.get(id);

      const room = {
        code,
        status: "waiting",
        players: [{
          id: crypto.randomUUID(),
          name,
          joinedAt: Date.now()
        }],
        createdAt: Date.now()
      };

      await stub.fetch("https://room.internal/init", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(room)
      });

      const stored = await stub.fetch(
        "https://room.internal/state"
      );

      return withCors(
        json({ room: await stored.json() }),
        request
      );
    }

    const match = url.pathname.match(
      /^\/room\/([A-Z0-9]{6})(\/.*)?$/
    );

    if (match) {
      const id = env.ROOMS.idFromName(match[1]);
      const stub = env.ROOMS.get(id);
      const subpath = match[2] || "/state";

      const response = await stub.fetch(
        "https://room.internal" + subpath,
        request
      );

      if (response.status === 101 || response.webSocket) {
        return response;
      }

      return withCors(response, request);
    }

    return withCors(
      json({ error: "Not found" }, 404),
      request
    );
  }
};

function randomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));

  return Array.from(
    bytes,
    b => chars[b % chars.length]
  ).join("");
}

function corsHeaders(request) {
  return {
    "access-control-allow-origin":
      request.headers.get("Origin") || "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "Content-Type",
    "access-control-max-age": "86400",
    "vary": "Origin"
  };
}

function withCors(response, request) {
  const headers = new Headers(response.headers);

  for (const [key, value] of Object.entries(
    corsHeaders(request)
  )) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}