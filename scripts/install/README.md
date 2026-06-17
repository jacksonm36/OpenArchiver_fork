# Bare-metal installation scripts

Scripts for installing [Open Archiver](https://github.com/jacksonm36/OpenArchiver_fork) without Docker or LXC.

## `open-mailarchiver-nolxc`

Idempotent installer for Debian/Ubuntu and RHEL/Fedora family distros.

### What it installs

| Component | Version |
|-----------|---------|
| Open Archiver | `jacksonm36/OpenArchiver_fork` @ `main` |
| PostgreSQL | 17 |
| Valkey | distro package |
| Meilisearch | v1.38 |
| Node.js | 22 + pnpm 10.13.1 |
| Apache Tika | 3.2.3 (optional) |

### Features (fork improvements)

- **Resource profiles** (`low` / `balanced` / `high` / `auto`) — safe on 6 GB RAM / 4 cores
- **Fast PST path** — body-only EML, indexing hints, duplicate skip
- **Optional Tika** — skipped on low-RAM hosts by default (~500 MB saved)
- **Valkey password** — auto-generated and configured
- **Meilisearch RAM limits** — indexing memory capped per profile
- **`BODY_SIZE_LIMIT=Infinity`** — large PST uploads via UI where supported

### Quick install

```bash
curl -fsSL https://raw.githubusercontent.com/jacksonm36/install-scripts/main/open-mailarchiver-nolxc | sudo bash
```

Or from this repository:

```bash
sudo bash scripts/install/open-mailarchiver-nolxc
```

### Options

```bash
sudo bash scripts/install/open-mailarchiver-nolxc --resource-profile low
sudo bash scripts/install/open-mailarchiver-nolxc --with-tika
sudo bash scripts/install/open-mailarchiver-nolxc --no-tika
sudo bash scripts/install/open-mailarchiver-nolxc --update   # git pull + rebuild only
```

### After install

- Web UI: `http://<server-ip>:3000`
- Credentials: `~/openarchiver.creds`
- Data directory: `/opt/openarchiver-data`
- PST files: place under `/opt/openarchiver-data/temp/` and use **Local Path** ingestion

### Low-resource hosts (6 GB RAM)

The installer auto-detects RAM and applies the `low` profile:

| Setting | Value |
|---------|-------|
| Ingestion workers | 1 |
| Indexing workers | 1 |
| Indexing batch | 25 emails |
| Node heap | 1024 MB |
| Tika | disabled |
| Sync interval | every 15 minutes |

See [low-resource deployment guide](../../docs/user-guides/low-resource-deployment.md).

See [migration guide](../../scripts/migrate/README.md) for upgrading from upstream OpenArchiver.

### Syncing to install-scripts repo

Copy this file to [jacksonm36/install-scripts](https://github.com/jacksonm36/install-scripts):

```bash
cp scripts/install/open-mailarchiver-nolxc /path/to/install-scripts/open-mailarchiver-nolxc
```
