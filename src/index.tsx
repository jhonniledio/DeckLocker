import {
  ButtonItem,
  PanelSection,
  PanelSectionRow,
  ToggleField,
  staticClasses,
  ConfirmModal,
  TextField,
  showModal,
  findInReactTree,
  afterPatch,
  createReactTreePatcher,
  Focusable,
  DialogButton,
  Navigation,
  appDetailsClasses,
  gamepadContextMenuClasses,
  footerClasses,
  appActionButtonClasses,
  SliderField,
} from "@decky/ui";
import { callable, definePlugin, routerHook } from "@decky/api";
import { useState, useEffect, useRef, cloneElement, ReactNode, RefObject } from "react";
import { FaLock, FaBackspace, FaLockOpen, FaChevronRight, FaChevronDown, FaTh, FaCheck, FaPalette, FaUndo } from "react-icons/fa";

interface DeckLockerSettings {
  global_lock_enabled: boolean;
  locked_apps: string[];
  pin_set: boolean;
  qam_lock_enabled: boolean;
  keypad_corner_radius: number;
  lockscreen_hero_bg_enabled: boolean;
  lockscreen_bg_blur_px: number;
  lockscreen_bg_opacity_percent: number;
  relock_animation_enabled: boolean;
  keypad_circle_shape: boolean;
  keypad_glass_effect: boolean;
  keypad_on_right: boolean;
  relock_on_sleep: boolean;
  relock_on_exit: boolean;
  decky_panel_lock_enabled: boolean;
}

interface AppInfo {
  appid: string;
  display_name: string;
}

const getSettings = callable<[], DeckLockerSettings>("get_settings");
const setGlobalLock = callable<[enabled: boolean], DeckLockerSettings>("set_global_lock");
const setQamLock = callable<[enabled: boolean], DeckLockerSettings>("set_qam_lock");
const setCustomization = callable<[updates: Partial<DeckLockerSettings>], DeckLockerSettings>("set_customization");
const setPin = callable<[pin: string], boolean>("set_pin");
const checkPin = callable<[pin: string], boolean>("check_pin");
const toggleApp = callable<[app_id: string, locked: boolean], string[]>("toggle_app");
const getLocalArtwork = callable<[app_id: string], string>("get_local_artwork");
const getLocalHeroArtwork = callable<[app_id: string], string>("get_local_hero_artwork");

// Cached after the first fetch so lock checks throughout the session can read
// settings synchronously without an extra IPC round-trip to the Python backend.
let cachedSettings: DeckLockerSettings | null = null;
async function getSettingsCached(): Promise<DeckLockerSettings> {
  const s = await getSettings();
  cachedSettings = s;
  return s;
}

// Games the user has already unlocked this session — skips re-prompting on revisits.
const unlockedThisSession = new Set<string>();
// Games whose post-unlock settling delay has already run — skips the delay on revisits.
const settledThisSession = new Set<string>();

// QAM panel unlock state. Persists across tab switches within the same QAM session
// (Content unmounts/remounts on every tab switch) but resets when the panel closes.
// A timer approximates "panel closed" since there is no direct close event.
let qamUnlockedThisSession = false;
let qamCloseResetTimer: ReturnType<typeof setTimeout> | null = null;

// Decky-panel gate state — true means the next QAM open requires a PIN before showing
// any plugins. Resets to locked each time the QAM closes.
let deckyQamLocked = true;
const deckyQamLockListeners = new Set<() => void>();
function notifyDeckyQamLockChange() {
  deckyQamLockListeners.forEach((fn) => fn());
}

// Returns all installed Steam and non-Steam apps, deduplicated and sorted by name.
function getInstalledApps(): AppInfo[] {
  try {
    const store = (window as any).collectionStore;
    const steamGames = store?.GetCollection?.("type-games")?.allApps ?? [];
    const nonSteamGames = store?.GetCollection?.("desk-desktop-apps")?.allApps ?? [];

    const seen = new Set<string>();
    const result: AppInfo[] = [];
    for (const a of [...steamGames, ...nonSteamGames]) {
      const id = String(a.appid);
      if (seen.has(id)) continue;
      seen.add(id);
      result.push({ appid: id, display_name: a.display_name });
    }

    return result.sort((a, b) => a.display_name.localeCompare(b.display_name));
  } catch (e) {
    console.error("DeckLocker: failed to read installed apps", e);
    return [];
  }
}

// Looks up a display name for an app by ID; falls back to a generic string.
function nameForApp(appid: string): string {
  const app = getInstalledApps().find((a) => a.appid === appid);
  return app?.display_name ?? "this game";
}

// Kills the given app up to four times over 3 seconds. Non-Steam shortcuts often
// need multiple attempts since their wrapper processes may not terminate cleanly
// on the first TerminateApp call.
function terminateAppAggressively(appid: string) {
  const kill = () => {
    try {
      (window as any).SteamClient?.Apps?.TerminateApp?.(appid, true);
    } catch (e) {
      console.error("DeckLocker: TerminateApp failed", e);
    }
  };
  kill();
  setTimeout(kill, 500);
  setTimeout(kill, 1500);
  setTimeout(kill, 3000);
}

// Plays a two-note chime via Web Audio API to confirm a correct PIN entry.
function playUnlockSound() {
  try {
    const AudioCtx = (window as any).AudioContext || (window as any).webkitAudioContext;
    const ctx = new AudioCtx();

    const playNote = (freq: number, startTime: number, duration: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(freq, startTime);
      gain.gain.setValueAtTime(0, startTime);
      gain.gain.linearRampToValueAtTime(0.55, startTime + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(startTime);
      osc.stop(startTime + duration);
    };

    const now = ctx.currentTime;
    playNote(1046.5, now, 0.16);
    playNote(1568, now + 0.13, 0.22);
  } catch (e) {
    console.error("DeckLocker: failed to play unlock sound", e);
  }
}

// Modal for setting or changing the PIN. Requires at least 4 digits and a matching
// confirmation entry before saving.
function SetPinModal({ closeModal, onPinSet }: { closeModal?: () => void; onPinSet?: () => void }) {
  const [pin, setPinValue] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [error, setError] = useState("");

  const onlyDigits = (value: string) => value.replace(/\D/g, "");

  const onConfirm = async () => {
    if (pin.length < 4) {
      setError("PIN must be at least 4 digits");
      return;
    }
    if (pin !== confirmPin) {
      setError("PINs do not match");
      return;
    }
    await setPin(pin);
    onPinSet?.();
    closeModal?.();
  };

  return (
    <ConfirmModal
      strTitle="Set Deck Locker PIN"
      strDescription="Enter a PIN (at least 4 digits) required to launch locked games."
      onOK={onConfirm}
      onCancel={closeModal}
    >
      <TextField
        label="PIN"
        value={pin}
        onChange={(e) => {
          setError("");
          setPinValue(onlyDigits(e.target.value));
        }}
        bIsPassword={true}
      />
      <TextField
        label="Confirm PIN"
        value={confirmPin}
        onChange={(e) => {
          setError("");
          setConfirmPin(onlyDigits(e.target.value));
        }}
        bIsPassword={true}
      />
      {error && <div style={{ color: "#f44336", marginTop: "8px", fontSize: "13px" }}>{error}</div>}
    </ConfirmModal>
  );
}

// Hides Steam's footer button-hint bar for the lifetime of the calling component.
// Used by full-screen overlays so Steam's UI chrome doesn't bleed through during
// PIN entry or re-lock animations.
function useHideSteamFooter(rootRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!rootRef.current) return undefined;
    const realDoc = rootRef.current.ownerDocument;

    const footerClass = footerClasses?.FooterLegend;
    const footerEl = footerClass ? (realDoc.querySelector("." + CSS.escape(footerClass)) as HTMLElement | null) : null;
    const prevFooterDisplay = footerEl?.style.display;
    if (footerEl) footerEl.style.display = "none";

    const basicFooterClass = footerClasses?.BasicFooter;
    const basicFooterEl = basicFooterClass
      ? (realDoc.querySelector("." + CSS.escape(basicFooterClass)) as HTMLElement | null)
      : null;
    const prevBasicFooterDisplay = basicFooterEl?.style.display;
    if (basicFooterEl) basicFooterEl.style.display = "none";

    return () => {
      if (footerEl) footerEl.style.display = prevFooterDisplay ?? "";
      if (basicFooterEl) basicFooterEl.style.display = prevBasicFooterDisplay ?? "";
    };
  }, [rootRef]);
}

// Resolves the wide hero background image for a game, trying the local Steam cache
// first and falling back to the Akamai CDN. Used by PinLockScreen and RelockingOverlay
// when lockscreen_hero_bg_enabled is on.
function useHeroBackground(appid: string) {
  const [heroBgSource, setHeroBgSource] = useState<"cdn" | "local" | "none">("local");
  const [heroBgUri, setHeroBgUri] = useState("");

  useEffect(() => {
    if (!cachedSettings?.lockscreen_hero_bg_enabled) return undefined;
    if (heroBgSource === "local") {
      let cancelled = false;
      (async () => {
        try {
          const localUri = await getLocalHeroArtwork(appid);
          if (!cancelled) {
            if (localUri) setHeroBgUri(localUri);
            else setHeroBgSource("cdn");
          }
        } catch (e) {
          console.error("DeckLocker: local hero artwork lookup failed", e);
          if (!cancelled) setHeroBgSource("cdn");
        }
      })();
      return () => { cancelled = true; };
    } else if (heroBgSource === "cdn") {
      setHeroBgUri(`https://cdn.akamai.steamstatic.com/steam/apps/${appid}/library_hero.jpg`);
      return undefined;
    }
    return undefined;
  }, [appid, heroBgSource]);

  return { heroBgUri, heroBgSource, setHeroBgSource };
}

// Full-screen PIN entry overlay shown in place of the real game page while locked.
// Left panel: PIN dot display and 3×4 numeric keypad.
// Right panel: game cover art with a local → CDN fallback chain, plus game title.
function PinLockScreen({
  appid,
  appName,
  closeModal,
  onUnlocked,
  settling,
  onDismiss,
  mode = "game",
}: {
  appid: string;
  appName: string;
  closeModal?: () => void;
  onUnlocked?: () => void;
  settling?: boolean;
  onDismiss?: () => void;
  mode?: "game" | "system";
}) {
  const [digits, setDigits] = useState<string[]>([]);
  const [focusedKeyKey, setFocusedKeyKey] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useHideSteamFooter(rootRef);

  const [error, setError] = useState("");
  const [pinStatus, setPinStatus] = useState<"neutral" | "correct" | "incorrect">("neutral");
  const [checking, setChecking] = useState(false);
  const [artSource, setArtSource] = useState<"capsule" | "header" | "local" | "none">("local");
  const [localArtUri, setLocalArtUri] = useState("");
  const [imgLoaded, setImgLoaded] = useState(false);
  const [lockOpen, setLockOpen] = useState(false);
  const { heroBgUri, heroBgSource, setHeroBgSource } = useHeroBackground(appid);

  // During the settling window, switches the lock icon from closed to open after
  // a short delay as visual confirmation that the PIN was accepted.
  useEffect(() => {
    if (!settling) {
      setLockOpen(false);
      return;
    }
    const timer = setTimeout(() => setLockOpen(true), 500);
    return () => clearTimeout(timer);
  }, [settling]);

  // Loads game cover art from the local Steam cache first; falls back to CDN.
  useEffect(() => {
    if (artSource !== "local") return;
    let cancelled = false;
    (async () => {
      const uri = await getLocalArtwork(appid);
      if (!cancelled) {
        if (uri) setLocalArtUri(uri);
        else setArtSource("capsule");
      }
    })();
    return () => { cancelled = true; };
  }, [artSource, appid]);

  const press = (d: string) => {
    if (checking || pinStatus === "incorrect") return;
    setError("");
    setDigits((prev) => (prev.length >= 8 ? prev : [...prev, d]));
  };

  const backspace = () => {
    if (checking || pinStatus === "incorrect") return;
    setError("");
    setDigits((prev) => prev.slice(0, -1));
  };

  const onOk = async () => {
    if (digits.length === 0 || checking || pinStatus === "incorrect") return;
    setChecking(true);
    const ok = await checkPin(digits.join(""));
    setChecking(false);
    if (ok) {
      playUnlockSound();
      if (appid) unlockedThisSession.add(appid);
      setPinStatus("correct");
      onUnlocked?.();
      closeModal?.();
      onDismiss?.();
    } else {
      setError("Incorrect PIN");
      setPinStatus("incorrect");
      setTimeout(() => {
        setPinStatus("neutral");
        setError("");
        setDigits([]);
      }, 2000);
    }
  };

  const onCancel = () => {
    if (mode !== "system") {
      terminateAppAggressively(appid);
      closeModal?.();
      onDismiss?.();
      Navigation.NavigateBack();
    }
    // In system mode, cancel is a no-op — user must enter the correct PIN or
    // physically close the QAM to exit.
  };

  // Acts as Delete while digits are entered; becomes Cancel in game mode or a
  // no-op lock icon in system mode when the field is empty.
  const onBottomLeftKey = () => {
    if (digits.length > 0) {
      backspace();
    } else if (mode !== "system") {
      onCancel();
    }
  };

  const glassEffect = cachedSettings?.keypad_glass_effect ?? false;
  const keypadOnRight = cachedSettings?.keypad_on_right ?? false;
  // Shared background applied to keypad cells and the art placeholder so they match visually.
  const panelBg = glassEffect
    ? {
        background: "rgba(255,255,255,0.14)",
        backdropFilter: "blur(24px) saturate(180%)",
        WebkitBackdropFilter: "blur(24px) saturate(180%)",
        border: "1px solid rgba(255,255,255,0.25)",
        boxShadow: "inset 0 1px 1px rgba(255,255,255,0.3)",
      }
    : { background: "rgba(255,255,255,0.06)" };

  // Circle shape forces cells square so borderRadius:50% produces true circles,
  // bypassing the corner-radius slider.
  const circleShape = cachedSettings?.keypad_circle_shape ?? false;

  // Controller mapping: A = select (Focusable default), B = Delete/Cancel, X = OK.
  const keypadButtons: { key: string; label: string | ReactNode; hint?: string; onClick: () => void; fontSize: string }[] = [
    { key: "1", label: "1", onClick: () => press("1"), fontSize: "22px" },
    { key: "2", label: "2", onClick: () => press("2"), fontSize: "22px" },
    { key: "3", label: "3", onClick: () => press("3"), fontSize: "22px" },
    { key: "4", label: "4", onClick: () => press("4"), fontSize: "22px" },
    { key: "5", label: "5", onClick: () => press("5"), fontSize: "22px" },
    { key: "6", label: "6", onClick: () => press("6"), fontSize: "22px" },
    { key: "7", label: "7", onClick: () => press("7"), fontSize: "22px" },
    { key: "8", label: "8", onClick: () => press("8"), fontSize: "22px" },
    { key: "9", label: "9", onClick: () => press("9"), fontSize: "22px" },
    {
      key: "bottomleft",
      label: digits.length > 0 ? <FaBackspace size={20} /> : (mode === "system" ? <FaLock size={16} /> : "CANCEL"),
      hint: (mode !== "system" || digits.length > 0) ? "B" : undefined,
      onClick: onBottomLeftKey,
      fontSize: "14px",
    },
    { key: "0", label: "0", onClick: () => press("0"), fontSize: "22px" },
    { key: "ok", label: "OK", hint: "X", onClick: onOk, fontSize: "14px" },
  ];

  return (
    <div
      ref={rootRef}
      style={{
        position: "fixed",
        inset: 0,
        background: "#0e1114",
        zIndex: 999999,
        display: "flex",
        flexDirection: mode === "system" ? "column" : (keypadOnRight ? "row-reverse" : "row"),
        alignItems: mode === "system" ? "center" : undefined,
        justifyContent: mode === "system" ? "center" : undefined,
        color: "#fff",
      }}
    >
      {/* Keyframe definitions for the lock-pop unlock animation and the incorrect-PIN shake. */}
      <style>{`
        @keyframes decklocker-pop {
          0% { transform: scale(0.6) rotate(-15deg); opacity: 0.4; }
          60% { transform: scale(1.25) rotate(6deg); opacity: 1; }
          100% { transform: scale(1) rotate(0deg); opacity: 1; }
        }
        @keyframes decklocker-shake {
          0%, 100% { transform: translateX(0); }
          20% { transform: translateX(-6px); }
          40% { transform: translateX(6px); }
          60% { transform: translateX(-4px); }
          80% { transform: translateX(4px); }
        }
      `}</style>

      {/* Optional hero art background placed behind both panels, blurred and dimmed per settings. */}
      {mode !== "system" && cachedSettings?.lockscreen_hero_bg_enabled && heroBgUri && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            backgroundImage: `url(${heroBgUri})`,
            backgroundSize: "cover",
            backgroundPosition: "center",
            filter: `blur(${cachedSettings.lockscreen_bg_blur_px}px)`,
            opacity: (cachedSettings.lockscreen_bg_opacity_percent ?? 30) / 100,
            zIndex: 0,
          }}
        />
      )}
      {/* Hidden probe image used to detect CDN failures; background-image has no onError of its own. */}
      {mode !== "system" && cachedSettings?.lockscreen_hero_bg_enabled && heroBgSource === "cdn" && (
        <img
          src={`https://cdn.akamai.steamstatic.com/steam/apps/${appid}/library_hero.jpg`}
          onError={() => setHeroBgSource("none")}
          style={{ display: "none" }}
        />
      )}

      {/* System-mode header: lock icon + title + instruction shown above keypad. */}
      {mode === "system" && (
        <div style={{ textAlign: "center", marginBottom: "24px", zIndex: 1 }}>
          <FaLock size={36} style={{ opacity: 0.9 }} />
          <div style={{ fontSize: "20px", fontWeight: 700, marginTop: "10px" }}>Deck Locker</div>
          <div style={{ fontSize: "13px", opacity: 0.55, marginTop: "4px" }}>Enter PIN to access plugins</div>
        </div>
      )}

      {/* Left panel: status text, PIN dot indicator, and numeric keypad grid. */}
      <div
        style={{
          width: mode === "system" ? "auto" : "50%",
          minWidth: 0,
          boxSizing: "border-box",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px",
          position: "relative",
          zIndex: 1,
        }}
      >
        <div
          style={{
            marginBottom: "16px",
            opacity: 0.8,
            minHeight: "20px",
            fontSize: "16px",
            display: "flex",
            alignItems: "center",
            gap: "8px",
          }}
        >
          {settling ? (
            <>
              <span>Unlocking...</span>
              <span
                key={lockOpen ? "open" : "closed"}
                style={{ display: "inline-flex", animation: "decklocker-pop 0.35s ease-out" }}
              >
                {lockOpen ? <FaLockOpen size={16} /> : <FaLock size={16} />}
              </span>
            </>
          ) : (
            error || "Enter PIN"
          )}
        </div>

        <div
          style={{
            display: "flex",
            gap: "10px",
            marginBottom: "24px",
            minHeight: "16px",
            animation: pinStatus === "incorrect" ? "decklocker-shake 0.4s ease-in-out" : undefined,
          }}
        >
          {digits.length === 0 && <div style={{ width: "14px", height: "14px" }} />}
          {digits.map((_, i) => (
            <div
              key={i}
              style={{
                width: "14px",
                height: "14px",
                borderRadius: "50%",
                background: pinStatus === "correct" ? "#4caf50" : pinStatus === "incorrect" ? "#f44336" : "#fff",
              }}
            />
          ))}
        </div>

        {/* Single flat Focusable grid so Steam's spatial nav moves between keys
            correctly without jumping to the first item of the next row. */}
        <Focusable
          onCancelButton={onBottomLeftKey}
          onSecondaryButton={onOk}
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 92px)",
            gridAutoRows: "72px",
            gap: "14px",
            justifyItems: "center",
            alignItems: "center",
          }}
        >
          {keypadButtons.map((btn) => (
            <div
              key={btn.key}
              style={{
                width: circleShape ? "72px" : "92px",
                height: "72px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                overflow: "hidden",
                boxSizing: "border-box",
                borderRadius: circleShape ? "50%" : `${cachedSettings?.keypad_corner_radius ?? 14}px`,
                ...panelBg,
              }}
            >
              <Focusable
                onGamepadFocus={() => setFocusedKeyKey(btn.key)}
                onGamepadBlur={() => setFocusedKeyKey((prev) => (prev === btn.key ? null : prev))}
                style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}
              >
                <DialogButton
                  onClick={btn.onClick}
                  style={{
                    width: "100%",
                    height: "100%",
                    boxSizing: "border-box",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: "0px",
                    // Focused: white highlight. Unfocused with glass: transparent so the
                    // blurred cell background shows through instead of the native focus style.
                    ...(focusedKeyKey === btn.key
                      ? { background: "rgba(255,255,255,0.7)" }
                      : glassEffect
                      ? { background: "transparent" }
                      : {}),
                  }}
                >
                  <span
                    style={{
                      fontSize: btn.fontSize,
                      lineHeight: "22px",
                      height: "22px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    {btn.label}
                  </span>
                  {btn.hint && (
                    <span
                      style={{
                        width: "11px",
                        height: "11px",
                        borderRadius: "50%",
                        background: "#fff",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: "8px",
                        lineHeight: "1",
                        color: "#000",
                        fontWeight: "bold",
                        flexShrink: 0,
                      }}
                    >
                      {btn.hint}
                    </span>
                  )}
                </DialogButton>
              </Focusable>
            </div>
          ))}
        </Focusable>
      </div>

      {/* Right panel: game cover art (local → capsule CDN → header CDN) and title. */}
      {mode !== "system" && <div
        style={{
          width: "50%",
          minWidth: 0,
          boxSizing: "border-box",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px",
          background: cachedSettings?.lockscreen_hero_bg_enabled ? "transparent" : "#161a1f",
          position: "relative",
          zIndex: 1,
        }}
      >
        <div
          style={{
            position: "relative",
            marginBottom: "16px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: "260px",
            height: "390px",
            border: !imgLoaded ? "2px solid rgba(255,255,255,0.15)" : "none",
            borderRadius: "12px",
            boxSizing: "border-box",
            ...(!imgLoaded ? panelBg : {}),
          }}
        >
          {artSource !== "none" && !imgLoaded && (
            <FaLock size={64} style={{ position: "absolute", opacity: 0.3 }} />
          )}
          {artSource === "local" && localArtUri && (
            <img
              src={localArtUri}
              onLoad={() => setImgLoaded(true)}
              onError={() => { setImgLoaded(false); setArtSource("capsule"); }}
              style={{ maxWidth: "280px", maxHeight: "390px", width: "auto", height: "auto", objectFit: "contain", borderRadius: "12px", opacity: imgLoaded ? 1 : 0, transition: "opacity 0.2s" }}
            />
          )}
          {artSource === "capsule" && (
            <img
              src={`https://cdn.akamai.steamstatic.com/steam/apps/${appid}/library_600x900.jpg`}
              onLoad={() => setImgLoaded(true)}
              onError={() => { setImgLoaded(false); setArtSource("header"); }}
              style={{ maxWidth: "260px", maxHeight: "390px", width: "auto", height: "auto", objectFit: "contain", borderRadius: "12px", opacity: imgLoaded ? 1 : 0, transition: "opacity 0.2s" }}
            />
          )}
          {artSource === "header" && (
            <img
              src={`https://cdn.akamai.steamstatic.com/steam/apps/${appid}/header.jpg`}
              onLoad={() => setImgLoaded(true)}
              onError={() => { setImgLoaded(false); setArtSource("none"); }}
              style={{ maxWidth: "320px", maxHeight: "220px", width: "auto", height: "auto", objectFit: "contain", borderRadius: "8px", opacity: imgLoaded ? 1 : 0, transition: "opacity 0.2s" }}
            />
          )}
          {artSource === "none" && <FaLock size={64} />}
        </div>

        <div style={{ fontSize: "22px", fontWeight: 600, textAlign: "center" }}>{appName}</div>
      </div>}
    </div>
  );
}

// Minimal pub/sub so LockedPageGate (invisible gate) and InlineLockRow (visible button)
// can share unlock state without being the same component instance.
const unlockListeners = new Map<string, Set<() => void>>();
function notifyUnlockChange(appId: string) {
  unlockListeners.get(appId)?.forEach((fn) => fn());
}
function useUnlockedThisSession(appId: string): boolean {
  const [unlocked, setUnlocked] = useState(unlockedThisSession.has(appId));
  useEffect(() => {
    const listener = () => setUnlocked(unlockedThisSession.has(appId));
    if (!unlockListeners.has(appId)) unlockListeners.set(appId, new Set());
    unlockListeners.get(appId)!.add(listener);
    listener();
    return () => { unlockListeners.get(appId)?.delete(listener); };
  }, [appId]);
  return unlocked;
}

// Global component that blocks access to all Decky plugins until a PIN is entered.
// Activated when decky_panel_lock_enabled is on and the QAM opens. Registers for
// QAM visibility so it shows the gate on open and re-locks on close.
function GlobalDeckyQamGate() {
  const [gateActive, setGateActive] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // Show gate when QAM opens (if decky_panel_lock_enabled + pin_set + still locked).
    // Re-lock and hide gate when QAM closes.
    let qamHook: any;
    const handleQamVisible = (open: boolean) => {
      if (open) {
        getSettingsCached().then((s) => {
          if (s.decky_panel_lock_enabled && s.pin_set && deckyQamLocked) {
            setGateActive(true);
          }
        }).catch(() => {});
      } else {
        setGateActive(false);
        setTimeout(() => {
          if (cachedSettings?.decky_panel_lock_enabled) {
            deckyQamLocked = true;
          }
        }, 400);
      }
    };
    const qamApis = ["RegisterForQuickAccessMenuVisible", "RegisterForQuickAccessMenuVisibilityChange"];
    for (const apiName of qamApis) {
      try {
        const fn = (window as any).SteamClient?.UI?.[apiName];
        if (typeof fn === "function") {
          qamHook = fn.call((window as any).SteamClient.UI, handleQamVisible);
          console.log("DeckLocker: registered QAM hook via SteamClient.UI." + apiName);
          break;
        }
      } catch (e) {
        console.warn("DeckLocker: SteamClient.UI." + apiName + " failed:", e);
      }
    }
    if (!qamHook) {
      console.error("DeckLocker: no QAM visibility hook could be registered");
    }

    // Hide gate when unlock succeeds (notifyDeckyQamLockChange fires the listener).
    const onLockChange = () => {
      if (!deckyQamLocked) setGateActive(false);
    };
    deckyQamLockListeners.add(onLockChange);

    return () => {
      qamHook?.unregister?.();
      deckyQamLockListeners.delete(onLockChange);
    };
  }, []);

  if (!gateActive) return <div ref={ref} style={{ display: "none" }} />;

  return (
    <PinLockScreen
      appid=""
      appName="Deck Locker"
      mode="system"
      onUnlocked={() => {
        deckyQamLocked = false;
        notifyDeckyQamLockChange();
      }}
    />
  );
}

// Invisible global component (mounted via routerHook.addGlobalComponent) that guards
// two context-menu bypass vectors:
//   1. Hides the "Options" footer hint when a locked game tile is focused, preventing
//      the context menu (which has "Play" as its first item) from being opened at all.
//   2. Intercepts context menus that do open for locked games and shows the PIN screen
//      while dismissing the menu through its own Cancel handler.
function GlobalMenuWatcher() {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const realDoc = ref.current.ownerDocument;
    if (!realDoc) return;

    let hiddenOptionsEl: any = null;
    let lastFocusedTileEl: any = null;

    const restoreOptionsHint = () => {
      if (hiddenOptionsEl) {
        hiddenOptionsEl.style.display = "";
        hiddenOptionsEl = null;
      }
    };

    const onFocusChange = async () => {
      const el = realDoc.activeElement as any;
      if (!el) return;

      // Walk the React fiber tree to extract the appid from the focused element.
      let appidFromFiber: string | null = null;
      try {
        const fk = Object.keys(el).find((k: string) => k.startsWith("__reactFiber$"));
        let fiberNode: any = fk ? el[fk] : null;
        let depth = 0;
        while (fiberNode && depth < 30 && !appidFromFiber) {
          const props = fiberNode.memoizedProps || fiberNode.pendingProps;
          if (props?.overview?.appid !== undefined) appidFromFiber = String(props.overview.appid);
          else if (props?.appid !== undefined) appidFromFiber = String(props.appid);
          else if (props?.app?.appid !== undefined) appidFromFiber = String(props.app.appid);
          fiberNode = fiberNode.return;
          depth++;
        }
      } catch (e) {
        console.error("DeckLocker: fiber appid walk failed", e);
      }

      // When the real Play button gains focus on an already-unlocked game's page,
      // re-notify so InlineLockRow gets another render opportunity to appear.
      try {
        const playClass = appActionButtonClasses?.PlayButtonContainer;
        const isPlayButton = playClass ? !!el.closest?.("." + CSS.escape(playClass)) : false;
        if (isPlayButton && appidFromFiber && unlockedThisSession.has(appidFromFiber)) {
          notifyUnlockChange(appidFromFiber);
        }
      } catch (e) {
        console.error("DeckLocker: play-button-focus re-notify failed", e);
      }

      if (!appidFromFiber) {
        restoreOptionsHint();
        return;
      }

      lastFocusedTileEl = el;
      try {
        const settings = await getSettingsCached();
        const isLocked =
          settings.global_lock_enabled &&
          settings.locked_apps.includes(appidFromFiber) &&
          !unlockedThisSession.has(appidFromFiber);

        if (!isLocked) {
          restoreOptionsHint();
          return;
        }

        const legendClass = footerClasses?.FooterLegend;
        const footerEl = legendClass ? realDoc.querySelector("." + CSS.escape(legendClass)) : null;
        const optionsEl = footerEl
          ? Array.from((footerEl as any).children || []).find(
              (c: any) => c.textContent?.trim() === "Options"
            )
          : null;

        if (optionsEl && optionsEl !== hiddenOptionsEl) {
          restoreOptionsHint();
          (optionsEl as any).style.display = "none";
          hiddenOptionsEl = optionsEl;
        }
      } catch (e) {
        console.error("DeckLocker: options-hint toggle failed", e);
      }
    };
    realDoc.addEventListener("focus", onFocusChange, true);
    realDoc.addEventListener("focusin", onFocusChange, true);

    const menuClass = gamepadContextMenuClasses?.BasicContextMenuModal;
    const menuContainerClass = gamepadContextMenuClasses?.BasicContextMenuContainer;

    const nodeMatchesMenu = (node: any): Element | null => {
      if (!node || node.nodeType !== 1) return null;
      const cls = node.className;
      if (
        typeof cls === "string" &&
        ((menuClass && cls.split(/\s+/).includes(menuClass)) ||
          (menuContainerClass && cls.split(/\s+/).includes(menuContainerClass)))
      ) {
        return node;
      }
      if (node.querySelector && (menuClass || menuContainerClass)) {
        try {
          const sel = [menuClass, menuContainerClass]
            .filter(Boolean)
            .map((c) => "." + CSS.escape(c as string))
            .join(",");
          const found = node.querySelector(sel);
          if (found) return found;
        } catch (e) {
          // ignore selector build errors
        }
      }
      return null;
    };

    let blockInFlight = false;

    // MutationObserver that intercepts context menus as they are added to the DOM.
    // The menu's header text (the game's display name) is used to identify which
    // game it belongs to — more reliable than trying to extract an appid from this
    // menu's React fiber tree.
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const added of Array.from(m.addedNodes)) {
          const match = nodeMatchesMenu(added);
          if (match && !blockInFlight) {
            const gameNameText = (match as any).children?.[0]?.textContent?.trim();
            const matchedApp = getInstalledApps().find((a) => a.display_name === gameNameText);
            if (!matchedApp) continue;

            blockInFlight = true;
            (async () => {
              try {
                const settings = await getSettingsCached();
                const isLocked =
                  settings.global_lock_enabled &&
                  settings.locked_apps.includes(matchedApp.appid) &&
                  !unlockedThisSession.has(matchedApp.appid);
                if (isLocked) {
                  let contentAncestor: HTMLElement | null = null;
                  let walk: any = (match as any).parentElement;
                  for (let i = 0; i < 8 && walk; i++) {
                    const cls = typeof walk.className === "string" ? walk.className : "";
                    if (cls.includes("ModalOverlayContent")) {
                      contentAncestor = walk;
                      break;
                    }
                    walk = walk.parentElement;
                  }
                  const toHide = contentAncestor || (match as any);

                  const titleEl = (match as any).children?.[0] as HTMLElement | undefined;
                  if (titleEl) titleEl.style.display = "none";

                  showModal(
                    <PinLockScreen
                      appid={matchedApp.appid}
                      appName={matchedApp.display_name}
                      onUnlocked={() => notifyUnlockChange(matchedApp.appid)}
                      onDismiss={() => lastFocusedTileEl?.focus?.()}
                    />
                  );

                  // SECURITY-CRITICAL — DO NOT REMOVE.
                  // Hiding the menu title above is purely visual. Steam's gamepad nav
                  // still treats the menu as open with "Play" as the focused item —
                  // pressing X while the menu is hidden would launch the locked game
                  // and bypass the PIN entirely. This click fires the menu's own Cancel
                  // handler through React's normal flow (direct DOM removal crashes
                  // React reconciliation). Fired after the lock screen is shown so any
                  // resulting menu re-render happens behind the overlay.
                  setTimeout(() => {
                    try {
                      const allItems = Array.from(toHide.querySelectorAll("*"));
                      const cancelItem = allItems.find(
                        (n: any) => n.children?.length === 0 && n.textContent?.trim().toLowerCase() === "cancel"
                      ) as HTMLElement | undefined;
                      if (cancelItem) {
                        const clickable = (cancelItem.closest('[role="button"]') as HTMLElement) || cancelItem;
                        clickable.click();
                      }
                    } catch (e) {
                      console.error("DeckLocker: cancel-item click attempt failed", e);
                    }
                  }, 100);
                }
              } catch (e) {
                console.error("DeckLocker: context-menu block failed", e);
              } finally {
                setTimeout(() => { blockInFlight = false; }, 500);
              }
            })();
          }
        }
      }
    });
    observer.observe(realDoc.body, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      realDoc.removeEventListener("focus", onFocusChange, true);
      realDoc.removeEventListener("focusin", onFocusChange, true);
      restoreOptionsHint();
    };
  }, []);

  return <div ref={ref} style={{ display: "none" }} />;
}

// Route-level gate component that renders the PIN screen instead of the real game
// page while the game is locked and not yet unlocked this session. After the PIN is
// accepted, waits 1.5s (the settling window) before revealing real content, mounting
// it invisibly underneath during that window so it can pre-render off-screen.
function LockedPageGate({ appId, children }: { appId: string; children: any }) {
  const [lockable, setLockable] = useState<boolean | null>(() => {
    if (cachedSettings) {
      return cachedSettings.global_lock_enabled && cachedSettings.locked_apps.includes(appId);
    }
    return null; // unknown until the first settings fetch resolves
  });
  const unlocked = useUnlockedThisSession(appId);
  const [settled, setSettled] = useState(() => settledThisSession.has(appId));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const settings = await getSettingsCached();
      if (!cancelled) {
        setLockable(settings.global_lock_enabled && settings.locked_apps.includes(appId));
      }
    })();
    return () => { cancelled = true; };
  }, [appId]);

  useEffect(() => {
    if (!unlocked) {
      setSettled(false);
      return;
    }
    if (settledThisSession.has(appId)) {
      setSettled(true);
      return;
    }
    const timer = setTimeout(() => {
      settledThisSession.add(appId);
      setSettled(true);
    }, 1500);
    return () => clearTimeout(timer);
  }, [unlocked, appId]);

  // When the user navigates away from the game page, re-lock if relock_on_exit is on.
  useEffect(() => {
    return () => {
      if (cachedSettings?.relock_on_exit && unlockedThisSession.has(appId)) {
        unlockedThisSession.delete(appId);
        settledThisSession.delete(appId);
        notifyUnlockChange(appId);
      }
    };
  }, [appId]);

  // Lock state not yet known — render nothing rather than risk showing the real page
  // before confirming it is safe to do so.
  if (lockable === null) {
    return null;
  }

  if (lockable && !unlocked) {
    return (
      <PinLockScreen
        appid={appId}
        appName={nameForApp(appId)}
        onUnlocked={() => notifyUnlockChange(appId)}
      />
    );
  }

  if (lockable && unlocked && !settled) {
    // PIN accepted, settling: keep the PIN screen visible while the real content
    // mounts and pre-renders invisibly underneath it.
    return (
      <>
        <PinLockScreen
          appid={appId}
          appName={nameForApp(appId)}
          onUnlocked={() => notifyUnlockChange(appId)}
          settling
        />
        <div style={{ position: "absolute", inset: 0, opacity: 0, pointerEvents: "none", zIndex: -1 }}>
          {children}
        </div>
      </>
    );
  }

  return children;
}

// Brief transitional overlay shown when the user manually re-locks a game from the
// game page. Animates a lock icon from open to closed before navigating back.
function RelockingOverlay({
  appId,
  onComplete,
  closeModal,
}: {
  appId: string;
  onComplete: () => void;
  closeModal?: () => void;
}) {
  const [locked, setLocked] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useHideSteamFooter(rootRef);
  const { heroBgUri, heroBgSource, setHeroBgSource } = useHeroBackground(appId);

  useEffect(() => {
    const popTimer = setTimeout(() => setLocked(true), 400);
    const doneTimer = setTimeout(() => { onComplete(); }, 900);
    // Delayed close ensures the navigation finishes before this overlay is removed,
    // avoiding a brief flash of the underlying re-locked page's PIN screen.
    const closeTimer = setTimeout(() => { closeModal?.(); }, 1300);
    return () => {
      clearTimeout(popTimer);
      clearTimeout(doneTimer);
      clearTimeout(closeTimer);
    };
  }, []);

  return (
    <div
      ref={rootRef}
      style={{
        position: "fixed",
        inset: 0,
        background: "#0e1114",
        zIndex: 999999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#fff",
        flexDirection: "column",
        gap: "12px",
      }}
    >
      <style>{`
        @keyframes decklocker-pop {
          0% { transform: scale(0.6) rotate(-15deg); opacity: 0.4; }
          60% { transform: scale(1.25) rotate(6deg); opacity: 1; }
          100% { transform: scale(1) rotate(0deg); opacity: 1; }
        }
      `}</style>

      {/* Same hero background as PinLockScreen so the re-lock animation blends seamlessly. */}
      {cachedSettings?.lockscreen_hero_bg_enabled && heroBgUri && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            backgroundImage: `url(${heroBgUri})`,
            backgroundSize: "cover",
            backgroundPosition: "center",
            filter: `blur(${cachedSettings.lockscreen_bg_blur_px}px)`,
            opacity: (cachedSettings.lockscreen_bg_opacity_percent ?? 30) / 100,
            zIndex: 0,
          }}
        />
      )}
      {cachedSettings?.lockscreen_hero_bg_enabled && heroBgSource === "cdn" && (
        <img
          src={`https://cdn.akamai.steamstatic.com/steam/apps/${appId}/library_hero.jpg`}
          onError={() => setHeroBgSource("none")}
          style={{ display: "none" }}
        />
      )}

      <span
        key={locked ? "locked" : "unlocked"}
        style={{ display: "inline-flex", animation: "decklocker-pop 0.35s ease-out" }}
      >
        {locked ? <FaLock size={48} /> : <FaLockOpen size={48} />}
      </span>
      <div style={{ fontSize: "16px", opacity: 0.8 }}>Locked</div>
    </div>
  );
}

// Lock button spliced into the game page's play-controls row. Only visible when the
// game is locked and has already been unlocked this session. Clicking it re-locks
// the game and navigates back to the library.
function InlineLockRow({ appId }: { appId: string }) {
  const [lockable, setLockable] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const unlocked = useUnlockedThisSession(appId);

  // DialogButton ignores height:100% via React's style prop — style.setProperty with
  // "important" is required to beat its internal stylesheet rule. Re-applied whenever
  // lock/unlock state changes and the button (re)appears.
  useEffect(() => {
    if (!wrapperRef.current) return;
    try {
      const wrapperHeightPx =
        wrapperRef.current.parentElement?.getBoundingClientRect().height ||
        wrapperRef.current.getBoundingClientRect().height;

      const focusableEl = wrapperRef.current.firstElementChild as HTMLElement | null;
      if (focusableEl) {
        focusableEl.style.setProperty("height", `${wrapperHeightPx}px`, "important");
        focusableEl.style.setProperty("margin", "0", "important");
        focusableEl.style.setProperty("padding", "0", "important");
        focusableEl.style.setProperty("top", "0", "important");
        focusableEl.style.setProperty("display", "flex", "important");
        focusableEl.style.setProperty("align-items", "center", "important");
      }

      const dialogButtonEl = wrapperRef.current.querySelector('[role="button"]') || wrapperRef.current.firstElementChild;
      if (dialogButtonEl) {
        const el = dialogButtonEl as HTMLElement;
        el.style.setProperty("height", `${wrapperHeightPx}px`, "important");
        el.style.setProperty("min-height", `${wrapperHeightPx}px`, "important");
        el.style.setProperty("max-height", `${wrapperHeightPx}px`, "important");
        el.style.setProperty("box-sizing", "border-box", "important");
        el.style.setProperty("margin", "0", "important");
        el.style.setProperty("display", "flex", "important");
        el.style.setProperty("align-items", "center", "important");
        el.style.setProperty("justify-content", "center", "important");
      }

      wrapperRef.current.style.setProperty("height", `${wrapperHeightPx}px`, "important");
    } catch (e) {
      console.error("DeckLocker: InlineLockRow sizing fix failed", e);
    }
  }, [lockable, unlocked]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const settings = await getSettingsCached();
      if (!cancelled) {
        setLockable(settings.global_lock_enabled && settings.locked_apps.includes(appId));
      }
    })();
    return () => { cancelled = true; };
  }, [appId]);

  const onRelock = () => {
    if (cachedSettings?.relock_animation_enabled === false) {
      unlockedThisSession.delete(appId);
      settledThisSession.delete(appId);
      notifyUnlockChange(appId);
      Navigation.NavigateBack();
      return;
    }
    showModal(
      <RelockingOverlay
        appId={appId}
        onComplete={() => {
          unlockedThisSession.delete(appId);
          settledThisSession.delete(appId);
          notifyUnlockChange(appId);
          Navigation.NavigateBack();
        }}
      />
    );
  };

  if (!lockable || !unlocked) return null;

  return (
    <div style={{ display: "flex", alignItems: "center", position: "relative", zIndex: 999, flexShrink: 0 }}>
      <div ref={wrapperRef} style={{ width: "50px", height: "44px", overflow: "hidden", display: "flex", position: "relative" }}>
        <Focusable
          onOKActionDescription="Lock"
          onGamepadFocus={() => setIsFocused(true)}
          onGamepadBlur={() => setIsFocused(false)}
          style={{ width: "100%", height: "100%" }}
        >
          <DialogButton
            onClick={onRelock}
            style={{
              width: "100%",
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: "0",
              padding: "0",
              boxSizing: "border-box",
              minHeight: "100%",
              maxHeight: "100%",
            }}
          />
        </Focusable>

        {/* Lock icon as an absolute overlay, decoupled from DialogButton's internal
            content layout to avoid the invisible-icon issue when placed as children. */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
          }}
        >
          <FaLock size={16} color={isFocused ? "#000000" : "#ffffff"} />
        </div>
      </div>
    </div>
  );
}

// Patches the /library/app/:appid route to wrap the page in LockedPageGate and
// splice InlineLockRow into the play-controls row by walking Steam's internal React
// component tree. Tied to Steam's current UI build — will silently no-op (not break)
// if Steam updates and the tree walk no longer finds its target.
function patchAppPage() {
  return routerHook.addPatch("/library/app/:appid", (routeTree: any) => {
    const routeProps = findInReactTree(routeTree, (x: any) => x?.renderFunc);
    if (routeProps) {
      let appId = "";
      const patchHandler = createReactTreePatcher(
        [
          (tree: any) => {
            const children = findInReactTree(tree, (x: any) => x?.props?.children?.props?.overview)?.props
              ?.children;
            if (!children) return null;
            appId = String(children.props.overview.appid);
            return children;
          },
        ],
        (_: any, ret: any) => {
          if (!ret || !appId) return ret;
          const keyedRet = ret.key != null ? ret : cloneElement(ret, { key: "decklocker-original" });

          try {
            // Wraps a component's render/function so we can inspect and optionally
            // replace its output. Guards against patching the same component twice.
            const patchOneComponent = (
              node: any,
              onResult: (result: any) => any
            ) => {
              const t = node?.type;
              if (!t) return;

              const runAndMaybeReplace = (original: any) =>
                function (this: any, ...args: any[]) {
                  const result = original.apply(this, args);
                  try {
                    const replacement = onResult(result);
                    return replacement !== undefined ? replacement : result;
                  } catch (e) {
                    console.error("DeckLocker: play-row patch error", e);
                    return result;
                  }
                };

              if (typeof t === "function") {
                const isClassComponent = !!(t.prototype && t.prototype.isReactComponent);
                if (isClassComponent) {
                  if ((t.prototype as any).__decklockerPatched) return;
                  (t.prototype as any).__decklockerPatched = true;
                  t.prototype.render = runAndMaybeReplace(t.prototype.render);
                } else {
                  if ((t as any).__decklockerWrapped) return;
                  const wrapped = runAndMaybeReplace(t);
                  (wrapped as any).__decklockerWrapped = true;
                  node.type = wrapped;
                }
              } else if (typeof t === "object" && (t.type || t.render)) {
                if ((t as any).__decklockerPatched) return;
                (t as any).__decklockerPatched = true;
                const isMemo = !!t.type;
                const inner = isMemo ? t.type : t.render;
                const isInnerClass = !!(inner?.prototype && inner.prototype.isReactComponent);
                if (isInnerClass) {
                  inner.prototype.render = runAndMaybeReplace(inner.prototype.render);
                } else if (isMemo) {
                  t.type = runAndMaybeReplace(inner);
                } else {
                  t.render = runAndMaybeReplace(inner);
                }
              }
            };

            const routeInnerContainer = findInReactTree(
              keyedRet,
              (x: any) =>
                Array.isArray(x?.props?.children) &&
                x?.props?.className?.includes(appDetailsClasses?.InnerContainer)
            )?.props?.children;

            if (Array.isArray(routeInnerContainer)) {
              const playBlockIndex = routeInnerContainer.findIndex((child: any) => {
                return (
                  child?.props?.childFocusDisabled !== undefined &&
                  child?.props?.navRef !== undefined &&
                  child?.props?.children?.props?.details !== undefined &&
                  child?.props?.children?.props?.overview !== undefined &&
                  child?.props?.children?.props?.bFastRender !== undefined
                );
              });

              if (playBlockIndex > -1) {
                const leNode = routeInnerContainer[playBlockIndex]?.props?.children;

                patchOneComponent(leNode, (leResult: any) => {
                  const deNode = findInReactTree(
                    leResult,
                    (x: any) => x?.props?.setSections !== undefined && x?.props?.bShowGameInfo !== undefined
                  );
                  if (!deNode) return undefined;

                  patchOneComponent(deNode, (deResult: any) => {
                    const xeNode = findInReactTree(
                      deResult,
                      (x: any) => x?.props?.setSections !== undefined && x?.props?.bShowGameInfo !== undefined
                    );
                    if (!xeNode) return undefined;

                    patchOneComponent(xeNode, (xeResult: any) => {
                      const navNode = findInReactTree(
                        xeResult,
                        (x: any) => x?.props?.onNav !== undefined && x?.props?.setSections !== undefined
                      );
                      if (!navNode) return undefined;

                      patchOneComponent(navNode, (navResult: any) => {
                        const navChild0 = Array.isArray(navResult?.props?.children)
                          ? navResult.props.children[0]
                          : undefined;
                        if (!navChild0) return undefined;

                        patchOneComponent(navChild0, (navChild0Result: any) => {
                          const streamNode = findInReactTree(
                            navChild0Result,
                            (x: any) => x?.props?.bShowStreamingSelector !== undefined
                          );
                          if (!streamNode) return undefined;

                          patchOneComponent(streamNode, (playAreaResult: any) => {
                            patchOneComponent(playAreaResult, (aeResult: any) => {
                              const kids = aeResult?.props?.children;
                              if (!Array.isArray(kids)) return undefined;

                              const already = kids.some((k: any) => k?.key === "decklocker-play-row-lock");
                              if (already) return undefined;

                              const newKids = [
                                ...kids,
                                <InlineLockRow key="decklocker-play-row-lock" appId={appId} />,
                              ];
                              return cloneElement(aeResult, { children: newKids });
                            });
                            return undefined;
                          });
                          return undefined;
                        });
                        return undefined;
                      });
                      return undefined;
                    });
                    return undefined;
                  });
                  return undefined;
                });
              }
            }
          } catch (e) {
            console.error("DeckLocker: play-row splice setup failed", e);
          }

          return (
            <LockedPageGate key="decklocker-locked-gate" appId={appId}>
              {keyedRet}
            </LockedPageGate>
          );
        }
      );
      afterPatch(routeProps, "renderFunc", patchHandler);
    }
    return routeTree;
  });
}

// Quick-Access Menu panel content. Shows a PIN entry gate first when QAM lock is
// enabled and a PIN has been set, then the main settings panel.
function Content() {
  const [settings, setSettings] = useState<DeckLockerSettings>({
    global_lock_enabled: false,
    locked_apps: [],
    pin_set: false,
    qam_lock_enabled: false,
    keypad_corner_radius: 14,
    lockscreen_hero_bg_enabled: false,
    lockscreen_bg_blur_px: 8,
    lockscreen_bg_opacity_percent: 30,
    relock_animation_enabled: true,
    keypad_circle_shape: false,
    keypad_glass_effect: false,
    keypad_on_right: false,
    relock_on_sleep: false,
    relock_on_exit: false,
    decky_panel_lock_enabled: false,
  });
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [showGamesList, setShowGamesList] = useState(false);
  const [showLockMethod, setShowLockMethod] = useState(false);
  const [showCustomization, setShowCustomization] = useState(false);

  const [qamUnlocked, setQamUnlocked] = useState(() => {
    // Cancel a pending "panel closed" reset — this mount means we're still within the
    // same QAM session (a tab switch), not a real panel close.
    if (qamCloseResetTimer) {
      clearTimeout(qamCloseResetTimer);
      qamCloseResetTimer = null;
    }
    return qamUnlockedThisSession;
  });
  const [qamPinInput, setQamPinInput] = useState("");
  const [qamPinError, setQamPinError] = useState("");
  const qamPinInputWrapperRef = useRef<HTMLDivElement | null>(null);

  // Makes the underlying input text invisible and lets dot overlays show the PIN instead,
  // since bIsPassword on TextField does not actually mask text in Steam's UI. The
  // background is forced to a fixed dark color because it turns white on focus and
  // would make white dots invisible while typing.
  useEffect(() => {
    const input = qamPinInputWrapperRef.current?.querySelector("input") as HTMLInputElement | null;
    if (input) {
      input.style.color = "transparent";
      input.style.caretColor = "transparent";
      (input.style as any).WebkitTextFillColor = "transparent";
      input.style.setProperty("background-color", "#23262e", "important");
      input.style.transition = "border-color 0.1s";
    }
  }, [qamPinInput]);

  // Adds a border focus indicator driven by Steam's gpfocus CSS class via
  // MutationObserver, since native focus/blur events are unreliable for this input.
  useEffect(() => {
    const input = qamPinInputWrapperRef.current?.querySelector("input") as HTMLInputElement | null;
    if (!input) return undefined;
    const applyBorder = () => {
      const focused = input.className.split(/\s+/).includes("gpfocus");
      input.style.setProperty("border", focused ? "2px solid #fff" : "2px solid transparent", "important");
    };
    applyBorder();
    const observer = new MutationObserver(applyBorder);
    observer.observe(input, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, [qamPinInput]);

  // Starts the QAM close timer on unmount. If the component remounts before it fires
  // (a tab switch), the new mount cancels it and the unlocked state is preserved.
  useEffect(() => {
    return () => {
      qamCloseResetTimer = setTimeout(() => {
        qamUnlockedThisSession = false;
        qamCloseResetTimer = null;
      }, 3000);
    };
  }, []);

  useEffect(() => {
    getSettings().then(setSettings);
    setApps(getInstalledApps());
  }, []);

  const onGlobalToggle = async (checked: boolean) => {
    const updated = await setGlobalLock(checked);
    setSettings(updated);
  };

  const onQamLockToggle = async (checked: boolean) => {
    let updated = await setQamLock(checked);
    // Mutually exclusive with decky_panel_lock_enabled — enabling one disables the other.
    if (checked && settings.decky_panel_lock_enabled) {
      updated = await setCustomization({ decky_panel_lock_enabled: false });
    }
    setSettings(updated);
  };

  const onDeckyPanelLockToggle = async (checked: boolean) => {
    let updated = await setCustomization({ decky_panel_lock_enabled: checked });
    // Mutually exclusive with qam_lock_enabled — enabling one disables the other.
    if (checked && settings.qam_lock_enabled) {
      updated = await setQamLock(false);
    }
    setSettings(updated);
  };

  const onAppToggle = async (appid: string, checked: boolean) => {
    const lockedApps = await toggleApp(appid, checked);
    setSettings((prev) => ({ ...prev, locked_apps: lockedApps }));
  };

  const onCustomizationChange = async (updates: Partial<DeckLockerSettings>) => {
    const updated = await setCustomization(updates);
    setSettings(updated);
    cachedSettings = updated;
  };

  const onQamPinSubmit = async () => {
    const ok = await checkPin(qamPinInput);
    if (ok) {
      qamUnlockedThisSession = true;
      setQamUnlocked(true);
      setQamPinError("");
    } else {
      setQamPinError("Incorrect PIN");
      setQamPinInput("");
    }
  };

  if (settings.qam_lock_enabled && settings.pin_set && !qamUnlocked) {
    return (
      <PanelSection>
        <PanelSectionRow>
          <div style={{ fontWeight: "bold", marginBottom: "4px" }}>Enter PIN</div>
        </PanelSectionRow>
        <PanelSectionRow>
          <div
            ref={(el) => { qamPinInputWrapperRef.current = el; }}
            style={{ position: "relative" }}
          >
            <TextField
              value={qamPinInput}
              onChange={(e) => {
                setQamPinError("");
                setQamPinInput(e.target.value.replace(/\D/g, ""));
              }}
              bIsPassword={true}
            />
            {qamPinInput.length > 0 && (
              <div
                style={{
                  position: "absolute",
                  left: "12px",
                  top: 0,
                  bottom: 0,
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  pointerEvents: "none",
                }}
              >
                {qamPinInput.split("").map((_, i) => (
                  <div key={i} style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#fff" }} />
                ))}
              </div>
            )}
          </div>
        </PanelSectionRow>
        {qamPinError && (
          <PanelSectionRow>
            <div style={{ color: "#f44336", fontSize: "13px" }}>{qamPinError}</div>
          </PanelSectionRow>
        )}
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={onQamPinSubmit}>
            Unlock
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>
    );
  }

  if (showCustomization) {
    return (
      <PanelSection>
        <PanelSectionRow>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ fontWeight: "bold" }}>Customization</div>
            <DialogButton
              onClick={() => setShowCustomization(false)}
              style={{ width: "32px", minWidth: "32px", padding: "4px" }}
            >
              X
            </DialogButton>
          </div>
        </PanelSectionRow>

        <PanelSectionRow>
          <div style={{ fontWeight: "bold", marginTop: "12px", opacity: 0.7, fontSize: "12px" }}>PIN</div>
        </PanelSectionRow>

        <PanelSectionRow>
          <ToggleField
            label="Circle Keys"
            description="Makes keys fully circular"
            checked={settings.keypad_circle_shape}
            onChange={(checked) => onCustomizationChange({ keypad_circle_shape: checked })}
          />
        </PanelSectionRow>

        {!settings.keypad_circle_shape && (
          <PanelSectionRow>
            <SliderField
              label="Keypad Corner Roundness"
              value={settings.keypad_corner_radius}
              min={0}
              max={36}
              step={1}
              onChange={(value: number) => onCustomizationChange({ keypad_corner_radius: value })}
            />
          </PanelSectionRow>
        )}

        <PanelSectionRow>
          <ToggleField
            label="Glass Effect"
            description="Semi-transparent, blurred keypad background"
            checked={settings.keypad_glass_effect}
            onChange={(checked) => onCustomizationChange({ keypad_glass_effect: checked })}
          />
        </PanelSectionRow>

        <PanelSectionRow>
          <ToggleField
            label="Keypad on Right"
            description="Swap sides — keypad on the right, game art on the left"
            checked={settings.keypad_on_right}
            onChange={(checked) => onCustomizationChange({ keypad_on_right: checked })}
          />
        </PanelSectionRow>

        <PanelSectionRow>
          <div style={{ fontWeight: "bold", marginTop: "12px", opacity: 0.7, fontSize: "12px" }}>GENERAL</div>
        </PanelSectionRow>

        <PanelSectionRow>
          <ToggleField
            label="Lock Screen Game Background"
            description="Use the game's hero art as the lock screen background"
            checked={settings.lockscreen_hero_bg_enabled}
            onChange={(checked) => onCustomizationChange({ lockscreen_hero_bg_enabled: checked })}
          />
        </PanelSectionRow>

        {settings.lockscreen_hero_bg_enabled && (
          <>
            <PanelSectionRow>
              <SliderField
                label="Background Blur"
                value={settings.lockscreen_bg_blur_px}
                min={0}
                max={20}
                step={1}
                onChange={(value: number) => onCustomizationChange({ lockscreen_bg_blur_px: value })}
              />
            </PanelSectionRow>

            <PanelSectionRow>
              <SliderField
                label="Background Opacity"
                value={settings.lockscreen_bg_opacity_percent}
                min={0}
                max={100}
                step={5}
                onChange={(value: number) => onCustomizationChange({ lockscreen_bg_opacity_percent: value })}
              />
            </PanelSectionRow>
          </>
        )}

        <PanelSectionRow>
          <ToggleField
            label="Re-lock Animation"
            description="Show the lock-closing animation when manually re-locking a game"
            checked={settings.relock_animation_enabled}
            onChange={(checked) => onCustomizationChange({ relock_animation_enabled: checked })}
          />
        </PanelSectionRow>

        <PanelSectionRow>
          <div style={{ marginTop: "12px" }}>
            <ButtonItem
              layout="below"
              onClick={() =>
                onCustomizationChange({
                  keypad_corner_radius: 14,
                  keypad_circle_shape: false,
                  keypad_glass_effect: false,
                  keypad_on_right: false,
                  lockscreen_hero_bg_enabled: false,
                  lockscreen_bg_blur_px: 8,
                  lockscreen_bg_opacity_percent: 30,
                  relock_animation_enabled: true,
                })
              }
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span>Reset to Defaults</span>
                <FaUndo size={14} />
              </div>
            </ButtonItem>
          </div>
        </PanelSectionRow>
      </PanelSection>
    );
  }

  return (
    <PanelSection>
      <PanelSectionRow>
        <ToggleField
          label="Enable Lock"
          description="Require a PIN for locked games"
          checked={settings.global_lock_enabled}
          onChange={onGlobalToggle}
        />
      </PanelSectionRow>

      {settings.global_lock_enabled && (
        <>
          <PanelSectionRow>
            <div style={{ marginTop: "12px" }}>
              <DialogButton
                onClick={() => setShowLockMethod((v) => !v)}
                style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between" }}
              >
                <span>Lock Method</span>
                {showLockMethod ? <FaChevronDown size={14} /> : <FaChevronRight size={14} />}
              </DialogButton>
            </div>
          </PanelSectionRow>

          {showLockMethod && (
            <PanelSectionRow>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 4px", opacity: 0.9 }}>
                <span>PIN</span>
                <FaCheck size={14} color="#4caf50" />
              </div>
            </PanelSectionRow>
          )}

          <PanelSectionRow>
            <ButtonItem
              layout="below"
              onClick={() => showModal(<SetPinModal onPinSet={() => getSettings().then(setSettings)} />)}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span>Set PIN</span>
                <FaTh size={14} />
              </div>
            </ButtonItem>
          </PanelSectionRow>

          <PanelSectionRow>
            <ButtonItem layout="below" onClick={() => setShowCustomization(true)}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span>Customization</span>
                <FaPalette size={14} />
              </div>
            </ButtonItem>
          </PanelSectionRow>

          {settings.pin_set && (
            <>
              <PanelSectionRow>
                <div style={{ fontWeight: "bold", marginTop: "8px" }}>GAMES</div>
                <div style={{ fontSize: "12px", opacity: 0.7, marginTop: "2px" }}>
                  Lists all games, including non-Steam
                </div>
              </PanelSectionRow>

              <PanelSectionRow>
                <div style={{ marginTop: "12px" }}>
                  <DialogButton
                    onClick={() => setShowGamesList((v) => !v)}
                    style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between" }}
                  >
                    <span>Show Games List</span>
                    {showGamesList ? <FaChevronDown size={14} /> : <FaChevronRight size={14} />}
                  </DialogButton>
                </div>
              </PanelSectionRow>

              {showGamesList && (
                <>
                  {apps.length === 0 && (
                    <PanelSectionRow>
                      <div>No installed games found.</div>
                    </PanelSectionRow>
                  )}
                  {apps.map((app) => (
                    <PanelSectionRow key={app.appid}>
                      <ToggleField
                        label={app.display_name}
                        checked={settings.locked_apps.includes(app.appid)}
                        onChange={(checked) => onAppToggle(app.appid, checked)}
                      />
                    </PanelSectionRow>
                  ))}
                </>
              )}

              <PanelSectionRow>
                <div style={{ height: "1px", background: "rgba(255,255,255,0.15)", marginTop: "16px", marginBottom: "4px" }} />
                <div style={{ fontWeight: "bold", marginTop: "8px" }}>OTHERS</div>
                <div style={{ fontSize: "12px", opacity: 0.7, marginTop: "2px" }}>
                  Additional settings for this plugin
                </div>
              </PanelSectionRow>

              <PanelSectionRow>
                <ToggleField
                  label="Enable Lock This Plugin"
                  description="Require a PIN to open this plugin's settings panel"
                  checked={settings.qam_lock_enabled}
                  onChange={onQamLockToggle}
                />
              </PanelSectionRow>

              <PanelSectionRow>
                <ToggleField
                  label="Enable Lock Decky Panel"
                  description="Require a PIN before the Decky plugin list is shown (disables Lock This Plugin)"
                  checked={settings.decky_panel_lock_enabled}
                  onChange={onDeckyPanelLockToggle}
                />
              </PanelSectionRow>

              <PanelSectionRow>
                <ToggleField
                  label="Re-lock on Sleep"
                  description="Clear all game unlocks when the Steam Deck goes to sleep"
                  checked={settings.relock_on_sleep}
                  onChange={(checked) => onCustomizationChange({ relock_on_sleep: checked })}
                />
              </PanelSectionRow>

              <PanelSectionRow>
                <ToggleField
                  label="Re-lock When Leaving Game"
                  description="Require PIN again each time you navigate to a locked game's page"
                  checked={settings.relock_on_exit}
                  onChange={(checked) => onCustomizationChange({ relock_on_exit: checked })}
                />
              </PanelSectionRow>
            </>
          )}
        </>
      )}
    </PanelSection>
  );
}

export default definePlugin(() => {
  getSettingsCached().catch((e) => console.error("DeckLocker: initial settings warm-up failed", e));

  const libraryAppPagePatch = patchAppPage();

  routerHook.addGlobalComponent("DeckLockerMenuWatcher", GlobalMenuWatcher);
  routerHook.addGlobalComponent("DeckLockerQamGate", GlobalDeckyQamGate);

  // Safety-net hook: catches games that start running despite the page gate (e.g.
  // launched from outside the library via a shortcut) and kills them before
  // showing the PIN screen.
  let lifetimeHook: any;
  try {
    lifetimeHook = (window as any).SteamClient.GameSessions.RegisterForAppLifetimeNotifications(
      async (update: any) => {
        if (!update.bRunning) return;
        const appid = String(update.unAppID);
        const settings = await getSettingsCached();
        if (
          settings.global_lock_enabled &&
          settings.locked_apps.includes(appid) &&
          !unlockedThisSession.has(appid)
        ) {
          terminateAppAggressively(appid);
          showModal(<PinLockScreen appid={appid} appName={nameForApp(appid)} />);
        }
      }
    );
  } catch (e) {
    console.error("DeckLocker: could not register lifetime hook", e);
  }

  // Clears all per-session game unlocks when the Steam Deck goes to sleep,
  // if the user has relock_on_sleep enabled.
  let suspendHook: any;
  const relockOnSuspend = () => {
    const s = cachedSettings;
    if (s?.relock_on_sleep) {
      unlockedThisSession.clear();
      settledThisSession.clear();
    }
  };
  const suspendApis = ["RegisterForOnSuspendRequest", "RegisterForOnResumeFromSuspend"];
  for (const apiName of suspendApis) {
    try {
      const fn = (window as any).SteamClient?.System?.[apiName];
      if (typeof fn === "function") {
        suspendHook = fn.call((window as any).SteamClient.System, relockOnSuspend);
        console.log("DeckLocker: registered suspend hook via SteamClient.System." + apiName);
        break;
      }
    } catch (e) {
      console.warn("DeckLocker: SteamClient.System." + apiName + " failed:", e);
    }
  }
  if (!suspendHook) {
    console.error("DeckLocker: could not register any suspend hook");
  }

  return {
    name: "Deck Locker",
    titleView: <div className={staticClasses.Title}>Deck Locker</div>,
    content: <Content />,
    icon: <FaLock />,
    onDismount() {
      routerHook.removePatch("/library/app/:appid", libraryAppPagePatch);
      routerHook.removeGlobalComponent("DeckLockerMenuWatcher");
      routerHook.removeGlobalComponent("DeckLockerQamGate");
      lifetimeHook?.unregister?.();
      suspendHook?.unregister?.();
    },
  };
});
