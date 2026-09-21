# Runbook — QR signing key

The key that signs every table QR code. Anyone holding it, together with a table's `qr_id` from the database, can make a working QR code for that table. Treat it like a password to every table in every restaurant.

> **Never commit this key, paste it into chat, email, a ticket or a screenshot, or put it in any file other than the host's secret store.** Every example below uses placeholders. A value that looks real in this document is a mistake — report it.

## 1. What it is

| | |
|---|---|
| Variable | **`QR_SIGNING_KEYS`** (required) |
| Optional | `QR_SIGNING_KEY_ID` — which listed key signs *new* codes; defaults to the highest id |
| Format | Comma-separated `kid:secret` entries, e.g. `1:<SECRET_1>` or `1:<SECRET_1>,2:<SECRET_2>` |
| `kid` | Integer 1–255. It is written into every token, so the right key can be found on verification. |
| `secret` | At least **32 random bytes** from a cryptographic generator, encoded as **base64url without padding** — 43 characters for 32 bytes, using only `A–Z a–z 0–9 - _` |
| Used by | **The API service only.** It signs codes when staff view or print them, and verifies them when customers scan. The web app never needs it — a build check fails if it appears in the browser bundle. CI never needs it; tests generate their own throwaway keys per run. |

The API refuses to start if the key is missing, empty, too short, not strict base64url, contains stray characters or whitespace, repeats another listed key, or is not random enough (for example, a string of the same character). **There is no fallback key in any environment.** Error messages name the key id and never any part of the key.

## 2. Separate keys per environment

| Environment | Key |
|---|---|
| Local development | Its own key, in the git-ignored `.env`. **Never use it anywhere else.** |
| Staging | Its own key |
| Production | Its own key, generated for production and stored only in the host's secret store |

Separate keys mean a leaked development or staging key cannot produce codes that work in production. Within **one** environment, every running instance of the API must have the **same** value, or a code printed through one instance fails when scanned through another.

## 3. Generate a production key

Generate it on a machine you trust and send it straight to the clipboard, so it never appears on screen or in shell history:

```bash
# macOS
node -e "process.stdout.write('1:' + require('crypto').randomBytes(32).toString('base64url'))" | pbcopy

# Linux with xclip
node -e "process.stdout.write('1:' + require('crypto').randomBytes(32).toString('base64url'))" | xclip -selection clipboard
```

The clipboard now holds `1:<SECRET_1>`. Paste it into Render (below), then clear the clipboard by copying something else. Do not save it in a text file, a notes app or a password manager entry shared with anyone who does not operate production.

**Do not use** `openssl rand -base64 32`: standard base64 (`+`, `/`, `=`) is rejected, deliberately.

## 4. Configure it in Render

The repository has no `render.yaml`; the API service is configured in the dashboard.

1. Open the Render Dashboard and select the **API** web service (not the static site).
2. Click **Environment** in the left sidebar.
3. Under **Environment Variables**, click **+ Add Environment Variable**.
4. **Key:** `QR_SIGNING_KEYS`. **Value:** paste from the clipboard. Check there is no leading or trailing space — the API rejects whitespace rather than trimming it silently.
5. Leave `QR_SIGNING_KEY_ID` unset.
6. Choose **Save and deploy**, or **Save only** if you are also setting other variables and will deploy once at the end.
7. Watch the deploy log. A bad key stops the service at startup with a `QR_SIGNING_KEYS:` message naming the problem. A good key produces the normal `api listening` line.
8. Verify: sign in as an owner, open **Tables & QR**, generate a code for a test table and scan it with a phone. It should open the table page.

**More than one service needing the key** (a second API instance, a worker added later): put `QR_SIGNING_KEYS` in a Render **Environment Group** and link the group to each of those services, so there is exactly one copy to keep in step. Do not add it to the static frontend.

**Also required before printing for real:** `APP_BASE_URL` must be the permanent public `https` address — every printed code encodes it — and `QR_DOMAIN_FINAL=true` only once that address will never change.

## 5. Rotation (routine)

The token format carries the key id, and each QR records the id it was issued under. So rotation does **not** invalidate printed cards, as long as the old key stays listed.

1. Generate a new secret as in §3, with the next id: `2:<SECRET_2>`.
2. In Render, edit `QR_SIGNING_KEYS` to **append** it: `1:<SECRET_1>,2:<SECRET_2>`. Keep key 1.
3. Save and deploy.

Result: codes already printed (key 1) keep working and reprint identically. New codes are signed with key 2. A reprint of an old table stays on key 1, so the card on the table and the reprint always match. To move a table onto the new key, use **Replace code** on it; that issues a new card.

Retire key 1 only when no card still in use was signed with it, which in practice means after every table has been regenerated and reprinted. Removing it stops every card signed with it immediately.

## 6. Suspected compromise (emergency)

A leaked key lets whoever holds it, *together with* database access to `qr_id`s, create working codes. With the key alone they cannot target a table. Act anyway.

1. **Contain.** Generate a new key (§3) with a new id. Set `QR_SIGNING_KEYS` to the new key **only** (for example `3:<SECRET_3>`), then save and deploy. From this moment **every printed card stops working**; customers see "This QR code isn't active".
2. **Reissue.** For every restaurant, every table needs **Replace code** and a reprint. Warn the restaurants before step 1 if at all possible, because there is a service impact until the new cards are on the tables.
3. **Investigate.** Where did the key appear: a commit, a log, a screenshot, a message? Remove it at the source. A key found in git history stays in that history even after deletion.
4. **Record.** Note the incident, the old key id and the time of rotation. Never write down the key itself.

If only the database was exposed and the key was not, the key does not need to change. The `qr_id`s alone cannot produce a valid token. Review database access instead.

## 7. Limitations

- Keys are symmetric (HMAC). Whatever can verify a code can also sign one. That is fine while one API service does both. If verification ever moves to a separate service, such as an edge function, that service should get a verify-only key: a public key with Ed25519 signatures, with the private key staying with the service that issues codes. That would be a new token version, and tokens would get longer (a 64-byte signature), making QR codes denser. Not needed today.
- The key id is one byte, so at most 255 keys over the product's lifetime — far more than routine rotation needs.
- Nothing can revoke a *leaked key* except removing it, which invalidates its cards (§6). Individual cards are revoked per table with **Revoke** or **Replace code**, without touching the key.
