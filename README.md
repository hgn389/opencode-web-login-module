# OpenCode web login

Login: `http://192.168.1.150:4096/login`.
Logout confirmation: `http://192.168.1.150:4096/logout`.
Use the existing OpenCode username (`opencode`) and password.

## Login protection

- Failed credentials are counted per client IP, across service restarts.
- The fifth failure displays an image verification challenge. Further credential checks require a correct challenge.
- The tenth credential failure permanently blocks the IP until an administrator unblocks it.
- Incorrect verification answers do not consume credential attempts. They are limited by a separate request throttle.
- Successful login before blocking resets consecutive credential failures.
- Challenges expire after five minutes and are consumed after one submission. Their answers are never included in HTML or image metadata.
- Up to 40 login page, form and challenge requests per IP per minute are allowed. Only one credential check per IP may be in progress.

IPs shared by several people also share their failure counter and lockout. A blocked IP cannot access protected APIs or terminal connections. This is an application block, not a firewall ban; it does not affect other websites.

## Sessions and isolation

The gateway listens on `192.168.1.150:4096`. OpenCode remains private at `127.0.0.1:4097`.

Only opaque gateway session cookies are accepted publicly. Basic credentials, native OpenCode cookies, pairing links and `auth_token` parameters cannot bypass the login form. The gateway passes the native session token to the private backend. It never stores account passwords.

Sessions expire after eight hours, or 30 minutes without activity. Logout immediately revokes the session in the database. Existing streams and WebSockets recheck session validity every 30 seconds. A rejected native token revokes the gateway session, including after an OpenCode password change.

The login service runs as the dedicated `opencode-login` system user with no shell and no access to home directories. State is in `/var/lib/opencode-login/security.sqlite`, with directory permissions `0700` and database permissions `0600`. Do not put this database, its WAL files or any environment secrets in Git.

Login failures, successful logins and new IP blocks are logged in the service journal. Passwords, challenge answers and session tokens are excluded from logs.

## Administration

```sh
systemctl status opencode opencode-login
journalctl -u opencode-login --since today

# List blocked IPs.
runuser -u opencode-login -- /usr/local/bin/node --no-warnings /opt/opencode-login/manage.mjs blocked

# Replace the address below with the IP to unblock.
runuser -u opencode-login -- /usr/local/bin/node --no-warnings /opt/opencode-login/manage.mjs unblock 192.168.1.100

# Revoke all browser sessions.
runuser -u opencode-login -- /usr/local/bin/node --no-warnings /opt/opencode-login/manage.mjs revoke-sessions
```

Unblocking takes effect immediately. It does not require restarting the service.

Restarting `opencode` also restarts `opencode-login`. Both services are enabled at boot.

## Public HTTPS deployment

The public domain has not been configured. The firewall still limits direct access to port 4096 to the LAN. Keep the application ports private; expose the HTTPS reverse proxy on port 443.

1. Configure the chosen domain and a valid TLS certificate on the reverse proxy.
2. Set `LOGIN_PUBLIC_ORIGINS=https://chosen-domain.example` in `/etc/opencode-login.env`.
3. Set `LOGIN_TRUSTED_PROXIES` to the exact proxy IP addresses or networks you control. The default trusts only `127.0.0.1` and `::1`. A local proxy connecting to the LAN address may use `192.168.1.150` as its source; configure that exact address only after checking it.
4. Preserve the public Host header. The TLS proxy must send `X-Forwarded-Proto: https` and append the real client address to `X-Forwarded-For`. Strip client-supplied forwarding headers at the first trusted edge. If using Cloudflare or another upstream proxy, verify its address ranges and forwarding behavior before adding any trust.
5. Proxy HTTP requests and WebSocket upgrades to `192.168.1.150:4096`. Redirect public HTTP to HTTPS.
6. Restart `opencode-login` and verify HTTPS, real client IPs, challenges, lockouts, and terminal connections from outside the LAN.

Configured public HTTPS origins use `__Host-` cookies with Secure, HttpOnly and SameSite=Strict attributes, plus HSTS. Public plaintext HTTP requests redirect to HTTPS; plaintext form submissions are rejected. Forwarded headers from untrusted peers are ignored. HTTPS proxy requests without a client IP header are rejected.

For additional protection against distributed attacks and image recognition, use an identity gateway with MFA and a managed bot challenge. These require the chosen domain and the corresponding service configuration.

## Validation and backups

```sh
cd /opt/opencode-login
node --no-warnings --test test/security.test.mjs
```

Tests use a separate temporary database and deterministic verification answers only inside isolated test processes. Production has no verification bypass or test endpoint.

Source changes are saved in this Git repository. Original service and firewall configurations are backed up in the private repository `/root/opencode-network-config`. The installed service is `/etc/systemd/system/opencode-login.service`; the backend override is `/etc/systemd/system/opencode.service.d/web-login.conf`.

## Restore direct LAN access

```sh
systemctl disable --now opencode-login
rm /etc/systemd/system/opencode.service.d/web-login.conf
systemctl daemon-reload
systemctl restart opencode
```

This restores direct OpenCode access at `192.168.1.150:4096` and bypasses the gateway protection. Use this only to restore LAN access; do not use the direct service as an Internet endpoint.
