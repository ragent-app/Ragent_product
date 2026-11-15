# Ragent Reverse Tunnel

Self-contained, zero-dependency Node tunnel that exposes a NAT'd remote
Ragent instance through a public host, using a single outbound TCP 443 TLS
connection from the remote side. The example domain below must be replaced with a domain you control.

## Architecture

```text
browser ── HTTPS 443 ──► Caddy (public host)
                            │ reverse_proxy → 127.0.0.1:17890
                            ▼
                    tunnel-server.mjs  (listens 127.0.0.1:17890, loopback only)
                            ▲
                            │ one long-lived HTTPS POST /tunnel
                            │ (frame-multiplexed, token-authenticated)
                            ▼
                    tunnel-client.mjs  (runs on the remote host, outbound only)
                            │ fixed target 127.0.0.1:7690 (Ragent)
                            ▼
                    remote Ragent
```

- The tunnel is plain TCP multiplexing, so HTTP, WebSocket (`/ws`) and large
  streaming bodies all pass through unchanged.
- The client's control connection is **HTTP/2** (ALPN over TLS 443). This is
  required when the public entry is behind a reverse proxy: Caddy's
  `reverse_proxy` does not deliver a streaming response to an HTTP/1.1 client
  until the request body is complete, which would deadlock a full-duplex POST.
  Over h2 the response frames flow while the request body stays open. The
  tunnel-server itself stays HTTP/1.1 — it only ever talks to the local proxy.
- The client never listens; it only keeps outbound connections. It reconnects
  with exponential backoff (1s → 30s) and heartbeats every 30s.
- The forward target is fixed by `--target` on the client; OPEN frames carry
  no address, so a compromised client cannot pivot to other ports.

## Files

| File | Role |
|---|---|
| `tunnel-common.mjs` | Frame protocol (8-byte header + payload), token loading, CLI parsing, logging |
| `tunnel-server.mjs` | Public entry: accepts control connections, routes browser traffic into streams |
| `tunnel-client.mjs` | Remote peer: opens the control connection, forwards each stream to the local target |

## Protocol

Frame: `[magic 1B 0xA5][type 1B][streamId 2B BE][length 4B BE][payload]`

| Type | Value | Direction | Payload |
|---|---|---|---|
| AUTH | 0x01 | client → server | shared token (first frame) |
| OPEN | 0x02 | server → client | none (open a stream) |
| DATA | 0x03 | both | stream bytes |
| CLOSE | 0x04 | both | none |
| PING / PONG | 0x05 / 0x06 | both | none |
| END | 0x07 | server → client | request body finished |
| HEAD | 0x08 | client → server | response head `{status, headers}` JSON |

The control connection is a full-duplex POST: the request body carries
client → server frames and the response body carries server → client frames.
The client speaks HTTP/2 (see note above); the tunnel-server sees the request
as HTTP/1.1 chunked from the local proxy. No `Upgrade` is needed, which keeps
Caddy configuration minimal.

Backpressure: each stream keeps an up-queue and a down-queue (16 MiB cap per
direction). `write()` returning `false` only signals the high-water mark — the
bytes are already buffered — so queues shift before writing to avoid duplicate
data, and a peer CLOSE frame drains queued frames before closing, so no tail
bytes are lost.

## Usage

**Security:** The tunnel token authenticates the tunnel peer, not visitors to the forwarded service. Do not expose an unauthenticated local Ragent interface to the public internet. Provide and verify access control at your reverse proxy before using this example.

```sh
# public host
node tunnel-server.mjs --port 17890 --target 127.0.0.1:7690 \
  --token-file /etc/ragent/tunnel-token

# remote host (outbound only)
node tunnel-client.mjs --url https://tunnel.example.com/tunnel \
  --target 127.0.0.1:7690 --token-file /etc/ragent/tunnel-token
```

Token: `openssl rand -hex 32`, file mode 0600. `--token <raw>` also works;
`--token-file` wins when both are given.

Caddy site block (no `encode` — the tunnel is binary):

```caddyfile
tunnel.example.com {
	tls { on_demand }
	reverse_proxy 127.0.0.1:17890 {
		transport http {
			read_timeout 300s
			write_timeout 300s
			dial_timeout 5s
		}
	}
}
```

## Local test recipe

```sh
node tunnel-server.mjs --port 17891 --target 127.0.0.1:7690 --token-file /tmp/tok &
node tunnel-client.mjs --url http://127.0.0.1:17891/tunnel --target 127.0.0.1:7690 --token-file /tmp/tok &
curl http://127.0.0.1:17891/healthz        # clean JSON from the tunnel server
curl http://127.0.0.1:17891/login          # request forwarded to the target
```

Validate forwarding, access control, reconnection and resource limits in your deployment before relying on this tunnel.

## systemd

Unit files live in `tunnel/systemd/`:

```sh
# public host (as root)
sudo cp tunnel/systemd/ragent-tunnel-server.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now ragent-tunnel-server

# remote host (as root, e.g. ragent)
sudo cp tunnel/systemd/ragent-tunnel-client.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now ragent-tunnel-client
```

Adjust `ExecStart` paths (`/opt/ragent/runtime/node` vs `/usr/bin/node`) to
match each host. The client never listens; it only holds one outbound
TLS 443 h2 connection.

## Notes

- Logs contain connection/auth events only — never request/response headers
  or body content (a HEAD frame logs just its status).
- Restart supervision is left to systemd (`Restart=always` on both ends).
- Optional hardening: require a client certificate at Caddy (`client_auth`)
  so a leaked token alone cannot open the tunnel.
