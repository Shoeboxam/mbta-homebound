# Homebound Arrival Times

A tiny MBTA commute helper for Boston.

It shows, for each upcoming **bus 75** departure from Harvard, the best connecting **Red Line** arrival at Park Street (with a minimum Harvard layover), and the last feasible **Green Line** arrival at Park Street before that Red connection. It can run as a static web page (GitHub Pages) and as a packaged Electron desktop app with optional notifications.

## Features

- **Predictions + schedules merge**
  - Uses real-time predictions when available (underlined), falls back to schedules when not.
  - Works even if predictions are missing for a stop or a trip.
- **Stable bus groups**
  - Groups rows by bus trip; selection persists in local storage.
- **Service alerts**
  - Shows a warning at the top if there are relevant alerts for the Green line, Red line, or route 75.
- **Optional “Home” stop**
  - If configured, shows bus arrival at your home stop and only considers 75 trips that are headed toward home.
- **Electron notifications (desktop app only)**
  - 3-way switch: Disabled / Silent / Enabled
  - At most one notification per train, cleared daily
  - Weekdays only
  - Best-effort auto-close after 5 minutes
  - Clicking notification opens/focuses the app

## Local development (web)

This project is a static site. Run it with a local HTTP server (do not open `index.html` directly via `file://`).

```bash
npm install
npm run dev
````

Then open:

* `http://localhost:8000`

## Electron app (desktop notifications)

### Run Electron against the built files

```bash
npm run start:electron
```

### Dev Electron against the live dev server

Terminal A:

```bash
npm run dev
```

Terminal B:

```bash
npm run electron:dev
```

(Requires `electron:dev` script in `package.json` and `electron/main.js` honoring `ELECTRON_START_URL`.)

### Package installers

```bash
npm run dist:electron
```

Build artifacts land in `release/`.

## License

MIT.
