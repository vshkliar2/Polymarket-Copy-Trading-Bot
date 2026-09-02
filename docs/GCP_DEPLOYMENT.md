# Deploying on Google Cloud Platform (GCP)

This guide covers deploying the bot to a GCP Compute Engine VM — the path used
to replace an expired AWS EC2 free-tier instance. It includes a critical
region constraint specific to Polymarket that isn't obvious from GCP's own
docs: **most European GCP regions will break trade placement.**

## Why region choice matters here

Polymarket geoblocks by the IP address making the API request, independent of
account/wallet jurisdiction. Per Polymarket's own docs
([docs.polymarket.com/api-reference/geoblock](https://docs.polymarket.com/api-reference/geoblock)):

- **Fully blocked** (no reads or writes): Iran, Syria, Cuba, North Korea,
  occupied Ukrainian regions — OFAC-sanctioned jurisdictions.
- **Close-only on both frontend AND API** (~30+ jurisdictions) — you can close
  existing positions but **cannot place new orders**: this tier includes
  **Germany, France, Belgium, Poland**, plus the US, UK, Australia, Brazil,
  Canada, Russia, and others.
- **Close-only on frontend only, API unrestricted**: Ireland, **Netherlands**,
  Japan, Malta (sports only). Since this bot only ever talks to the CLOB API
  directly and never touches Polymarket's web frontend, these regions work
  fine for trading.

**This ruled out the GCP regions that would otherwise be the obvious choices**
(Frankfurt `europe-west3`, Belgium `europe-west1`, Warsaw `europe-central2` —
all close-only on the API). **`europe-west4` (Netherlands) is the region used
in this deployment** specifically because it's one of the few EU regions where
the CLOB API itself is unrestricted.

If Polymarket's restriction list changes, re-check the official docs URL
above before assuming any given region is safe — the tiering isn't intuitive
(e.g., Germany and Belgium are close-only, but Netherlands isn't).

**Before trusting any region for real trading**, verify empirically: run the
bot with `DRY_RUN=false` and place one small real test trade, or at minimum
confirm the CLOB client initializes and `npm run check-allowance` succeeds
without a geoblock-related rejection. Documentation and enforcement in
practice aren't always identical.

## 1. Billing safety (do this first)

GCP does not have a built-in hard spending cap by default. Before creating
any resources:

1. Console → **Billing** → **Budgets & alerts** → **Create budget**
2. Scope the budget to the specific project used for this bot (not the whole
   billing account)
3. Set an amount with headroom over expected cost (e.g. $20/month against an
   ~$13-14/month `e2-small` instance)
4. Leave default alert thresholds (50%/90%/100%) — you'll get email alerts

A hard billing cutoff (auto-disabling billing via a budget-triggered Cloud
Function) is overkill for a single fixed-size VM with no autoscaling — that
automation is built for unpredictable per-request billing (Cloud Run,
BigQuery), not a flat-rate VM. A budget alert is sufficient here.

## 2. Create the project and link billing

```bash
gcloud projects create polymarket-bot-prod --name="Polymarket Bot"
gcloud billing projects link polymarket-bot-prod --billing-account=YOUR_BILLING_ACCOUNT_ID
gcloud config set project polymarket-bot-prod
```

Find your billing account ID with `gcloud billing accounts list`.

## 3. Create the VM

**Machine type:** `e2-small` (2 vCPU burstable, 2GB RAM) — comfortably runs
the main bot process; if adding the discovery-worker PM2 apps later, monitor
memory headroom.

**Region/zone:** `europe-west4` (Netherlands) — any zone (`-a`, `-b`, `-c`)
works; if one zone reports a capacity error for the disk type, try another
zone in the same region, or use "Balanced persistent disk" instead of SSD
persistent disk (cheaper and avoids most capacity issues for this workload).

**Boot disk:** Debian 12 (bookworm), Balanced persistent disk, 20GB.

**Firewall:** leave "Allow HTTP traffic" and "Allow HTTPS traffic"
**unchecked** — this bot only makes outbound calls (Polymarket, MongoDB
Atlas, Telegram) and needs no inbound web ports. SSH (port 22) is available
by default without a checkbox.

Via Console UI: **☰ menu → Compute Engine → VM instances → + CREATE INSTANCE**,
fill in the above, click **CREATE**.

Via `gcloud` (equivalent):
```bash
gcloud compute instances create polymarket-bot \
  --zone=europe-west4-c \
  --machine-type=e2-small \
  --image-family=debian-12 \
  --image-project=debian-cloud \
  --boot-disk-size=20GB \
  --boot-disk-type=pd-balanced
```

## 4. Reserve a static external IP

The VM's default ephemeral external IP can change if the instance is ever
stopped and restarted, which would silently break the MongoDB Atlas IP
allowlist. Reserve it as static right after creation:

```bash
# Find the current ephemeral IP:
gcloud compute instances list

# Promote it to a static reservation (won't change on stop/start):
gcloud compute addresses create polymarket-bot-ip \
  --region=europe-west4 \
  --addresses=<THE_EXTERNAL_IP_FROM_ABOVE>
```

Note: GCP charges a small fee (~$0.005/hour) for a reserved static IP only
while it is *not* attached to a running VM. While attached to this running
instance, there's no extra cost beyond the normal external-IP charge you'd
already be paying.

## 5. Connect via SSH from your local machine

```bash
gcloud compute ssh polymarket-bot --zone=europe-west4-c
```

First run auto-generates an SSH keypair (`~/.ssh/google_compute_engine`) and
uploads the public key to the instance's metadata — no manual key setup.

## 6. Install Node.js, PM2, and clone the repo (on the VM)

> The bot requires Node.js **>=24** (see `engines.node` in `package.json`).
> This isn't an arbitrary bump — it's required by the `@polymarket/client`
> SDK dependency, which replaced the old `@polymarket/clob-client-v2`
> package. Installing an older Node major version here will not work.

```bash
sudo apt-get update && sudo apt-get upgrade -y
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs git
sudo npm install -g pm2

git clone https://github.com/vshkliar2/Polymarket-Copy-Trading-Bot.git
cd Polymarket-Copy-Trading-Bot
npm install
npm run build
```

## 7. Transfer `.env` securely (from your local machine, not the VM)

Never commit `.env` to git or paste secrets into a chat session. Transfer it
directly over SSH:

```bash
gcloud compute scp /path/to/local/.env polymarket-bot:~/Polymarket-Copy-Trading-Bot/.env --zone=europe-west4-c
```

On the VM, edit `.env` and ensure:
- `TELEGRAM_COMMAND_LISTENER_ENABLED=true` — required for the main bot
  process to handle `/list`, `/add`, `/remove`, `/pending` commands. Leave
  this unset (false) on any separate discovery-worker/new-wallet-worker
  processes, since Telegram allows only one `getUpdates` poller per bot
  token — see `docs/DEPLOYMENT.md`'s Discovery Workers section.
- `DRY_RUN` is unset or `false` before going live (see below for the
  recommended dry-run verification step first).

## 8. Update MongoDB Atlas Network Access

On the VM, confirm the outbound IP:
```bash
curl -4 ifconfig.me
```

In MongoDB Atlas: **Network Access → Add IP Address** → paste the VM's
static IP from step 4 → confirm.

## 9. Verify before going live

```bash
npm run health-check
```

Then run a dry pass with `DRY_RUN=true` set in `.env`:
```bash
npm run dev
```

Watch for: MongoDB connects, CLOB client initializes without a
geoblock/rejection error (this is the step that would surface a region
problem), and the trade monitor starts. `Ctrl+C` to stop once confirmed.

## 10. Go live with PM2

Set `DRY_RUN=false` (or remove the line) in `.env`, then:

```bash
npm run build
pm2 start ecosystem.config.js --only polymarket-bot
pm2 status
pm2 logs polymarket-bot --lines 50
```

`--only polymarket-bot` starts just the main bot, not the two discovery
worker PM2 apps — see `docs/DEPLOYMENT.md` for whether/when to add those
(note: as of this writing, the leaderboard-based `discovery-worker` finds no
candidates due to an upstream Polymarket API issue unrelated to this
deployment).

## 11. Survive VM reboots

```bash
pm2 save
pm2 startup
```

`pm2 startup` prints a `sudo` command tailored to your system — run exactly
what it outputs. This registers PM2 as a systemd service so the bot restarts
automatically if the VM reboots.
