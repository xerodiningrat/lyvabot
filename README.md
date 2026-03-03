# Roblox Discord Review Bot (MVP)

MVP bot untuk workflow code review Roblox di Discord:
- Level 1: format code + line number, checklist, template feedback
- Level 2: rule-based warning sederhana
- Level 3: `/review ai` (LLM/OpenAI) untuk ringkasan dan suggested patch

## Setup

1. Install dependencies

```bash
npm install
```

2. Copy env

```bash
copy .env.example .env
```

3. Isi `.env`
- `DISCORD_TOKEN`
- `DISCORD_CLIENT_ID`
- `DISCORD_GUILD_ID`
- `DISCORD_GUILD_IDS` (opsional, daftar guild dipisah koma untuk multi deploy)
- `AUTO_SYNC_GUILD_COMMANDS` (default `true`, auto update command saat bot start + join guild baru)
- `DEPLOY_FALLBACK_GLOBAL` (default `false`, jika `true` deploy guild gagal akan fallback ke global)
- `CLEAR_GLOBAL_ON_GUILD_DEPLOY` (default `true`, bersihkan global commands agar tidak double)
- `OPENAI_API_KEY` (wajib untuk `/review ai`)
- `OPENAI_MODEL` (opsional, default `gpt-4o-mini`)
- `AI_DAILY_BUDGET_USD` (default `5`)
- `AI_MAX_REQUESTS_PER_DAY` (default `250`)
- `AI_MAX_REQUESTS_PER_USER_PER_DAY` (default `3`)
- `AI_MAX_CODE_CHARS` (default `6000`)
- `AI_MAX_OUTPUT_TOKENS` (default `500`)
- `PROMO_MESSAGE` (opsional, banner promo di atas tiap response)
- `MENU_PROMO_TEXT` (opsional, teks promo khusus panel `/menu`)
- `MENU_PROMO_URL` (opsional, URL tombol promo di panel `/menu`)
- `PRIVATE_ONLY_MODE` (default `true`, semua output command dibuat private/ephemeral)
- `VERIFY_DEFAULT_ROLE_ID` (opsional, role default untuk tombol verifikasi `/verify`)
- `DASHBOARD_ENABLED` (set `true` untuk aktifkan web dashboard)
- `DASHBOARD_HOST` (default `127.0.0.1`, untuk diproxy via Nginx)
- `DASHBOARD_PORT` (default `3001`)
- `DASHBOARD_TITLE` (judul halaman dashboard)
- `DASHBOARD_USERNAME` dan `DASHBOARD_PASSWORD` (login dashboard)
- `DASHBOARD_MAX_UPLOAD_FILES` (default `10`, batas upload file sekali kirim via dashboard)
- `DASHBOARD_MAX_UPLOAD_BYTES_PER_FILE` (default `15728640` = 15MB per file)
- `DASHBOARD_MAX_JSON_BYTES` (default `36700160` = 35MB total payload upload)
- `DASHBOARD_ALLOW_SELF_UPDATE` (default `false`, aktifkan tombol update otomatis dari dashboard)
- `DASHBOARD_REPO_BRANCH` (default `main`)
- `DASHBOARD_APP_DIR` (default folder kerja app saat self-update, contoh `/root/lyvabot`)
- `DASHBOARD_SELF_UPDATE_LOG_PATH` (lokasi file log proses self-update)
- `MEMBER_PAGE_TITLE` (judul halaman member/public)
- `MEMBER_DISCORD_URL` (opsional, tombol Join Discord di halaman member)
- `MEMBER_PROMO_URL` (URL tombol website/promo di halaman member)
- `ASSET_DUPLICATE_POLICY` (default `replace`, file dengan nama sama akan hapus file lama lalu simpan yang baru)

4. Deploy slash command ke guild test

```bash
npm run deploy
```

Alternatif:
- `npm run deploy:guild` untuk deploy ke `DISCORD_GUILD_ID` atau semua ID di `DISCORD_GUILD_IDS`
- `npm run deploy:global` untuk deploy global (lebih lambat muncul di Discord)

5. Jalankan bot

```bash
npm start
```

## Command

### `/menu`
- Menampilkan panel awal dengan tombol interaktif:
  - `Fitur Review`
  - `Verify`
  - `Asset File`
  - `Asset ID Mobile`
  - `Quick Test`
- Saat tombol diklik, bot kirim panduan singkat fitur terkait.
- Panel dikirim private (ephemeral) saat `PRIVATE_ONLY_MODE=true`.

### `/verify panel`
- Admin kirim panel tombol `Verify` ke channel.
- User klik tombol untuk otomatis dapat role verifikasi.
- Opsi:
  - `role` (opsional kalau `VERIFY_DEFAULT_ROLE_ID` sudah di-set)
  - `channel` (opsional)
  - `title` dan `description` (opsional)
- Syarat:
  - Bot punya permission `Manage Roles`
  - Posisi role bot harus di atas role verifikasi.

### `/verify status`
- Cek apakah user sudah punya role verifikasi default (`VERIFY_DEFAULT_ROLE_ID`).

## Dashboard Web

Bot ini punya dashboard web built-in untuk:
- melihat status bot (online, guild, uptime)
- melihat statistik AI usage, asset count, dan review history
- sync command ke semua guild / 1 guild
- clear global commands
- upload free asset langsung dari dashboard (multi-file sekaligus)
- lihat list asset terbaru langsung di dashboard
- trigger update app dari GitHub langsung dari dashboard (opsional, jika diaktifkan)
- kelola data `Studio Lite ID` langsung dari dashboard (input `Nama Fitur + Asset ID`)

Catatan upload dashboard:
- Upload multi-file diproses satu per satu (lebih stabil untuk file banyak).
- Jika sering gagal karena ukuran request, naikkan `client_max_body_size` di Nginx (contoh `50M`).
- Jika nama file duplikat, file lama otomatis dihapus (policy `replace`) dan dicatat di log `data/asset-dedupe.log`.
- Duplikat kini dihitung secara "canonical" (contoh `inventory_nih_woii.rbxm` dan `inventory-nih-woii.rbxm` dianggap sama untuk ekstensi yang sama).

Aktifkan dengan env:

```env
DASHBOARD_ENABLED=true
DASHBOARD_HOST=127.0.0.1
DASHBOARD_PORT=3001
DASHBOARD_USERNAME=admin
DASHBOARD_PASSWORD=ganti_password_kuat
```

Lalu restart bot, dan cek di VPS:

```bash
curl http://127.0.0.1:3001
```

Route web:
- `/` atau `/member` = halaman member/public (fitur, free asset, studio lite id)
- `/dashboard` = halaman admin dashboard (login)

Halaman member/public sekarang:
- punya sidebar: `Home`, `Asset PC`, `Asset HP`, `Review`
- list asset tampil model card (desktop 3 kolom)
- user bisa download asset langsung dari web (tanpa lewat Discord)

Foto/thumbnail fitur:
- simpan file preview di folder `assets/previews`
- format: `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`
- nama file preview harus sama dengan nama asset/key (canonical match)
- contoh:
  - asset: `inventory-nih-woii.rbxm`
  - preview: `inventory_nih_woii.png`

Untuk akses publik via domain + Nginx:

```nginx
server {
    server_name dashboard.lyvaindonesia.my.id;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Setelah itu:
1. `sudo nginx -t`
2. `sudo systemctl reload nginx`
3. `sudo certbot --nginx -d dashboard.lyvaindonesia.my.id`

### `/review paste`
- `code` (optional): script Lua/Roblox
- `file` (optional): upload `.lua`, `.luau`, atau `.txt`
- `filename` (optional): contoh `CombatServer.lua`
- `pack` (optional): `all` | `security` | `performance` | `style`
- `ignore_rules` (optional): daftar rule id dipisah koma, contoh `missing-rate-limit,repeated-getservice`

Minimal isi salah satu: `code` atau `file`.
`ignore_rules` bisa dipakai bareng komentar inline di kode:
`-- lyva:ignore trust-client-economy`

Output:
- output private (hanya requester) saat `PRIVATE_ONLY_MODE=true`
- bot kirim code block bernomor line
- bot kirim `Signal Scan` (keyword dasar analyzer)
- bot kirim checklist reviewer dengan status:
  - `[x]` pass
  - `[ ]` fail
  - `[—]` N/A
  - `[?]` unknown (input terindikasi terpotong/truncated)
  - fail berisi bukti singkat (rule + line/evidence)
- rule analysis selalu jalan di full code input; preview bisa dipotong untuk tampilan
- bot kirim hasil rule check
- bot kirim summary 1 baris untuk issue utama
- bot kirim template feedback + auto draft untuk issue teratas
- bot kirim `Suggested Patch` otomatis
- bot kirim opsi `Server-Authoritative Redesign` untuk kasus trust-client economy
- bot tampilkan `Impact`, `Detection confidence`, dan `Patch confidence` per temuan
- bot kirim `Remediation Checklist` untuk retest
- bot simpan history temuan per `user + filename` (issue repeat tracking)

### `/review ai`
- Input:
  - `code` (optional): script Lua/Roblox
  - `file` (optional): upload `.lua`, `.luau`, atau `.txt`
  - `filename` (optional): contoh `CombatServer.lua`
  - `pack` (optional): konteks rule `all|security|performance|style`
- Output ephemeral:
  - ringkasan AI
  - temuan prioritas (severity, dampak, saran)
  - suggested patch
  - test plan
  - context hasil rule-based (Level 2)

Mode AI sekarang pakai hybrid safety:
- rule engine scan full script dulu
- AI menerima potongan issue (bukan full script mentah)
- prompt guardrail aktif (hindari patch ngawur)
- patch AI divalidasi; jika gagal guardrail, fallback ke patch rule-based

Limiter bawaan untuk hemat budget:
- blok request jika estimasi melewati `AI_DAILY_BUDGET_USD`
- blok jika request harian global/user melewati limit
- token output AI dibatasi via `AI_MAX_OUTPUT_TOKENS`

### `/review debug` (admin only)
- Sama input dengan `/review paste` (`code/file/filename/pack/ignore_rules`)
- Output ephemeral:
  - `Signal Scan` true/false
  - `Input stats` (`rawChars/rawLines`, `analyzedChars/analyzedLines`, `analysisTruncated`)
  - preview `first200` + `last200` (raw dan analyzed)
  - jumlah rule loaded + pack aktif
  - daftar `applied rules`
  - hint `why-no-match` saat tidak ada finding
  - `actionable hints` kalau token penting tidak ditemukan

### `/asset list`
- Menampilkan daftar free asset yang tersedia di library lokal bot.
- Sumber file: folder `assets/free`.

### `/asset get`
- Input:
  - `name` (required): key atau nama file dari hasil `/asset list`
- Output:
  - bot kirim file asset private (ephemeral) saat `PRIVATE_ONLY_MODE=true`.

### `/asset upload` (admin only)
- Input:
  - `file` (required): file 1 (`.rbxm`, `.rbxmx`, `.lua`, `.luau`, `.txt`)
  - `file2` sampai `file10` (optional): upload banyak file sekaligus (maks 10)
  - `name` (optional): nama custom (hanya untuk upload 1 file)
- Behavior:
  - file disimpan ke `assets/free`
  - jika nama bentrok, bot otomatis tambah suffix `-1`, `-2`, dst.

### `/asset uploadmsg` (admin only)
- Import banyak file dari satu pesan attachment (lebih cepat untuk drag-and-drop banyak file).
- Input:
  - `message_id` (optional): ID pesan sumber; jika kosong bot cari pesan attachment terakhirmu di channel.
- Catatan:
  - maksimal diproses 10 file per sekali command.

### `/asset addid` (admin only)
- Tambah free asset **mobile** berbasis `nama + id`.
- Input:
  - `name` (required): nama asset
  - `id` (required): Roblox asset ID (angka)
  - `kind` (optional): tipe asset

### `/asset listid`
- Lihat daftar free asset mobile berbasis ID.

### `/asset getid`
- Input:
  - `name` (required): nama/key/id asset mobile (support autocomplete)
- Output:
  - bot kirim detail ID + format copy cepat `rbxassetid://...` + link Roblox library.

## Rule bawaan (Level 2)
- `trust-client-economy` (CRITICAL): argumen client dipakai langsung untuk update ekonomi
- `trust-client-damage` (CRITICAL): argumen client dipakai langsung untuk logic damage/health
- `trust-client-teleport` (HIGH): argumen client memengaruhi posisi/teleport
- `trust-client-inventory` (CRITICAL): argumen client dipakai di flow inventory/item
- `trust-client-datastore` (HIGH): argumen client mengalir ke DataStore write sink
- `datastore-without-pcall` (HIGH): SetAsync/UpdateAsync tanpa `pcall`
- `missing-rate-limit`: event sensitif tanpa cooldown/rate-limit
- `missing-remote-validation`: type/range/NaN-infinite guard belum lengkap
- `while true do` tanpa `task.wait()`
- penggunaan `wait()`
- `:Connect()` di scope dinamis tanpa indikasi `:Disconnect()`
- `:FireServer()` pada file yang terindikasi server
- `GetService` berulang
- `FindFirstChild` yang langsung di-chain
- `FindFirstChild` assign ke variable lalu diakses tanpa nil-check (possible nil index)
- akses `Character/Humanoid/HumanoidRootPart` langsung tanpa guard/Wait (possible nil character access)
- callback frame-loop (RenderStepped/Heartbeat/Stepped) berat / tanpa gating (frame-loop-heavy-risk)
  - untuk pola fly-like (`LocalPlayer` + frame-loop), bot minimal memberi warning LOW agar review tidak kosong

## Catatan
- Rule ini sengaja sederhana agar cepat dan stabil untuk MVP.
- Tetap wajib human review untuk logic gameplay dan security detail.
# lyvabot
# deploy test
# retry deploy
