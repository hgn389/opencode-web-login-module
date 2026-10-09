# OpenCode web login

Open the login page at `http://192.168.1.150:4096/login`. Use the existing OpenCode username (`opencode`) and password.

The web login listens on `192.168.1.150:4096`. OpenCode listens privately on `127.0.0.1:4097`. Successful sign-in exchanges the credentials for an OpenCode session token stored in an HttpOnly cookie. Passwords are not stored by the login service. Sessions last up to 30 days and are invalidated when the OpenCode password changes.

The login form checks its origin and CSRF token. Ten sign-in attempts per client address within ten minutes trigger a temporary limit. APIs keep their existing authentication; browser responses omit the Basic authentication challenge. HTTP event streams and terminal WebSocket connections pass through to OpenCode.

## Services

```sh
systemctl status opencode opencode-login
systemctl restart opencode-login
```

Restarting `opencode` also restarts `opencode-login`. Both services are enabled at boot.

Source files are in this Git repository. Installed service configuration:

- `/etc/systemd/system/opencode-login.service`
- `/etc/systemd/system/opencode.service.d/web-login.conf`

The original OpenCode service and firewall configuration are backed up in the private Git repository `/root/opencode-network-config`.

## Restore direct OpenCode access

```sh
systemctl disable --now opencode-login
rm /etc/systemd/system/opencode.service.d/web-login.conf
systemctl daemon-reload
systemctl restart opencode
```

The original service will serve OpenCode directly at `192.168.1.150:4096`. The LAN firewall rule remains in place.
