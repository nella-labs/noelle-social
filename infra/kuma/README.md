# Uptime Kuma — Noelle skin

Custom CSS applied to the public status page at `https://status.trynoelle.com`. Renders Kuma's status page in Noelle's Constellation palette (Instrument Serif + Inter + JetBrains Mono, cream `#FAF5E6` paper / rust accent) and hides the "Powered by Uptime Kuma" footer + Kuma icon.

## Files

- `noelle-skin.css` — the CSS that gets stored in the `status_page.custom_css` column of `kuma.db` on `noelle-vm-0`. Edit here, then re-apply.

## Re-apply

After editing `noelle-skin.css`:

```bash
gcloud compute scp infra/kuma/noelle-skin.css noelle-vm-0:/tmp/skin.css \
  --zone=us-east1-c --project=noelle-agents

gcloud compute ssh noelle-vm-0 --zone=us-east1-c --project=noelle-agents \
  --command='sudo sqlite3 /var/lib/docker/volumes/uptime-kuma-data/_data/kuma.db \
    "UPDATE status_page SET custom_css = CAST(readfile(\"/tmp/skin.css\") AS TEXT), modified_date = CURRENT_TIMESTAMP WHERE slug = \"main\";" \
    && sudo docker restart uptime-kuma'
```

The `CAST(... AS TEXT)` is required. `readfile()` returns a BLOB by default; if you skip the cast, Kuma's Node sqlite driver returns the field as a `Buffer` to the frontend and the CSS never applies.

## Other status-page settings

These are also stored on the same `status_page` row (slug=`main`):

| Column | Value | Notes |
|---|---|---|
| `show_powered_by` | `0` | Hides the "Powered by Uptime Kuma" footer link. |
| `theme` | `light` | Forces light theme to match the cream paper background. |
| `icon` | `""` (empty) | Kuma falls back to `/icon.svg` in the API response — the CSS hides it client-side. |
| `title` | `Noelle Status` | Shown in `<title>` and on the page header. |
