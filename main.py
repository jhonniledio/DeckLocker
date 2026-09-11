import os
import json
import glob
import base64
import hashlib
import mimetypes
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
            self.settings.setdefault("keypad_circle_shape", False)
            self.settings.setdefault("keypad_glass_effect", False)
            self.settings.setdefault("keypad_on_right", False)
            self.settings.setdefault("relock_on_sleep", False)
            self.settings.setdefault("relock_on_exit", False)
            self.settings.setdefault("decky_panel_lock_enabled", False)
        else:
            self.settings = {
                "global_lock_enabled": False,
                "pin_hash": "",
                "locked_apps": [],
                "qam_lock_enabled": False,
                "keypad_corner_radius": 14,
                "lockscreen_hero_bg_enabled": False,
                "lockscreen_bg_blur_px": 8,
                "lockscreen_bg_opacity_percent": 30,
                "relock_animation_enabled": True,
                "keypad_circle_shape": False,
                "keypad_glass_effect": False,
                "keypad_on_right": False,
                "relock_on_sleep": False,
                "relock_on_exit": False,
                "decky_panel_lock_enabled": False,
            }

    async def _save_settings(self):
        os.makedirs(os.path.dirname(SETTINGS_FILE), exist_ok=True)
        with open(SETTINGS_FILE, "w") as f:
            json.dump(self.settings, f)

    def _public_settings(self) -> dict:
        # Strips pin_hash from all responses to the frontend — the hash should never
        # leave the backend. Replaces it with a boolean indicating whether a PIN is set.
        result = {k: v for k, v in self.settings.items() if k != "pin_hash"}
        result["pin_set"] = bool(self.settings.get("pin_hash", ""))
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

    async def set_pin(self, pin: str):
        self.settings["pin_hash"] = hashlib.sha256(pin.encode()).hexdigest()
        await self._save_settings()
        return True

    async def check_pin(self, pin: str) -> bool:
        guess_hash = hashlib.sha256(pin.encode()).hexdigest()
        return guess_hash == self.settings.get("pin_hash", "")

    async def toggle_app(self, app_id: str, locked: bool):
        locked_apps = set(self.settings.get("locked_apps", []))
        if locked:
            locked_apps.add(app_id)
        else:
            locked_apps.discard(app_id)
        self.settings["locked_apps"] = list(locked_apps)
        await self._save_settings()
        return self.settings["locked_apps"]

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
