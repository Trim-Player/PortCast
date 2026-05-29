# Deploying the PortCast export server

Target: the Lightsail web box (same machine that runs the TrimBrain
backend). The PortCast server lives at `import.portcast.org`, listens
on `127.0.0.1:8765`, and is fronted by the same nginx that already
serves `api.trimplayer.com`.

Connection shorthand (set up in `~/.ssh/config` on the maintainer's
machine): `ssh web` → `ubuntu@100.27.163.194`.

## Prerequisites you handle out-of-band

1. **DNS.** Add an `A` record for `import.portcast.org` pointing at
   `100.27.163.194` (the box's stable public IP). Wait for it to
   resolve before running certbot.

2. **Spotify dashboard.** On the PortCast Spotify app, add
   `https://import.portcast.org/spotify/callback` to the list of
   "Redirect URIs". Spotify rejects callbacks that don't exactly
   match an entry on this list, so OAuth will fail until this is
   done.

## One-time setup on the box

Everything below runs over `ssh web`. The commands are designed so
re-running them is safe (idempotent where possible).

```bash
ssh web
sudo -i

# 1) Service user and deploy dir.
id -u portcast >/dev/null 2>&1 || useradd --system --home /opt/portcast-server --shell /usr/sbin/nologin portcast
install -d -o portcast -g portcast /opt/portcast-server

# 2) Clone the repo (read-only public clone is fine).
sudo -u portcast git clone https://github.com/Trim-Player/PortCast.git /opt/portcast-server
# Or, if updating later:  sudo -u portcast git -C /opt/portcast-server pull

# 3) Python venv + install. Ubuntu 22.04 ships Python 3.10, which
#    matches portcast's >=3.10 requirement.
sudo -u portcast python3 -m venv /opt/portcast-server/venv
sudo -u portcast /opt/portcast-server/venv/bin/pip install --upgrade pip
sudo -u portcast /opt/portcast-server/venv/bin/pip install -e /opt/portcast-server/reference
sudo -u portcast /opt/portcast-server/venv/bin/pip install -e /opt/portcast-server/server

# 4) Environment file. Copy the template, fill in real values,
#    then lock it down to the service user.
cp /opt/portcast-server/server/deploy/portcast-server.env.example /etc/portcast-server.env
$EDITOR /etc/portcast-server.env
# Generate SESSION_SECRET if you didn't already:
#   python3 -c "import secrets; print(secrets.token_urlsafe(48))"
chown portcast:portcast /etc/portcast-server.env
chmod 600 /etc/portcast-server.env

# 5) systemd unit.
install -m 644 /opt/portcast-server/server/deploy/portcast-server.service /etc/systemd/system/portcast-server.service
systemctl daemon-reload
systemctl enable --now portcast-server.service
systemctl status portcast-server.service --no-pager

# Smoke-test the local port before exposing it.
curl -sS http://127.0.0.1:8765/healthz

# 6) nginx site.
install -m 644 /opt/portcast-server/server/deploy/import.portcast.org.nginx.conf /etc/nginx/sites-available/import.portcast.org
ln -sf /etc/nginx/sites-available/import.portcast.org /etc/nginx/sites-enabled/import.portcast.org
nginx -t && systemctl reload nginx

# 7) TLS. Certbot adds the listen-443 block and the HTTP->HTTPS
#    redirect server in-place, matching how trimbrain is configured.
certbot --nginx -d import.portcast.org

# 8) Final end-to-end check.
curl -sS https://import.portcast.org/healthz
```

## Updating

```bash
ssh web sudo -u portcast git -C /opt/portcast-server pull
ssh web sudo -u portcast /opt/portcast-server/venv/bin/pip install -e /opt/portcast-server/server -e /opt/portcast-server/reference
ssh web sudo systemctl restart portcast-server.service
```

## Logs

```bash
ssh web sudo journalctl -u portcast-server.service -n 200 --no-pager
ssh web sudo journalctl -u portcast-server.service -f
```

## Why these choices

- **Dedicated `portcast` system user.** Mirrors the `trimbrain` user
  pattern already on the box. Keeps the Spotify client secret and
  the session-signing key in `/etc/portcast-server.env` readable only
  by the service, even if another service is compromised.
- **Port 8765 on loopback only.** Port 8000 is held by trimbrain.
  Loopback-only means nginx is the only thing that can reach the
  app, so we don't have to worry about the box's firewall rules
  drifting.
- **certbot --nginx, not Cloudflare-style edge TLS.** Same model as
  trimbrain — keeps the OAuth callback URL stable and avoids the
  Cloudflare-proxy gotchas around Set-Cookie + SameSite.
- **No DB, no persistent state.** The systemd unit is intentionally
  minimal (no MemoryMax, no orphan-killer ExecStartPre). Those were
  workarounds specific to trimbrain's analysis pipeline; PortCast is
  a thin OAuth-then-fetch-then-return service that does not warrant
  them.
