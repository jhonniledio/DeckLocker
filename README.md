# Deck Locker

Lock games, plugins, Quick Access Menu tabs, and Steam Menu items behind a PIN on your Steam Deck. Locked content stays inaccessible — from the library, context menus, Home shortcuts, or any other entry point — until the right PIN is entered.

Built for the classic "someone borrows my Deck" problem: only the games you've approved are playable, everything else stays out of reach. 😜

## Features

- Lock individual games, Decky plugins, QAM tabs, and Steam Menu items independently
- Full-screen numeric keypad lock screen with game art, or a compact PIN prompt for menus and panels
- Locked games show an optional lock badge on their cover art in Home, Recent, and the Library
- Unlocks last for the session — no repeated PIN entry until you re-lock or close the menu
- Deep customization: keypad shape/size, glass effect, background art, re-lock animation, and more
- Built to support more than PIN — additional unlock methods are already on the settings menu, marked as they arrive

## Installation

Not yet available on the Decky Plugin Store — install manually:

1. Download the latest release zip
2. In Decky Loader, go to **Settings → Install Plugin from ZIP** and select the file

## Usage

1. Open the **Deck Locker** tab from the Quick Access Menu (⋯)
2. Toggle **Enable Lock** and set a PIN
3. Expand any of the **Games**, **Plugins**, **Quick Menu**, or **Steam Menu** sections and toggle on what you want locked

Whatever you lock will prompt for the PIN the next time it's opened. Games get a full lock screen; everything else gets a compact PIN prompt in place. A locked game also gets a small re-lock button next to its Play button once unlocked.

### Forgot your PIN?

Run `scripts/reset-decklocker.sh` from a terminal in Desktop Mode. It wipes Deck Locker back to a clean install (no PIN, everything unlocked) after confirming with you — a backup of your old settings is kept alongside it.

## Notes

- This isn't a security guarantee against someone with direct filesystem access — it blocks normal in-UI access, not a determined attacker.
- Your PIN is stored as a SHA-256 hash locally; it's never sent anywhere.
- Everything unlocks again on a Steam restart (and optionally on sleep, if you enable that).

## Building from source

Requires Node.js v16.14+ and pnpm v9.

```bash
pnpm install
pnpm run build
```

The built plugin is placed in `out/`.

## License

BSD 3-Clause — see [LICENSE](LICENSE).
