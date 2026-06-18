# Low-Resource Deployment (6 GB RAM / 4 Cores)

Open Archiver can run on modest hardware — for example a **6 GB RAM VPS with 4 CPU cores** — when tuned correctly. This guide covers Docker and bare-metal setups.

## Quick Start (Docker)

Use the low-resource Compose overlay:

```bash
cp .env.example .env
# Edit .env — set passwords and secrets

docker compose -f docker-compose.yml -f docker-compose.low-resource.yml up -d
```

This overlay:

- Sets `RESOURCE_PROFILE=low` (serial ingestion/indexing, small batches)
- Caps container memory (app 2 GB, Postgres 768 MB, Meilisearch 768 MB, Valkey 256 MB)
- Limits Meilisearch indexing to **384 MiB** and **2 threads**
- Disables Apache Tika (OCR) to save ~500 MB RAM
- Sets Node.js heap to **1024 MB**

### Enable OCR on low-RAM hosts (optional)

Attachment text extraction via Tika is heavy. Only enable if you need it:

```bash
docker compose -f docker-compose.yml -f docker-compose.low-resource.yml --profile ocr up -d
```

Then set `TIKA_URL=http://tika:9998` in `.env`.

## Quick Start (bare metal, no Docker)

Use the installer script (Debian/Ubuntu or RHEL/Fedora):

```bash
curl -fsSL https://raw.githubusercontent.com/jacksonm36/install-scripts/main/open-mailarchiver-nolxc | sudo bash
```

The installer clones [jacksonm36/OpenArchiver_fork](https://github.com/jacksonm36/OpenArchiver_fork), auto-detects RAM, applies the `low` profile on 6 GB hosts, skips Tika by default, and writes credentials to `~/openarchiver.creds`.

Force low profile on any host:

```bash
curl -fsSL https://raw.githubusercontent.com/jacksonm36/install-scripts/main/open-mailarchiver-nolxc | sudo bash -s -- --resource-profile low
```

Source copy in this repo: `scripts/install/open-mailarchiver-nolxc`

## Resource Profiles

Set `RESOURCE_PROFILE` in `.env`:

| Profile | When to use | Ingestion workers | Indexing workers | Batch size | Sync interval |
|---------|-------------|-------------------|------------------|------------|---------------|
| `auto` | **Default** — detects RAM/CPU (incl. Docker cgroup limits) and tunes all settings | varies | varies | varies | varies |
| `low` | ≤ 6–8 GB RAM, 4 cores | 1 | 1 | 25 | every 15 min |
| `balanced` | 8–16 GB RAM | 2 | 2 | 50 | every 5 min |
| `high` | 16 GB+ RAM | 5 | 3 | 100 | every 1 min |

`auto` reads **effective** RAM and CPU from the narrowest applicable limit:

| Environment | How limits are detected |
|-------------|-------------------------|
| **LXC / LXD** | cgroup v1/v2 hierarchy (`/proc/self/cgroup`, walks `memory.max`, `cpu.max`, `cpuset.cpus`) |
| **Docker / Podman** | cgroup limits (container memory/CPU caps) |
| **QEMU / KVM** | Guest `MemTotal` from `/proc/meminfo` (honours virtio balloon), DMI + CPU hypervisor flags |
| **Hyper-V** | Guest memory from `/proc/meminfo`, DMI `Microsoft Corporation` / `Virtual Machine` |
| **Bare metal** | `os.totalmem()` and online CPU count |

View detected platform and limits on **Admin → Job Queues → Resource auto-tuning**.

`low` / `balanced` / `high` use fixed presets; you can still override individual env vars.

Individual settings can still override the profile:

```env
RESOURCE_PROFILE=low
INGESTION_WORKER_CONCURRENCY=1
INDEXING_WORKER_CONCURRENCY=1
MEILI_INDEXING_BATCH=25
NODE_MAX_OLD_SPACE_MB=1024
```

## Memory Budget (~6 GB host)

| Service | Typical RAM |
|---------|-------------|
| OS + Docker | ~1 GB |
| Open Archiver (app + workers) | ~1–2 GB |
| PostgreSQL | ~512–768 MB |
| Meilisearch | ~512–768 MB |
| Valkey | ~128–256 MB |
| **Total (without Tika)** | **~4–5 GB** |

Leave headroom for PST import spikes. For large PST files on 6 GB hosts:

- Use **Local Path** ingestion (no upload copy)
- Keep `RESOURCE_PROFILE=low`
- Leave `TIKA_URL` unset unless OCR is required
- Import during off-peak hours

## PST Imports on Weak Hardware

PST parsing is the most memory-intensive operation. Recommendations:

1. Run **one ingestion job at a time** (`INGESTION_WORKER_CONCURRENCY=1` — default in `low` profile)
2. Use **small indexing batches** (`MEILI_INDEXING_BATCH=25`)
3. Mount PST via **Local Path** inside the container
4. Disable Tika for initial import; re-enable later if needed

## Bare Metal / Non-Docker (native install)

Add to `.env`:

```env
RESOURCE_PROFILE=low
NODE_MAX_OLD_SPACE_MB=1024
SYNC_FREQUENCY=*/15 * * * *
MEILI_INDEXING_BATCH=20
# TIKA_URL=   # leave unset to save RAM
```

For **50–100 GB PST/EML** on native install:

1. Use **Local Path** ingestion — never upload multi-GB files through the browser.
2. Set `FILE_IMPORT_LOCAL_PATH_ONLY=true` (or `FILE_IMPORT_MAX_UPLOAD_MB=0`) to block browser uploads entirely.
3. Set `IMPORT_ALLOWED_PATHS` to the directory where PST/ZIP files live (must be readable by the Open Archiver process).
4. Import **one file at a time**; use **Resume import** after errors.
5. Cap Meilisearch on the same host: `MEILI_MAX_INDEXING_MEMORY=384MiB`, `MEILI_MAX_INDEXING_THREADS=2`.

The backend preloads duplicate Message-IDs into memory per import job (no per-message DB lookups during resume), skips full EML parsing for known duplicates, and throttles checkpoint writes to reduce Postgres load.

Ensure external PostgreSQL, Valkey, and Meilisearch are similarly capped. For Meilisearch, set:

```env
MEILI_MAX_INDEXING_MEMORY=384MiB
MEILI_MAX_INDEXING_THREADS=2
```

## Monitoring

Watch for OOM kills during large imports:

```bash
docker stats
```

If the indexing worker is killed, lower `MEILI_INDEXING_BATCH` to `10` and `INDEXING_EMAIL_CONCURRENCY` to `1`.

## Upgrading Hardware

When you move to a larger server, switch profiles:

```env
RESOURCE_PROFILE=balanced   # 8–16 GB
# or
RESOURCE_PROFILE=high         # 16 GB+
```

Restart the stack after changing `.env`.
