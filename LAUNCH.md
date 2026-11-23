# Launching usecodealex.com

This takes the site from the GitHub preview to its own server, with real Kick sign-in,
live status, shared admin settings and (once Vega and Rugs.fun send their details) live wagers.

Plan on about an hour the first time. Every command below is copy and paste.

---

## What you need first

| Thing | Who | Notes |
|---|---|---|
| Domain **usecodealex.com** | Alex buys | Any registrar. About $10–15 a year. |
| **Cloudflare** account (free) | Alex | Runs the domain's DNS and HTTPS. |
| **Hetzner** server | Alex buys | Cloud → *CX22*, **Ubuntu 24.04**, any EU location. About €4–5 a month. Add your SSH key when creating it. |
| **Kick developer app** | Alex (on his Kick account) | Step 4 below. Gives a Client ID and Secret. |
| **Vega API details** | From Vega | Step 6. They whitelist the server's IP. |
| **Rugs.fun data** | From Rugs.fun | If they have an API. If not, Alex pastes the list in the admin. |

---

## 1. Point the domain at Cloudflare

1. In Cloudflare: **Add a site** → `usecodealex.com` → Free plan.
2. Cloudflare shows two nameservers. Put those in the registrar where the domain was bought (replace the old ones).
3. Wait until Cloudflare says the site is **Active** (minutes to a few hours).

## 2. Create the server

1. Hetzner Cloud → **Add server** → Ubuntu 24.04 → CX22 → add your SSH key → Create.
2. Copy the server's **IPv4 address** (looks like `65.108.x.x`). This is the IP Vega whitelists.

## 3. DNS + HTTPS in Cloudflare

1. **DNS** → Add record: Type `A`, Name `@`, IPv4 = the server IP, Proxy **on** (orange cloud).
2. Add record: Type `CNAME`, Name `www`, Target `usecodealex.com`, Proxy **on**.
3. **SSL/TLS → Overview** → set mode to **Full (strict)**.
4. **SSL/TLS → Origin Server → Create Certificate** → keep the defaults → Create.
   Keep this page open; you paste the two boxes on the server in step 5.

## 4. Kick developer app

1. Signed in as **alexx** on kick.com: **Settings → Developer** → create an app.
2. **Redirect URL:** `https://usecodealex.com/auth/kick/callback` (exactly this).
3. Turn on the **user:read** scope if the form lists scopes.
4. Copy the **Client ID** and **Client Secret**. Never post the secret anywhere public.

## 5. Set up the server

Connect from your computer (Terminal on Mac, PowerShell on Windows):

```bash
ssh root@YOUR_SERVER_IP
```

Install everything:

```bash
apt update && apt -y upgrade
apt -y install git ufw debian-keyring debian-archive-keyring apt-transport-https curl
# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt -y install nodejs
# Caddy (web server in front of the site)
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
apt update && apt -y install caddy
# Firewall: SSH + web only
ufw allow 22 && ufw allow 80 && ufw allow 443 && ufw --force enable
```

Get the site:

```bash
git clone https://github.com/Redoxwork/usecodealex.git /opt/usecodealex
useradd --system --home /opt/usecodealex uca
mkdir -p /opt/usecodealex/server/data && chown -R uca:uca /opt/usecodealex/server/data
```

Settings file:

```bash
cd /opt/usecodealex/server
cp .env.example .env
openssl rand -hex 32        # copy the output for SESSION_SECRET
nano .env
```

Fill in `SESSION_SECRET`, `KICK_CLIENT_ID`, `KICK_CLIENT_SECRET`. Leave the Vega and Rugs lines empty for now.
Save with **Ctrl+O, Enter, Ctrl+X**. Then lock the file:

```bash
chown uca:uca .env && chmod 600 .env
```

Cloudflare certificate (from step 3.4):

```bash
nano /etc/caddy/cf.pem     # paste the "Origin Certificate" box, save
nano /etc/caddy/cf.key     # paste the "Private Key" box, save
chown caddy:caddy /etc/caddy/cf.* && chmod 600 /etc/caddy/cf.key
```

Caddy config:

```bash
cat > /etc/caddy/Caddyfile <<'EOF'
usecodealex.com, www.usecodealex.com {
	tls /etc/caddy/cf.pem /etc/caddy/cf.key
	encode gzip
	reverse_proxy 127.0.0.1:8080
}
EOF
systemctl reload caddy
```

Run the site as a service (starts on boot, restarts if it crashes):

```bash
cat > /etc/systemd/system/usecodealex.service <<'EOF'
[Unit]
Description=UseCodeAlex
After=network-online.target

[Service]
User=uca
WorkingDirectory=/opt/usecodealex/server
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now usecodealex
systemctl status usecodealex --no-pager
```

You should see `Kick sign-in: on`. Check it from anywhere:

```
https://usecodealex.com/api/health
```

## First start

1. Open **https://usecodealex.com/#admin** → **Sign in with Kick** as **alexx**.
2. Check **Races** (prize pools, splits, end dates) and **Site**.
3. Press **Publish** once. That saves the settings on the server and starts the race clock.

From then on, races close by themselves at their end time:
- The final top places are saved as a payout list in **Payouts**, marked unpaid.
- The next race starts with the same length.
- Visitors on the page see the winner reveal.

## 6. Connect Vega

1. Send Vega's affiliate manager the server's **IPv4** to whitelist.
2. Ask for: the API URL, how the key is sent, and an example response.
3. On the server, `nano /opt/usecodealex/server/.env` and fill the `VEGA_` lines (the comments explain each one), then:

```bash
systemctl restart usecodealex
```

4. In the admin, the left menu shows **Vega API: on**. Any error from Vega shows there too.

If Vega's API needs something unusual (signed requests, paging), send me their docs and I'll adjust `server/lib/casinos/`.

## 7. Rugs.fun

Same as Vega with the `RUGS_` lines, if Rugs.fun has a referral API.
If not, Alex pastes the list in **Admin → Players → Import wagers** before a round ends.

---

## Updating the site later

```bash
cd /opt/usecodealex && git pull && systemctl restart usecodealex
```

## Backups

All settings, links and payout history live in one file: `server/data/db.json`. Daily copy:

```bash
mkdir -p /root/backups
( crontab -l 2>/dev/null; echo '15 3 * * * cp /opt/usecodealex/server/data/db.json /root/backups/db-$(date +\%F).json && find /root/backups -mtime +30 -delete' ) | crontab -
```

## If something is wrong

```bash
journalctl -u usecodealex -n 100 --no-pager    # server log
systemctl restart usecodealex
```

Never set `DEV_LOGIN=1` on the live server. The server refuses to start if you do.
