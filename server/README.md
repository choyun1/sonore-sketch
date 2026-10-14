# The synthesis server

The page makes its sounds with Python in the browser (Pyodide), which takes
several seconds to start on every visit. This server runs the same Python
natively, so the page gets each sound in a fraction of a second; the page
asks it first and loads Pyodide only when it cannot be reached
(`app/engine.js`). It is `synth_server.py`: the page's own
`sonore_sketch.page.handle` behind two HTTP endpoints, with CORS for the
page's sites, a request size cap, a few syntheses at a time and a
per-address rate limit.

Any small Linux machine will do: 1 CPU and 1 GB of memory is enough for one
person drawing, and syntheses beyond what it can run at once are made in the
visitor's browser instead.

## Setting it up

These steps are for Ubuntu 24.04 (any Debian-like system is the same).

1. **A machine.** Create the VM or VPS and note its public IPv4 address,
   say `203.0.113.7`. Open ports 80 and 443 in the provider's firewall (and
   22 for SSH). Log in with SSH.

2. **The code.**

   ```sh
   sudo apt update && sudo apt install -y python3-venv git
   sudo useradd --system --home /opt/sonore-sketch synth
   sudo git clone https://github.com/choyun1/sonore-sketch /opt/sonore-sketch
   cd /opt/sonore-sketch
   sudo python3 -m venv .venv
   sudo .venv/bin/pip install -e .
   sudo chown -R synth /opt/sonore-sketch
   ```

3. **Run it as a service**, restarted if it stops and at boot:

   ```sh
   sudo cp server/sonore-sketch-synth.service /etc/systemd/system/
   sudo systemctl enable --now sonore-sketch-synth
   curl http://127.0.0.1:8100/api/version     # {"versions": "sonore 0.6.0, Python 3.12..."}
   ```

4. **HTTPS with Caddy.** The page is served over HTTPS, so the server must be
   too. With no domain of your own, `203-0-113-7.sslip.io` (your address with
   dashes) is a free name that points at your machine, and Caddy gets a
   certificate for it by itself:

   ```sh
   sudo apt install -y caddy
   sed "s/SERVER_NAME/203-0-113-7.sslip.io/" server/Caddyfile | sudo tee /etc/caddy/Caddyfile
   sudo systemctl reload caddy
   curl https://203-0-113-7.sslip.io/api/version
   ```

5. **Point the page at it.** Set `SYNTH_SERVER` in `app/engine.js` to
   `"https://203-0-113-7.sslip.io/"` and merge that to `main`. To try it
   first without changing the page, serve the page locally
   (`python tools/serve.py`) and open
   `http://localhost:8000/?server=https://203-0-113-7.sslip.io/`.

## Keeping it up to date

The server must make the same sounds as the page, so update it whenever
`main` changes `src/sonore_sketch/` or the sonore version:

```sh
cd /opt/sonore-sketch && sudo -u synth git pull && sudo .venv/bin/pip install -e . && sudo systemctl restart sonore-sketch-synth
```

`journalctl -u sonore-sketch-synth` shows its log. If it is down, the page
still works: it loads Python in the browser, as it did before the server.
