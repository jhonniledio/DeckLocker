# Deck Locker

Lock selected games behind a PIN on your Steam Deck. Games can't be launched — from the library, context menus, or any other entry point — without entering the correct PIN first.

## Features

- **PIN-lock any game** — Steam games and non-Steam shortcuts both supported
- **Full-screen lock screen** — covers the game page entirely with a numeric keypad and game art
- **Context menu protection** — blocks the "Play" shortcut from the Options context menu
- **Safety-net hook** — catches any game that manages to start anyway and kills it before it runs
- **Re-lock button** — a lock icon appears in the play-controls row after unlocking, letting you re-lock without leaving the page
- **QAM panel lock** — optionally require a PIN to open Deck Locker's own settings panel
- **Unlock persists per session** — you only need to enter the PIN once per game per session
- **Customizable lock screen** — glass keypad effect, circle keys, adjustable corner radius, keypad side swap, hero art background with blur/opacity controls, re-lock animation toggle

## Installation

Install via the Decky Plugin Store, or manually:

1. Download the latest release zip
2. In Decky Loader, go to **Settings → Install Plugin from ZIP** and select the file

## Usage

### Setting a PIN

1. Press the **Quick Access** button (⋯) to open the QAM panel
2. Open the **Deck Locker** tab
3. Toggle **Enable Lock** on
4. Tap **Set PIN** and enter a PIN of at least 4 digits

### Locking a game

1. Make sure **Enable Lock** is on and a PIN is set
2. Expand **Show Games List**
3. Toggle on any game you want to lock

### Unlocking a game

Navigate to the game's library page. The lock screen appears automatically — enter your PIN to unlock. The game stays unlocked for the rest of the session.

### Re-locking a game

After unlocking, a small lock icon appears next to the Play button on the game's page. Tap it to re-lock the game immediately.

### Locking the settings panel

Under **OTHERS**, toggle **Enable Lock This Plugin** to require the PIN before anyone can open Deck Locker's settings.

## Customization

Tap **Customization** in the Deck Locker panel to adjust:

| Setting | Description |
|---|---|
| Circle Keys | Makes keypad buttons fully circular |
| Keypad Corner Roundness | Slider for rectangular button corner radius |
| Glass Effect | Semi-transparent blurred keypad background |
| Keypad on Right | Swaps the keypad and game art sides |
| Lock Screen Game Background | Shows the game's hero art behind the lock screen |
| Background Blur / Opacity | Controls the hero art blur and dimming |
| Re-lock Animation | Animated lock icon when manually re-locking |

## Notes

- Locking a game prevents launch from the library page, context menus, and external shortcuts. It is not a security guarantee against a determined user with direct filesystem access.
- The PIN is stored as a SHA-256 hash in `<DECKY_PLUGIN_SETTINGS_DIR>/settings.json`.
- Unlock state resets each time Steam restarts.

## Building from source

Requires Node.js v16.14+ and pnpm v9.

```bash
pnpm install
pnpm run build
```

The built plugin is placed in `out/`.

## License

BSD 3-Clause — see [LICENSE](LICENSE).
