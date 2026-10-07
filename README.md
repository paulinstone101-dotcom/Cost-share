# Cost Share

An installable web app for tracking shared travel costs: who paid, how each cost is split, running balances, who owes whom, and a full audit ledger.

- **Any currency.** Enter each cost in the local currency. Rates are fetched when the app opens (from [ExchangeRate-API](https://www.exchangerate-api.com)), saved by day, and can be overridden with the rate you were actually charged.
- **Shared with an invite link.** No accounts. Anyone with a trip's link can view and add expenses.
- **Works offline.** Expenses added offline are saved on the phone and sync when you're back online.
- **Auditable.** Every entry keeps its original amount, rate, split and full change history. Entries can be voided but never deleted. Export the ledger as CSV.

## Files

| File | What it is |
|---|---|
| `index.html`, `styles.css`, `app.js` | The app |
| `firebase-config.js` | Your Firebase web settings (public by design) |
| `firestore.rules` | Database security rules — paste into Firebase console → Firestore → Rules |
| `manifest.webmanifest`, `sw.js`, `icons/` | Installable app + offline support |

## Setup

1. Create a Firebase project. Enable **Firestore** (production mode) and **Authentication → Anonymous**.
2. Paste `firestore.rules` into Firestore → Rules and publish.
3. Put your web app config into `firebase-config.js`.
4. Host the folder on any static host (GitHub Pages: Settings → Pages → Deploy from branch `main`, folder `/`).
5. Firebase → Authentication → Settings → Authorized domains: add your host (e.g. `yourname.github.io`).

When you change app files, bump `VERSION` in `sw.js` so phones pick up the update.

## Install on a phone

- **iPhone (Safari):** Share → Add to Home Screen.
- **Android (Chrome):** menu ⋮ → Install app / Add to Home screen.
