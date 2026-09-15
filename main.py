import os
import json
import glob
import shutil
import base64
import hashlib
import mimetypes
from datetime import datetime
import decky

SETTINGS_FILE = os.path.join(decky.DECKY_PLUGIN_SETTINGS_DIR, "settings.json")

# Steam custom grid art directories — where SteamGridDB and similar tools write
# per-user artwork, including art for non-Steam shortcuts (which the CDN never has).
USERDATA_GLOBS = [
    os.path.expanduser("~/.local/share/Steam/userdata/*/config/grid"),
    os.path.expanduser("~/.steam/steam/userdata/*/config/grid"),
]

# Steam's local CDN cache — used as a fallback when the live CDN is unreachable
# but Steam has already downloaded art for a game the user owns.
LIBRARYCACHE_DIRS = [
    os.path.expanduser("~/.local/share/Steam/appcache/librarycache"),
    os.path.expanduser("~/.steam/steam/appcache/librarycache"),
]


class Plugin:
    async def _load_settings(self):
        if os.path.exists(SETTINGS_FILE):
            with open(SETTINGS_FILE, "r") as f:
                self.settings = json.load(f)
            # Apply defaults for fields added after the initial release.
            self.settings.setdefault("qam_lock_enabled", False)
            self.settings.setdefault("keypad_corner_radius", 14)
            self.settings.setdefault("lockscreen_hero_bg_enabled", False)
            self.settings.setdefault("lockscreen_bg_blur_px", 8)
            self.settings.setdefault("lockscreen_bg_opacity_percent", 30)
            self.settings.setdefault("relock_animation_enabled", True)
            # keypad_shape replaces the old keypad_circle_shape boolean — migrate any
            # existing preference forward instead of silently resetting it.
            self.settings.setdefault(
                "keypad_shape",
                "circle" if self.settings.get("keypad_circle_shape") else "rounded",
            )
            self.settings.setdefault("keypad_glass_effect", False)
            self.settings.setdefault("keypad_on_right", False)
            self.settings.setdefault("relock_on_sleep", False)
            self.settings.setdefault("relock_on_exit", False)
            self.settings.setdefault("decky_panel_lock_enabled", False)
            self.settings.setdefault("hide_game_art", False)
            self.settings.setdefault("keypad_key_size", 80)
            self.settings.setdefault("keypad_font_size", 22)
            self.settings.setdefault("locked_plugins", [])
            self.settings.setdefault("locked_qam_tabs", [])
            self.settings.setdefault("locked_main_menu_items", [])
            self.settings.setdefault("locked_badge_enabled", True)
            self.settings.setdefault("locked_badge_position", "top-left")
            self.settings.setdefault("lock_method", "pin")
            self.settings.setdefault("password_hash", "")
            self.settings.setdefault("pattern_hash", "")
            self.settings.setdefault("pattern_dot_shape", "rounded")
            self.settings.setdefault("pattern_corner_radius", 14)
            self.settings.setdefault("pattern_dot_size", 72)
            self.settings.setdefault("pattern_glass_effect", False)
            self.settings.setdefault("pattern_line_theme_color", False)
            self.settings.setdefault("pattern_line_transparent", False)
            self.settings.setdefault("action_button_glass_effect", False)
            self.settings.setdefault("tap_code_hash", "")
            self.settings.setdefault("tap_code_show_outline", True)
            self.settings.setdefault("tap_code_show_dividers", False)
        else:
            self.settings = self._default_settings()

    @staticmethod
    def _default_settings() -> dict:
        return {
            "global_lock_enabled": False,
            "pin_hash": "",
            "password_hash": "",
            "pattern_hash": "",
            "tap_code_hash": "",
            "locked_apps": [],
            "locked_plugins": [],
            "locked_qam_tabs": [],
            "locked_main_menu_items": [],
            "qam_lock_enabled": False,
            "keypad_corner_radius": 14,
            "lockscreen_hero_bg_enabled": False,
            "lockscreen_bg_blur_px": 8,
            "lockscreen_bg_opacity_percent": 30,
            "relock_animation_enabled": True,
            "keypad_shape": "rounded",
            "keypad_glass_effect": False,
            "keypad_on_right": False,
            "relock_on_sleep": False,
            "relock_on_exit": False,
            "decky_panel_lock_enabled": False,
            "hide_game_art": False,
            "keypad_key_size": 80,
            "keypad_font_size": 22,
            "locked_badge_enabled": True,
            "locked_badge_position": "top-left",
            "lock_method": "pin",
            "pattern_dot_shape": "rounded",
            "pattern_corner_radius": 14,
            "pattern_dot_size": 72,
            "pattern_glass_effect": False,
            "pattern_line_theme_color": False,
            "pattern_line_transparent": False,
            "action_button_glass_effect": False,
            "tap_code_show_outline": True,
            "tap_code_show_dividers": False,
        }

    async def _save_settings(self):
        os.makedirs(os.path.dirname(SETTINGS_FILE), exist_ok=True)
        with open(SETTINGS_FILE, "w") as f:
            json.dump(self.settings, f)

    def _public_settings(self) -> dict:
        # Strips every credential hash from responses to the frontend — hashes should
        # never leave the backend. Replaces each with a boolean indicating whether that
        # method's credential is set.
        result = {
            k: v for k, v in self.settings.items() if k not in ("pin_hash", "password_hash", "pattern_hash", "tap_code_hash")
        }
        result["pin_set"] = bool(self.settings.get("pin_hash", ""))
        result["password_set"] = bool(self.settings.get("password_hash", ""))
        result["pattern_set"] = bool(self.settings.get("pattern_hash", ""))
        result["tap_code_set"] = bool(self.settings.get("tap_code_hash", ""))
        return result

    async def get_settings(self):
        return self._public_settings()

    async def set_global_lock(self, enabled: bool):
        self.settings["global_lock_enabled"] = enabled
        await self._save_settings()
        return self._public_settings()

    async def set_qam_lock(self, enabled: bool):
        self.settings["qam_lock_enabled"] = enabled
        await self._save_settings()
        return self._public_settings()

    async def set_customization(self, updates: dict):
        self.settings.update(updates)
        await self._save_settings()
        return self._public_settings()

    async def reset_all_settings(self):
        # In-plugin equivalent of scripts/reset-decklocker.sh: same backup-then-wipe
        # behavior (erases the lock credential and every lock/customization choice),
        # but applied to the already-running backend's in-memory settings and saved
        # immediately instead of just deleting the file — so it takes effect without
        # needing a plugin_loader restart or a Desktop Mode terminal.
        if os.path.exists(SETTINGS_FILE):
            backup = f"{SETTINGS_FILE}.bak.{datetime.now().strftime('%Y%m%d%H%M%S')}"
            shutil.copy(SETTINGS_FILE, backup)
        self.settings = self._default_settings()
        await self._save_settings()
        return self._public_settings()

    # "lock_method" picks which credential type protects locked content ("pin",
    # "password", "pattern", and "tap_code" are implemented; "controller_code" is
    # reserved for a future method and already round-trips through settings). All four
    # share the same hash-and-compare logic via _set_credential/_check_credential below;
    # adding a new method just needs a settings key plus a one-line set_/check_ pair
    # here (kept separate so each stays independently callable from the frontend), and
    # a matching credential-entry component that reads/writes it based on
    # settings.lock_method.
    #
    # The pattern and tap_code (Knock Code) credentials arrive pre-serialized by the
    # frontend as their node/cell order joined with "-" (e.g. "0-4-8-6-2" for a pattern,
    # "0-0-3-1" for a tap code); the backend just hashes whatever string it's given,
    # same as PIN/password.
    async def _set_credential(self, settings_key: str, value: str):
        self.settings[settings_key] = hashlib.sha256(value.encode()).hexdigest()
        await self._save_settings()
        return True

    def _check_credential(self, settings_key: str, value: str) -> bool:
        guess_hash = hashlib.sha256(value.encode()).hexdigest()
        return guess_hash == self.settings.get(settings_key, "")

    async def set_pin(self, pin: str):
        return await self._set_credential("pin_hash", pin)

    async def check_pin(self, pin: str) -> bool:
        return self._check_credential("pin_hash", pin)

    async def set_password(self, password: str):
        return await self._set_credential("password_hash", password)

    async def check_password(self, password: str) -> bool:
        return self._check_credential("password_hash", password)

    async def set_pattern(self, pattern: str):
        return await self._set_credential("pattern_hash", pattern)

    async def check_pattern(self, pattern: str) -> bool:
        return self._check_credential("pattern_hash", pattern)

    async def set_tap_code(self, code: str):
        return await self._set_credential("tap_code_hash", code)

    async def check_tap_code(self, code: str) -> bool:
        return self._check_credential("tap_code_hash", code)

    async def toggle_app(self, app_id: str, locked: bool):
        locked_apps = set(self.settings.get("locked_apps", []))
        if locked:
            locked_apps.add(app_id)
        else:
            locked_apps.discard(app_id)
        self.settings["locked_apps"] = list(locked_apps)
        await self._save_settings()
        return self.settings["locked_apps"]

    async def toggle_plugin_lock(self, plugin_name: str, locked: bool):
        locked_plugins = set(self.settings.get("locked_plugins", []))
        if locked:
            locked_plugins.add(plugin_name)
        else:
            locked_plugins.discard(plugin_name)
        self.settings["locked_plugins"] = list(locked_plugins)
        await self._save_settings()
        return self.settings["locked_plugins"]

    async def toggle_qam_tab_lock(self, tab_name: str, locked: bool):
        locked_qam_tabs = set(self.settings.get("locked_qam_tabs", []))
        if locked:
            locked_qam_tabs.add(tab_name)
        else:
            locked_qam_tabs.discard(tab_name)
        self.settings["locked_qam_tabs"] = list(locked_qam_tabs)
        await self._save_settings()
        return self.settings["locked_qam_tabs"]

    async def toggle_main_menu_item_lock(self, item_name: str, locked: bool):
        locked_items = set(self.settings.get("locked_main_menu_items", []))
        if locked:
            locked_items.add(item_name)
        else:
            locked_items.discard(item_name)
        self.settings["locked_main_menu_items"] = list(locked_items)
        await self._save_settings()
        return self.settings["locked_main_menu_items"]

    async def get_local_artwork(self, app_id: str) -> str:
        # Returns a data: URI for the best available local cover art, or "" if none found.
        # Search order: custom grid portrait → custom grid square → Steam library cache
        # 600x900 → Steam library cache header.
        candidates = []

        for pattern in USERDATA_GLOBS:
            for grid_dir in glob.glob(pattern):
                for suffix in ("p", ""):
                    for ext in ("png", "jpg", "jpeg"):
                        candidates.append(os.path.join(grid_dir, f"{app_id}{suffix}.{ext}"))

        for cache_dir in LIBRARYCACHE_DIRS:
            candidates.append(os.path.join(cache_dir, f"{app_id}_library_600x900.jpg"))
            candidates.append(os.path.join(cache_dir, f"{app_id}_header.jpg"))

        for path in candidates:
            if os.path.isfile(path):
                mime, _ = mimetypes.guess_type(path)
                mime = mime or "image/jpeg"
                try:
                    with open(path, "rb") as f:
                        encoded = base64.b64encode(f.read()).decode("ascii")
                    return f"data:{mime};base64,{encoded}"
                except OSError as e:
                    decky.logger.warning(f"DeckLocker: failed reading art at {path}: {e}")
                    continue

        return ""

    async def get_local_hero_artwork(self, app_id: str) -> str:
        # Returns a data: URI for the wide hero background image, or "" if none found.
        # Search order: custom grid hero → Steam library cache hero.
        candidates = []

        for pattern in USERDATA_GLOBS:
            for grid_dir in glob.glob(pattern):
                for ext in ("png", "jpg", "jpeg"):
                    candidates.append(os.path.join(grid_dir, f"{app_id}_hero.{ext}"))

        for cache_dir in LIBRARYCACHE_DIRS:
            candidates.append(os.path.join(cache_dir, f"{app_id}_library_hero.jpg"))

        for path in candidates:
            if os.path.isfile(path):
                mime, _ = mimetypes.guess_type(path)
                mime = mime or "image/jpeg"
                try:
                    with open(path, "rb") as f:
                        encoded = base64.b64encode(f.read()).decode("ascii")
                    return f"data:{mime};base64,{encoded}"
                except OSError as e:
                    decky.logger.warning(f"DeckLocker: failed reading hero art at {path}: {e}")
                    continue

        return ""

    async def _main(self):
        await self._load_settings()
        decky.logger.info("DeckLocker backend loaded")

    async def _unload(self):
        decky.logger.info("DeckLocker backend unloaded")
