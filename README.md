# Deck Locker

Lock games, plugins, Quick Access Menu tabs, and Steam Menu (Main Menu) items behind a PIN on your Steam Deck. Locked content can't be opened — from the library, context menus, Home shortcuts, or any other entry point — without entering the correct PIN first.

## Features

- **PIN-lock any game** — Steam games and non-Steam shortcuts both supported
- **Full-screen lock screen** — covers the game page entirely with a numeric keypad and game art
- **Lock Decky plugins** — require a PIN before any installed plugin's panel opens, including Deck Locker's own
- **Lock Quick Access Menu tabs** — Notifications, Friends, Quick Settings, Performance, Help, Music, Remote Play Together, and Voice Chat can each be locked individually
- **Lock Steam Menu items** — Library, Store, Media, Downloads, Settings, and Power (the menu opened with the physical **STEAM** button) can each be locked individually, including the Library's Home-screen shortcut tile
- **Context menu protection** — blocks the "Play" shortcut from the Options context menu
- **Safety-net hook** — catches any game that manages to start anyway and kills it before it runs
- **Re-lock button** — a lock icon appears in the play-controls row after unlocking, letting you re-lock without leaving the page
- **Locked badges** — an optional lock icon overlaid on locked games' cover art in Home, Recent, and the Library grid, in your choice of corner (or centered)
- **Unlock persists per session** — you only need to enter the PIN once per item per session, until you re-lock it, close the menu it lives in, or (optionally) the Deck goes to sleep
- **Customizable lock screen** — glass keypad effect, square/rounded/circle keys, adjustable corner radius, key and number size, keypad side swap, keypad-only mode, hero art background with blur/opacity controls, re-lock animation toggle
- **Built for more than PIN** — the lock method is already a saved setting, ready for the additional methods below

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
2. Under **GAMES**, expand **Show Games List**
3. Toggle on any game you want to lock

### Locking a plugin

1. Under **PLUGINS**, expand **Show Plugin List**
2. Toggle on Deck Locker itself, or any other installed plugin, to require a PIN before its panel opens

To lock the Decky plugin browser tab entirely (the tab listing *all* installed plugins), expand **More Settings** near the top and enable **Lock Decky Panel** instead.

### Locking Quick Access Menu tabs

1. Under **QUICK MENU**, expand **Show Tabs List**
2. Toggle on any built-in tab (Notifications, Friends, Quick Settings, Performance, Help, Music, Remote Play Together, Voice Chat) to require a PIN before it opens

### Locking Steam Menu items

1. Under **STEAM MENU**, expand **Show Items List**
2. Toggle on any item (Library, Store, Media, Downloads, Settings, Power) to require a PIN before it opens — this also covers reaching Library through the "View more in your Library" tile on the Home screen, not just the Steam Menu itself

### Unlocking

Navigate to (or open) the locked game, plugin, tab, or menu item. The lock screen or PIN gate appears automatically — enter your PIN to unlock. It stays unlocked for the rest of the session, or until whatever it lives in (the QAM, the Steam Menu, etc.) is closed and reopened.

### Re-locking a game

After unlocking, a small lock icon appears next to the Play button on the game's page. Tap it to re-lock the game immediately.

## Lock Method

Deck Locker currently unlocks with a **PIN**. Under **Lock Method** in the main panel, you can already see the other methods planned — **Password**, **Pattern**, **Tap Code**, and **Controller Code** (a button-combination unlock, similar to the Deck's own native lock screen) — each marked *Soon*. The setting is already there and will switch over cleanly once each method is built; no PIN is lost or reset when that happens.

## Customization

Tap **Customization** in the Deck Locker panel to adjust:

| Setting | Description |
|---|---|
| Key Shape | Square, Rounded, or Circle keypad buttons |
| Corner Roundness | Slider for rounded key corner radius |
| Key Size | Size of each keypad button |
| Number Size | Size of the digits on each key |
| Glass Effect | Semi-transparent blurred keypad background |
| Swap Keypad Side | Move the keypad to the right, game art to the left |
| Keypad Only | Hide the game cover art and show just the centered keypad |
| Blurred Background | Show the game's hero art blurred behind the lock screen |
| Background Blur / Opacity | Controls the hero art blur and dimming |
| Re-lock Animation | Animated lock icon when manually re-locking |
| Enable Locked Badges | Show a lock icon on locked games' covers in Home, Recent, and the Library |
| Badge Position | Top Left, Top Right, Center, Bottom Left, or Bottom Right |

Under **More Settings** in the main panel:

| Setting | Description |
|---|---|
| Lock Decky Panel | Require a PIN before the Decky plugin browser tab is shown |
| Re-lock on Sleep | Lock everything again when the Steam Deck goes to sleep |
| Re-lock When Leaving Game | Ask for the PIN again each time you revisit a locked game's page |

## Notes

- Locking prevents launch or access from the library page, context menus, Home shortcuts, and other entry points. It is not a security guarantee against a determined user with direct filesystem access.
- The PIN is stored as a SHA-256 hash in `<DECKY_PLUGIN_SETTINGS_DIR>/settings.json`.
- Unlock state resets each time Steam restarts (and optionally on sleep, if **Re-lock on Sleep** is on).

## Building from source

Requires Node.js v16.14+ and pnpm v9.

```bash
pnpm install
pnpm run build
```

The built plugin is placed in `out/`.

## License

BSD 3-Clause — see [LICENSE](LICENSE).
