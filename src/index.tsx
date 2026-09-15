import {
  ButtonItem,
  Field,
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
  gamepadSliderClasses,
  gamepadDialogClasses,
  SliderField,
  DropdownItem,
  findModuleChild,
  findModuleByExport,
  showContextMenu,
  QuickAccessTab,
  getReactRoot,
} from "@decky/ui";
import { callable, definePlugin, routerHook } from "@decky/api";
import { useState, useEffect, useRef, cloneElement, ReactNode, RefObject, PointerEvent as ReactPointerEvent } from "react";
import { FaLock, FaBackspace, FaLockOpen, FaChevronRight, FaChevronLeft, FaChevronDown, FaTh, FaCheck, FaPalette, FaUndo, FaGithub, FaQrcode, FaTrash } from "react-icons/fa";

// Which credential type protects locked content. "pin", "password", "pattern", and
// "tap_code" are implemented; "controller_code" is reserved for a future lock method
// and already round-trips through settings (see LOCK_METHOD_OPTIONS and the Lock
// Method picker in Content() below) so adding it is a matter of building its own
// credential-entry UI and backend set_/check_ pair (see _set_credential/_check_credential
// in main.py), not restructuring settings again.
type LockMethod = "pin" | "password" | "pattern" | "tap_code" | "controller_code";

interface DeckLockerSettings {
  global_lock_enabled: boolean;
  locked_apps: string[];
  locked_plugins: string[];
  locked_qam_tabs: string[];
  locked_main_menu_items: string[];
  pin_set: boolean;
  password_set: boolean;
  pattern_set: boolean;
  tap_code_set: boolean;
  qam_lock_enabled: boolean;
  keypad_corner_radius: number;
  lockscreen_hero_bg_enabled: boolean;
  lockscreen_bg_blur_px: number;
  lockscreen_bg_opacity_percent: number;
  relock_animation_enabled: boolean;
  keypad_shape: "square" | "rounded" | "circle";
  keypad_glass_effect: boolean;
  keypad_on_right: boolean;
  relock_on_sleep: boolean;
  relock_on_exit: boolean;
  decky_panel_lock_enabled: boolean;
  hide_game_art: boolean;
  keypad_key_size: number;
  keypad_font_size: number;
  locked_badge_enabled: boolean;
  locked_badge_position: "top-left" | "top-right" | "bottom-left" | "bottom-right" | "center";
  lock_method: LockMethod;
  pattern_dot_shape: "square" | "rounded" | "circle" | "none";
  pattern_corner_radius: number;
  pattern_dot_size: number;
  pattern_glass_effect: boolean;
  // Colors the pattern's dots/lines with the current theme's slider/progress accent
  // color (see getThemeAccent) instead of plain white.
  pattern_line_theme_color: boolean;
  // Hides the line connecting the dots (while the drawn sequence is neutral) — only
  // the dots themselves show.
  pattern_line_transparent: boolean;
  // Frosted-glass look for the dedicated Cancel/OK button row used by Password and
  // Pattern (PIN's own Cancel/OK are keypad cells and already covered by
  // keypad_glass_effect; Knock Code's own customization is intentionally minimal —
  // see tap_code_show_outline/tap_code_show_dividers below).
  action_button_glass_effect: boolean;
  // Knock Code's only two customizable looks: the single outline around the whole 2x2
  // area (not per-cell — there's nothing else to style per-cell, see KnockCodePad),
  // and optional divider lines splitting it into 4 visible quadrants.
  tap_code_show_outline: boolean;
  tap_code_show_dividers: boolean;
}

interface AppInfo {
  appid: string;
  display_name: string;
}

// Lock Method picker options (see the "Lock Method" section in Content() below).
// "pin", "password", "pattern", and "tap_code" are selectable — the rest are listed so
// the setting and UI already exist once their own credential-entry screens are built;
// selecting one before then is a no-op (see the picker's onChange).
const LOCK_METHOD_OPTIONS: { data: LockMethod; label: string; implemented: boolean }[] = [
  { data: "pin", label: "PIN", implemented: true },
  { data: "password", label: "Password", implemented: true },
  { data: "pattern", label: "Pattern", implemented: true },
  // "tap_code" internally (matches the settings key/type already round-tripped since
  // the initial release) — labeled "Knock Code" since that's what it actually is: LG's
  // old lock screen feature, a 2x2 grid tapped in sequence (see KnockCodePad).
  { data: "tap_code", label: "Knock Code", implemented: true },
  // Unlocks with a sequence of controller button presses (A/B/X/Y, bumpers, triggers,
  // d-pad), similar to the Deck's own native lock screen's button-combo unlock. The
  // Lock Method picker below appends "(Soon)" itself for any unimplemented option.
  { data: "controller_code", label: "Controller Code", implemented: false },
];

// Maps each implemented lock method to the settings.json boolean that says whether its
// credential has been set (see _public_settings in main.py); add an entry here when a
// new method's set_/check_ pair lands. Unimplemented methods (e.g. controller_code)
// fall through to pin_set, same as the settings picker treats them as PIN until then.
type CredentialSetKey = "pin_set" | "password_set" | "pattern_set" | "tap_code_set";
const CREDENTIAL_SET_KEYS: Partial<Record<LockMethod, CredentialSetKey>> = {
  pin: "pin_set",
  password: "password_set",
  pattern: "pattern_set",
  tap_code: "tap_code_set",
};

// True when the credential for the currently-selected lock method has been set — the
// gate for showing anything that requires unlocking (the GAMES/PLUGINS/etc. sections,
// the Decky panel gate, the QAM self-lock prompt).
function hasCredentialSet(
  s:
    | Pick<DeckLockerSettings, "lock_method" | "pin_set" | "password_set" | "pattern_set" | "tap_code_set">
    | null
    | undefined
): boolean {
  if (!s) return false;
  const key = CREDENTIAL_SET_KEYS[s.lock_method] ?? "pin_set";
  return Boolean(s[key]);
}

// Human-readable label for the currently-selected lock method's credential, used in
// entry-screen copy ("Enter PIN" / "Enter Password") and error text. Reads from
// LOCK_METHOD_OPTIONS so the display name has one source of truth.
function credentialLabel(method: LockMethod): string {
  return LOCK_METHOD_OPTIONS.find((option) => option.data === method)?.label ?? "PIN";
}

// Pattern nodes (0-8, each used at most once) round-trip as this joined string —
// stable, order-preserving, and cheap to hash/compare on the backend the same way a
// PIN or password string is.
function sequenceToString(nodes: number[]): string {
  return nodes.join("-");
}

// Clears an in-progress entry while it has content, cancels out of the screen once
// it's already empty — same dual-purpose convention as the PIN keypad's bottom-left
// key. Shared by the pattern and Knock Code entry screens in PinLockScreen.
function clearOrCancel<T>(value: T[], setValue: (v: T[]) => void, cancel: () => void) {
  if (value.length > 0) setValue([]);
  else cancel();
}

// Shared "frosted glass" look toggled on by keypad_glass_effect, pattern_glass_effect,
// and action_button_glass_effect — applied to keypad cells, pattern dots, and the
// Password/Pattern Cancel/OK button row respectively.
const FROSTED_GLASS_STYLE = {
  background: "rgba(255,255,255,0.14)",
  backdropFilter: "blur(24px) saturate(180%)",
  WebkitBackdropFilter: "blur(24px) saturate(180%)",
  border: "1px solid rgba(255,255,255,0.25)",
};

const getSettings = callable<[], DeckLockerSettings>("get_settings");
const setGlobalLock = callable<[enabled: boolean], DeckLockerSettings>("set_global_lock");
const setQamLock = callable<[enabled: boolean], DeckLockerSettings>("set_qam_lock");
const setCustomization = callable<[updates: Partial<DeckLockerSettings>], DeckLockerSettings>("set_customization");
const resetAllSettings = callable<[], DeckLockerSettings>("reset_all_settings");
const setPin = callable<[pin: string], boolean>("set_pin");
const checkPin = callable<[pin: string], boolean>("check_pin");
const setPassword = callable<[password: string], boolean>("set_password");
const checkPassword = callable<[password: string], boolean>("check_password");
const setPattern = callable<[pattern: string], boolean>("set_pattern");
const checkPattern = callable<[pattern: string], boolean>("check_pattern");
const setTapCode = callable<[code: string], boolean>("set_tap_code");
const checkTapCode = callable<[code: string], boolean>("check_tap_code");

// Dispatches a credential-entry attempt to whichever method's check_ call applies.
// Falls back to PIN for a not-yet-implemented method — unreachable in practice since
// LOCK_METHOD_OPTIONS disables picking one before its own case is added here.
async function checkCredential(method: LockMethod, value: string): Promise<boolean> {
  if (method === "password") return checkPassword(value);
  if (method === "pattern") return checkPattern(value);
  if (method === "tap_code") return checkTapCode(value);
  return checkPin(value);
}
const toggleApp = callable<[app_id: string, locked: boolean], string[]>("toggle_app");
const togglePluginLock = callable<[plugin_name: string, locked: boolean], string[]>("toggle_plugin_lock");
const toggleQamTabLock = callable<[tab_name: string, locked: boolean], string[]>("toggle_qam_tab_lock");
const toggleMainMenuItemLock = callable<[item_name: string, locked: boolean], string[]>("toggle_main_menu_item_lock");
const getLocalArtwork = callable<[app_id: string], string>("get_local_artwork");
const getLocalHeroArtwork = callable<[app_id: string], string>("get_local_hero_artwork");

// Cached after the first fetch so lock checks throughout the session can read
// settings synchronously without an extra IPC round-trip to the Python backend.
let cachedSettings: DeckLockerSettings | null = null;

// Notifies components that only read cachedSettings during render (not via React
// state/props) that it just changed, so they know to re-render — plain mutation of a
// module-level variable is invisible to React on its own. Long-lived components like
// DeckyPanelPinPrompt (shared by the QAM tab gate, plugin gate, and Main Menu item
// gate) can sit mounted for a whole session without ever re-rendering on their own
// after the Lock Method changes elsewhere, which is exactly what left them showing the
// old method's entry UI even after closing and reopening the QAM — closing/reopening
// doesn't unmount them, so nothing prompted a fresh read of cachedSettings.lock_method
// without this.
const settingsChangeListeners = new Set<() => void>();
function setCachedSettings(updated: DeckLockerSettings) {
  // Only lock_method actually needs to wake up listeners today (see the comment
  // above) — gating on it avoids forcing every listener to re-render on unrelated
  // settings churn, e.g. a customization slider firing onChange continuously while
  // dragged. Widen this check if a future listener needs to react to other fields.
  const lockMethodChanged = cachedSettings?.lock_method !== updated.lock_method;
  cachedSettings = updated;
  if (lockMethodChanged) settingsChangeListeners.forEach((listener) => listener());
}
// Subscribes a component to cachedSettings changes, forcing a re-render on each one so
// values derived from cachedSettings during render (e.g. `lockMethod`) stay current
// even when nothing else about the component would otherwise cause it to re-render.
function useCachedSettingsVersion(): void {
  const [, setVersion] = useState(0);
  useEffect(() => {
    const listener = () => setVersion((v) => v + 1);
    settingsChangeListeners.add(listener);
    return () => {
      settingsChangeListeners.delete(listener);
    };
  }, []);
}

async function getSettingsCached(): Promise<DeckLockerSettings> {
  const s = await getSettings();
  setCachedSettings(s);
  return s;
}

// Games the user has already unlocked this session — skips re-prompting on revisits.
const unlockedThisSession = new Set<string>();
// Games whose post-unlock settling delay has already run — skips the delay on revisits.
const settledThisSession = new Set<string>();

// QAM panel unlock state. Persists once unlocked — closing/reopening the QAM no longer
// re-locks it; only an explicit relock event (sleep, if Re-lock on Sleep is enabled)
// resets it.
let qamUnlockedThisSession = false;

// Decky-panel gate state — true means the next time the Decky tab becomes active
// requires a PIN before showing any plugins. Persists once unlocked, same as above.
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

const DECKLOCKER_GITHUB_URL = "https://github.com/jhonniledio/DeckLocker";

// QR code for the GitHub project link (see the "Open Project" row in Content() below).
// Generated via a third-party service (api.qrserver.com) rather than a bundled QR
// library — the only data sent is this project's own public URL, nothing user-specific.
function ProjectQrModal({ closeModal }: { closeModal?: () => void }) {
  return (
    <ConfirmModal strTitle="Scan to Open Project" onOK={closeModal} bAlertDialog>
      <div style={{ display: "flex", justifyContent: "center", padding: "8px 0" }}>
        <img
          src={`https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(DECKLOCKER_GITHUB_URL)}`}
          alt="QR code linking to the Deck Locker GitHub project"
          width={220}
          height={220}
          style={{ borderRadius: "8px", background: "#fff", padding: "8px" }}
        />
      </div>
      <div style={{ textAlign: "center", opacity: 0.8, fontSize: "13px", wordBreak: "break-all" }}>
        {DECKLOCKER_GITHUB_URL}
      </div>
    </ConfirmModal>
  );
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

// Modal for setting or changing the password. Mirrors SetPinModal exactly except it
// allows any characters (no digit-only filter) — requires at least 4 characters and a
// matching confirmation entry before saving.
function SetPasswordModal({ closeModal, onPasswordSet }: { closeModal?: () => void; onPasswordSet?: () => void }) {
  const [password, setPasswordValue] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");

  const onConfirm = async () => {
    if (password.length < 4) {
      setError("Password must be at least 4 characters");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    await setPassword(password);
    onPasswordSet?.();
    closeModal?.();
  };

  return (
    <ConfirmModal
      strTitle="Set Deck Locker Password"
      strDescription="Enter a password (at least 4 characters) required to launch locked games."
      onOK={onConfirm}
      onCancel={closeModal}
    >
      <TextField
        label="Password"
        value={password}
        onChange={(e) => {
          setError("");
          setPasswordValue(e.target.value);
        }}
        bIsPassword={true}
      />
      <TextField
        label="Confirm Password"
        value={confirmPassword}
        onChange={(e) => {
          setError("");
          setConfirmPassword(e.target.value);
        }}
        bIsPassword={true}
      />
      {error && <div style={{ color: "#f44336", marginTop: "8px", fontSize: "13px" }}>{error}</div>}
    </ConfirmModal>
  );
}

// Shared state machine behind SetPatternModal and SetKnockCodeModal: both capture a
// node/cell sequence twice (draw/tap once, then repeat to confirm) and only save it
// once the two entries match. A real drag-release (PatternPad) or the modal's own OK
// button (relabeled "Next"/"Save" per stage, for a tap-per-node draw with no drag
// release to catch) advances the stage or triggers the save/compare. On save it colors
// the second attempt green/red for a couple seconds (see the pad's status prop) before
// either closing (match) or clearing the confirm entry for another attempt (mismatch)
// — same "hold the result, then reset" pacing as the lock screen's own incorrect-PIN
// shake-and-clear.
function useTwoStageSequenceCapture({
  minLength,
  tooShortError,
  mismatchError,
  onSave,
  onSaved,
  closeModal,
}: {
  minLength: number;
  tooShortError: string;
  mismatchError: string;
  onSave: (sequence: string) => Promise<unknown>;
  onSaved?: () => void;
  closeModal?: () => void;
}) {
  const [stage, setStage] = useState<"first" | "confirm">("first");
  const [firstSequence, setFirstSequence] = useState<number[]>([]);
  const [confirmSequence, setConfirmSequence] = useState<number[]>([]);
  const [error, setError] = useState("");
  const [confirmStatus, setConfirmStatus] = useState<"neutral" | "correct" | "incorrect">("neutral");
  const busy = confirmStatus !== "neutral";

  const activeSequence = stage === "first" ? firstSequence : confirmSequence;
  const setActiveSequence = stage === "first" ? setFirstSequence : setConfirmSequence;

  const onAdvanceOrSave = async () => {
    if (busy) return;
    if (stage === "first") {
      if (firstSequence.length < minLength) {
        setError(tooShortError);
        return;
      }
      setError("");
      setStage("confirm");
      return;
    }
    const matched = sequenceToString(confirmSequence) === sequenceToString(firstSequence);
    setConfirmStatus(matched ? "correct" : "incorrect");
    if (matched) {
      await onSave(sequenceToString(firstSequence));
      onSaved?.();
      setTimeout(() => closeModal?.(), 2000);
    } else {
      setError(mismatchError);
      setTimeout(() => {
        setConfirmSequence([]);
        setConfirmStatus("neutral");
        setError("");
      }, 1500);
    }
  };

  return { stage, activeSequence, setActiveSequence, error, confirmStatus, busy, onAdvanceOrSave };
}

// Modal for setting or changing the pattern. Unlike PIN/Password's two side-by-side
// fields, a pattern needs the drawing surface to itself, so this uses the shared
// two-stage capture flow (see useTwoStageSequenceCapture) instead. Clear/Next-Save/
// Cancel all render as ConfirmModal's own native footer row via its middle-button slot
// (onMiddleButton/strMiddleButtonText) rather than a custom button stacked in the body
// — same row, same styling, no hand-rolled footer needed.
function SetPatternModal({ closeModal, onPatternSet }: { closeModal?: () => void; onPatternSet?: () => void }) {
  const { stage, activeSequence, setActiveSequence, error, confirmStatus, busy, onAdvanceOrSave } =
    useTwoStageSequenceCapture({
      minLength: 4,
      tooShortError: "Pattern must connect at least 4 dots",
      mismatchError: "Patterns do not match",
      onSave: setPattern,
      onSaved: onPatternSet,
      closeModal,
    });

  return (
    <ConfirmModal
      strTitle="Set Deck Locker Pattern"
      strDescription={
        stage === "first" ? "Draw a pattern connecting at least 4 dots." : "Draw the same pattern again to confirm."
      }
      strOKButtonText={stage === "first" ? "Next" : "Save"}
      onOK={onAdvanceOrSave}
      bOKDisabled={busy}
      strMiddleButtonText="Clear"
      onMiddleButton={() => setActiveSequence([])}
      bMiddleDisabled={busy}
      onCancel={closeModal}
    >
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "12px", marginTop: "16px" }}>
        <PatternPad
          key={stage}
          value={activeSequence}
          onChange={setActiveSequence}
          onDragComplete={onAdvanceOrSave}
          disabled={busy}
          status={stage === "confirm" ? confirmStatus : "neutral"}
          useThemeColor={cachedSettings?.pattern_line_theme_color ?? false}
          transparentLine={cachedSettings?.pattern_line_transparent ?? false}
          size={64}
          gap={12}
          shape={cachedSettings?.pattern_dot_shape ?? "rounded"}
          cornerRadius={cachedSettings?.pattern_corner_radius ?? 14}
          glassEffect={cachedSettings?.pattern_glass_effect ?? false}
        />
        {error && <div style={{ color: "#f44336", fontSize: "13px" }}>{error}</div>}
      </div>
    </ConfirmModal>
  );
}

// Modal for setting or changing the Knock Code. Same shared two-stage capture flow
// (see useTwoStageSequenceCapture) and Clear/Next-Save/Cancel-as-ConfirmModal's-native-
// footer convention as SetPatternModal — tap a sequence of cells, then tap the same
// sequence again to confirm, with a green/red result on KnockCodePad itself before
// either closing (match) or clearing for another attempt.
function SetKnockCodeModal({ closeModal, onTapCodeSet }: { closeModal?: () => void; onTapCodeSet?: () => void }) {
  const { stage, activeSequence, setActiveSequence, error, confirmStatus, busy, onAdvanceOrSave } =
    useTwoStageSequenceCapture({
      minLength: 4,
      tooShortError: "Knock Code must be at least 4 taps",
      mismatchError: "Knock Codes do not match",
      onSave: setTapCode,
      onSaved: onTapCodeSet,
      closeModal,
    });

  return (
    <ConfirmModal
      strTitle="Set Deck Locker Knock Code"
      strDescription={
        stage === "first" ? "Tap the cells in a sequence (at least 4 taps)." : "Tap the same sequence again to confirm."
      }
      strOKButtonText={stage === "first" ? "Next" : "Save"}
      onOK={onAdvanceOrSave}
      bOKDisabled={busy}
      strMiddleButtonText="Clear"
      onMiddleButton={() => setActiveSequence([])}
      bMiddleDisabled={busy}
      onCancel={closeModal}
    >
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "16px", marginTop: "16px" }}>
        <KnockCodePad
          key={stage}
          onTap={(index) => setActiveSequence((prev) => [...prev, index])}
          disabled={busy}
          status={stage === "confirm" ? confirmStatus : "neutral"}
          // Always on here regardless of the Customization toggles — setting a code
          // benefits from clear grid structure no matter what the lock screen itself
          // is configured to show.
          showOutline
          showDividers
          size={92}
          gap={17}
        />
        <div style={{ display: "flex", gap: "8px", minHeight: "12px" }}>
          {activeSequence.map((_, i) => (
            <div key={i} style={{ width: "10px", height: "10px", borderRadius: "50%", background: "#fff" }} />
          ))}
        </div>
        {error && <div style={{ color: "#f44336", fontSize: "13px" }}>{error}</div>}
      </div>
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

// Whether the browser accepts `value` as a real, single CSS color (as opposed to a
// gradient/image function, an unresolved token, or empty) — checked by trying to
// assign it and seeing if it stuck, rather than hand-rolling a color-syntax parser.
function isCssColor(value: string, doc: Document): boolean {
  if (!value) return false;
  const probe = doc.createElement("span");
  probe.style.color = "";
  probe.style.color = value;
  return probe.style.color !== "";
}

type ThemeAccent = { kind: "color"; value: string } | { kind: "gradient"; angleDeg: number; colors: string[] };

// Splits a CSS value list on top-level commas only — needed for gradient color stops,
// since a plain split(",") would also break apart the commas inside each stop's own
// rgba(...)/hsla(...) function.
function splitTopLevelCommas(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

// Parses a *computed* linear-gradient() value (angle always resolved to plain degrees
// by getComputedStyle, unlike author-written "to right"/keyword forms) into its angle
// and color stops, dropping each stop's position (e.g. "50%") — good enough for an
// evenly-redistributed SVG gradient approximation, not a pixel-exact reproduction.
function parseLinearGradient(value: string): { angleDeg: number; colors: string[] } | null {
  const match = value.match(/^linear-gradient\(\s*(-?[\d.]+)deg\s*,\s*(.+)\)$/i);
  if (!match) return null;
  const angleDeg = parseFloat(match[1]);
  const colors = splitTopLevelCommas(match[2])
    .map((stop) => stop.replace(/\s+-?[\d.]+%\s*$/, "").trim())
    .filter(Boolean);
  return colors.length >= 2 ? { angleDeg, colors } : null;
}

// Converts a CSS gradient angle (0deg = to top, clockwise, per spec) into absolute
// x1/y1/x2/y2 coordinates spanning a `size`-by-`size` box, for an SVG <linearGradient>
// using gradientUnits="userSpaceOnUse" — NOT the default objectBoundingBox, which
// scopes x1/y1/x2/y2 to each individual referencing element's own bounding box rather
// than the shared canvas. A single <linearGradient> def here is referenced by every
// dot-to-dot <line>, and a purely horizontal or vertical line has a bounding box with
// zero height or width — a degenerate box, which makes an objectBoundingBox gradient
// invalid and the line simply not render (confirmed live: diagonal lines rendered
// fine, horizontal/vertical ones didn't). userSpaceOnUse coordinates are defined once
// against the whole canvas instead, so every line — whatever direction — resolves the
// same shared gradient consistently. This is a standard angle-to-vector approximation
// — CSS's exact "to corner" geometry also depends on aspect ratio, which doesn't
// matter here since the pattern grid is square.
function gradientAngleToSvgVector(angleDeg: number, size: number) {
  const rad = (angleDeg * Math.PI) / 180;
  const half = size / 2;
  return {
    x1: half - half * Math.sin(rad),
    y1: half + half * Math.cos(rad),
    x2: half + half * Math.sin(rad),
    y2: half - half * Math.cos(rad),
  };
}

// Best-effort read of "the current theme's accent color" for pattern_line_theme_color
// — there's no single CSS variable for this across arbitrary CSS Loader themes (unlike
// Millennium-style theming, community Deck themes just override specific component
// classes directly), so this briefly mounts an invisible probe element wearing one of
// Steam's own shared, commonly-retheming-target component classes (the slider fill
// behind volume/seek/settings sliders, then the "on" toggle rail) and reads its
// *computed* ::before background — getComputedStyle does the real cascade resolution
// (source order, specificity, !important, var() substitution) for free, which a manual
// stylesheet-rule scan can't replicate correctly (an earlier version of this took the
// first matching rule in document order, which was Steam's own un-themed default —
// same specificity, just declared before the theme's override, so it always won the
// naive scan even though the browser's real cascade picks the theme's rule instead).
// Returns a real multi-stop gradient descriptor when the theme uses one (some packs,
// like "Colored Toggles"'s Gradient options, do) rather than collapsing it to a single
// color — PatternPad renders it as a genuine SVG <linearGradient> for lines and a
// native CSS gradient for dot fills, not just an approximation of its first stop.
// Takes `doc` rather than assuming the global `document` — decky content can render
// inside a different top-level page than where this is called from (QuickAccess,
// MainMenu, and the main Big Picture window are separate documents, and a theme may
// only inject its CSS into some of them), so callers pass their own root element's
// ownerDocument.
//
// Deliberately NOT cached: this needs to reflect whatever the user currently has that
// theme (or theme option, e.g. Colored Toggles' color dropdown) set to, and CSS Loader
// themes can be re-picked without restarting Steam — a value cached from the first
// lookup would go stale the moment they change it. The lookup itself is cheap (a
// handful of getComputedStyle calls on a detached element), so recomputing on every
// PatternPad mount that asks for it isn't worth trading correctness for.
function getThemeAccent(doc: Document): ThemeAccent | null {
  const targetClasses = [
    gamepadSliderClasses?.SliderTrack,
    gamepadDialogClasses?.ToggleRail,
    gamepadSliderClasses?.SliderHandle,
    gamepadDialogClasses?.Toggle,
  ].filter(Boolean) as string[];

  let found: ThemeAccent | null = null;
  try {
    for (const cls of targetClasses) {
      const probe = doc.createElement("div");
      probe.className = cls;
      probe.style.position = "fixed";
      probe.style.top = "-9999px";
      probe.style.left = "-9999px";
      probe.style.pointerEvents = "none";
      doc.body.appendChild(probe);
      const before = doc.defaultView?.getComputedStyle(probe, "::before");
      const bgColor = before?.backgroundColor ?? "";
      const bgImage = before?.backgroundImage ?? "";
      doc.body.removeChild(probe);

      if (bgColor && bgColor !== "rgba(0, 0, 0, 0)" && isCssColor(bgColor, doc)) {
        found = { kind: "color", value: bgColor };
        break;
      }
      if (bgImage && bgImage !== "none") {
        const gradient = parseLinearGradient(bgImage);
        if (gradient) {
          found = { kind: "gradient", ...gradient };
          break;
        }
        // A gradient type we don't parse (radial/conic) — fall back to its first
        // color stop as a plain color rather than not theming it at all.
        const stop = bgImage.match(/#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)|hsla?\([^)]+\)/);
        if (stop && isCssColor(stop[0], doc)) {
          found = { kind: "color", value: stop[0] };
          break;
        }
      }
    }
  } catch (e) {
    console.error("DeckLocker: theme accent lookup failed", e);
  }

  return found;
}

// Shared 3x3 drag-to-connect pattern pad — the credential-entry widget for the
// "pattern" lock method, used by the full-screen PinLockScreen, the compact
// DeckyPanelPinPrompt, the QAM's own self-lock gate, and SetPatternModal so the
// pointer/gamepad handling and line-drawing only exist once.
//
// Two ways to build a sequence, both writing into the same controlled `value` array:
// - Drag: press down on a node and move across others while held — a real drag (the
//   pointer visits a second node before release) calls `onDragComplete` on release,
//   same as Android's unlock-on-lift behavior.
// - Tap-per-node (mouse click without dragging, or gamepad A on a focused node): only
//   adds that one node and waits — lets non-drag input (a controller, or a QAM panel
//   too small/awkward to drag across) build the same sequence one node at a time
//   before the caller's own confirm control (an OK button) submits it.
//
// Hit-testing is geometric (which third of the pad's box the pointer is over), not
// element-based, since the SVG line overlay sits on top of the dots and would
// otherwise intercept elementFromPoint hits.
function PatternPad({
  value,
  onChange,
  onDragComplete,
  disabled,
  status = "neutral",
  useThemeColor = false,
  transparentLine = false,
  size = 72,
  gap = 14,
  shape = "rounded",
  cornerRadius = 14,
  glassEffect = false,
}: {
  value: number[];
  onChange: (nodes: number[]) => void;
  onDragComplete?: (nodes: number[]) => void;
  disabled?: boolean;
  // Recolors the selected dots/lines green ("correct") or red ("incorrect") instead of
  // white — used by SetPatternModal to show whether the confirm draw matched. Takes
  // priority over useThemeColor and transparentLine — a match/mismatch result is a
  // functional signal, not a decorative choice.
  status?: "neutral" | "correct" | "incorrect";
  // Uses the current theme's slider/progress accent color (see getThemeAccent) for the
  // dots/lines instead of plain white, while status is "neutral" — a real multi-stop
  // gradient renders as one, not just its first color.
  useThemeColor?: boolean;
  // Hides the connecting line between dots entirely while status is "neutral" — only
  // the dots themselves show the drawn sequence.
  transparentLine?: boolean;
  size?: number;
  gap?: number;
  // "none" draws bare dots with no surrounding cell background/border — cornerRadius
  // and glassEffect have nothing to apply to in that case.
  shape?: "square" | "rounded" | "circle" | "none";
  cornerRadius?: number;
  glassEffect?: boolean;
}) {
  const containerRef = useRef<SVGSVGElement | null>(null);
  const draggingRef = useRef(false);
  const draggedMultipleRef = useRef(false);
  const [focusedNode, setFocusedNode] = useState<number | null>(null);
  // Resolved lazily once mounted (not synchronously during render) since it needs this
  // instance's own ownerDocument — decky content can render inside a different
  // top-level page than the one holding `document` globally (see getThemeAccent).
  const [themeAccent, setThemeAccent] = useState<ThemeAccent | null>(null);
  useEffect(() => {
    if (!useThemeColor) return;
    const doc = containerRef.current?.ownerDocument ?? document;
    setThemeAccent(getThemeAccent(doc));
  }, [useThemeColor]);
  // A stable id for this instance's <linearGradient> def — SVG gradient references are
  // per-document by id, so each mounted PatternPad needs its own to avoid colliding
  // with another instance's (e.g. the lock screen behind an open SetPatternModal).
  const gradientIdRef = useRef(`decklocker-pattern-gradient-${Math.random().toString(36).slice(2)}`);

  const getNodeAtClientPoint = (x: number, y: number): number | null => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return null;
    const col = Math.min(2, Math.max(0, Math.floor(((x - rect.left) / rect.width) * 3)));
    const row = Math.min(2, Math.max(0, Math.floor(((y - rect.top) / rect.height) * 3)));
    return row * 3 + col;
  };

  const addNode = (index: number) => {
    if (disabled || value.includes(index)) return;
    onChange([...value, index]);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    const idx = getNodeAtClientPoint(e.clientX, e.clientY);
    if (idx === null) return;
    containerRef.current?.setPointerCapture?.(e.pointerId);
    draggingRef.current = true;
    draggedMultipleRef.current = false;
    addNode(idx);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current || disabled) return;
    const idx = getNodeAtClientPoint(e.clientX, e.clientY);
    if (idx === null || value.includes(idx)) return;
    draggedMultipleRef.current = true;
    onChange([...value, idx]);
  };

  const endDrag = () => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    if (draggedMultipleRef.current && value.length > 0) onDragComplete?.(value);
  };

  const dotSize = Math.round(size * 0.32);
  const gridPx = size * 3 + gap * 2;
  const keyBorderRadius = shape === "circle" ? "50%" : shape === "square" ? "0px" : `${cornerRadius}px`;
  const cellBg = shape === "none" ? {} : glassEffect ? FROSTED_GLASS_STYLE : { background: "rgba(255,255,255,0.06)" };

  const centerOf = (index: number) => {
    const row = Math.floor(index / 3);
    const col = index % 3;
    return { x: col * (size + gap) + size / 2, y: row * (size + gap) + size / 2 };
  };

  const isNeutral = status === "neutral";
  const themeGradient = isNeutral && useThemeColor && themeAccent?.kind === "gradient" ? themeAccent : null;
  const themeGradientCss = themeGradient ? `linear-gradient(${themeGradient.angleDeg}deg, ${themeGradient.colors.join(", ")})` : null;
  const neutralColor = useThemeColor
    ? themeAccent?.kind === "color"
      ? themeAccent.value
      : themeGradient
      ? themeGradient.colors[0]
      : "#fff"
    : "#fff";
  const statusColor = status === "correct" ? "#4caf50" : status === "incorrect" ? "#f44336" : neutralColor;
  // transparentLine only hides the connecting line while neutral — an incorrect/correct
  // result is still a functional signal and stays visible on the line too.
  const lineStroke = !isNeutral ? statusColor : transparentLine ? "transparent" : themeGradient ? `url(#${gradientIdRef.current})` : neutralColor;
  const dotFillCss = !isNeutral ? statusColor : themeGradientCss ?? neutralColor;

  return (
    // Focusable (not a plain div) so Steam's spatial nav actually registers this as a
    // grid and moves the D-pad between the 9 dot Focusables below — same fix as the
    // numeric keypad's own grid and the Cancel/OK row (a plain div here left the dots
    // unreachable by D-pad, gamepad-focusable only by accident via tab order).
    <Focusable
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      style={{
        position: "relative",
        width: `${gridPx}px`,
        height: `${gridPx}px`,
        display: "grid",
        gridTemplateColumns: `repeat(3, ${size}px)`,
        gridTemplateRows: `repeat(3, ${size}px)`,
        gap: `${gap}px`,
        touchAction: "none",
      }}
    >
      {/* containerRef lives on this plain <svg>, not the Focusable above, for
          measurement/pointer-capture and to resolve the right document for
          getThemeAccent — Focusable is pulled dynamically from Steam's own
          runtime (like TextField) and isn't used anywhere else in this codebase with a
          ref, so its ref-forwarding isn't something to depend on; a real intrinsic
          element is. Same box (absolute, inset 0) as the Focusable, so its rect is
          equivalent for hit-testing, and pointer capture set here still bubbles the
          resulting move/up events up to the Focusable's own handlers above. */}
      <svg
        ref={containerRef}
        width={gridPx}
        height={gridPx}
        style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
      >
        {themeGradient && (
          <defs>
            <linearGradient
              id={gradientIdRef.current}
              gradientUnits="userSpaceOnUse"
              {...gradientAngleToSvgVector(themeGradient.angleDeg, gridPx)}
            >
              {themeGradient.colors.map((color, i) => (
                <stop key={i} offset={`${(i / (themeGradient.colors.length - 1)) * 100}%`} stopColor={color} />
              ))}
            </linearGradient>
          </defs>
        )}
        {value.slice(1).map((node, i) => {
          const from = centerOf(value[i]);
          const to = centerOf(node);
          return (
            <line
              key={node}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              stroke={lineStroke}
              strokeWidth={4}
              strokeLinecap="round"
              opacity={0.85}
            />
          );
        })}
      </svg>
      {Array.from({ length: 9 }).map((_, index) => {
        const selected = value.includes(index);
        return (
          <Focusable
            key={index}
            onGamepadFocus={() => setFocusedNode(index)}
            onGamepadBlur={() => setFocusedNode((prev) => (prev === index ? null : prev))}
            onActivate={() => addNode(index)}
            style={{
              width: `${size}px`,
              height: `${size}px`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: keyBorderRadius,
              boxSizing: "border-box",
              overflow: "hidden",
              ...cellBg,
            }}
          >
            <div
              style={{
                width: `${dotSize}px`,
                height: `${dotSize}px`,
                borderRadius: "50%",
                boxSizing: "border-box",
                border: selected
                  ? `2px solid ${statusColor}`
                  : focusedNode === index
                  ? "2px solid #fff"
                  : "2px solid rgba(255,255,255,0.4)",
                background: selected ? dotFillCss : "transparent",
              }}
            />
          </Focusable>
        );
      })}
    </Focusable>
  );
}

// Shared Knock Code pad — LG's old lock screen feature: a 2x2 grid of blank cells,
// tapped in sequence (repeats of the same cell allowed, unlike Pattern's no-repeat
// dots — nothing here tracks which cells are "already used"). Used by the full-screen
// PinLockScreen, the compact DeckyPanelPinPrompt, the QAM's own self-lock gate, and
// SetKnockCodeModal — each caller owns the actual tap sequence (number[], 0-3 per
// tap) and gets an onTap(index) callback here. The sequence itself round-trips via
// sequenceToString, same as Pattern.
//
// Deliberately minimal customization surface (see tap_code_show_outline/
// tap_code_show_dividers in Customization): no per-cell background, shape, or
// outline — a cell is just a plain transparent tap target — the ONLY visible chrome
// is one outline around the whole grid and, optionally, divider lines splitting it
// into 4 quadrants.
function KnockCodePad({
  onTap,
  disabled,
  status = "neutral",
  showOutline = true,
  showDividers = false,
  fluid = false,
  size = 80,
  gap = 14,
}: {
  onTap: (index: number) => void;
  disabled?: boolean;
  // Recolors the outline around the whole grid green ("correct") or red
  // ("incorrect") — used by SetKnockCodeModal to show whether the confirm tap
  // sequence matched. No per-cell coloring, since which cells were tapped isn't
  // shown persistently in the first place (repeats make that ambiguous). Shows even
  // when showOutline is off — a match/mismatch result is a functional signal, not a
  // decorative choice.
  status?: "neutral" | "correct" | "incorrect";
  showOutline?: boolean;
  showDividers?: boolean;
  // Fills 100% of the parent's width — the same technique the Cancel/OK row below it
  // already uses — instead of a fixed 2-column pixel grid. A 2-column grid at the same
  // per-cell size as Pattern's 3-column one is inherently narrower, so matching
  // Pattern's actual footprint means matching its *container* width, not its cell
  // size. Height then comes from a 1:1 aspect-ratio on the whole box (so it stays
  // square whatever that width actually renders as, e.g. the compact QAM panel's own
  // width) rather than from `size`, which fluid mode ignores.
  fluid?: boolean;
  size?: number;
  gap?: number;
}) {
  const tap = (index: number) => {
    if (disabled) return;
    onTap(index);
  };

  const outlineColor = status === "correct" ? "#4caf50" : status === "incorrect" ? "#f44336" : "rgba(255,255,255,0.4)";
  const borderStyle = status !== "neutral" || showOutline ? `2px solid ${outlineColor}` : "2px solid transparent";

  return (
    <Focusable
      style={{
        position: "relative",
        display: "grid",
        width: fluid ? "100%" : undefined,
        aspectRatio: fluid ? "1 / 1" : undefined,
        gridTemplateColumns: fluid ? "repeat(2, 1fr)" : `repeat(2, ${size}px)`,
        gridTemplateRows: fluid ? "repeat(2, 1fr)" : `repeat(2, ${size}px)`,
        gap: `${gap}px`,
        padding: `${gap}px`,
        boxSizing: fluid ? "border-box" : "content-box",
        border: borderStyle,
        borderRadius: "16px",
      }}
    >
      {showDividers && (
        <>
          <div
            style={{
              position: "absolute",
              left: "50%",
              top: `${gap}px`,
              bottom: `${gap}px`,
              width: "1px",
              background: "rgba(255,255,255,0.3)",
              transform: "translateX(-50%)",
              pointerEvents: "none",
            }}
          />
          <div
            style={{
              position: "absolute",
              top: "50%",
              left: `${gap}px`,
              right: `${gap}px`,
              height: "1px",
              background: "rgba(255,255,255,0.3)",
              transform: "translateY(-50%)",
              pointerEvents: "none",
            }}
          />
        </>
      )}
      {Array.from({ length: 4 }).map((_, index) => (
        <Focusable
          key={index}
          onActivate={() => tap(index)}
          style={{
            width: fluid ? "100%" : `${size}px`,
            height: fluid ? "100%" : `${size}px`,
            // Grid items default to min-width/min-height: auto, refusing to shrink
            // below their content's natural size — Steam's own DialogButton has an
            // intrinsic minimum width, so at a narrow enough container (fluid mode,
            // shrunk 15% for Knock Code) each cell overflowed past its 1fr track and
            // past the outline/dividers around it, rather than actually shrinking to
            // fit. Same fix as the Cancel/OK row elsewhere in this file.
            minWidth: 0,
            minHeight: 0,
            overflow: "hidden",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <DialogButton
            onClick={() => tap(index)}
            disabled={disabled}
            style={{ width: "100%", height: "100%", minWidth: 0, boxSizing: "border-box", background: "transparent", border: "none" }}
          />
        </Focusable>
      ))}
    </Focusable>
  );
}

// Shared Cancel/OK button row used by PinLockScreen's Password, Pattern, and Knock
// Code variants below (PIN's own Cancel/OK are keypad cells, not this row). Pattern
// and Knock Code repurpose the Cancel button as "Clear" while their entry has content
// (see onPatternClearOrCancel/onKnockClearOrCancel) by passing that in as cancelLabel.
// glassStyle is omitted for Knock Code — action_button_glass_effect intentionally
// doesn't apply there (see that setting's own comment on DeckLockerSettings: Knock
// Code's customization is deliberately minimal).
//
// Grid (not flex: 1 children) so minWidth: 0 actually takes — flex items default to
// min-width: auto and refuse to shrink below their own content's natural width no
// matter what the row's own width says, which is why an earlier flex version stayed
// pinned at DialogButton's ~160px each and overflowed past the field's edge regardless
// of the row's explicit width (confirmed by inspecting the live DOM: the row's own
// inline width WAS right, the buttons just ignored it). Each button gets its own
// nested Focusable, same as every keypad key in PinLockScreen, so gamepad left/right
// lands between them correctly instead of skipping past this row.
function CancelOkRow({
  cancelLabel,
  onCancel,
  onOk,
  glassStyle,
}: {
  cancelLabel: string;
  onCancel: () => void;
  onOk: () => void;
  glassStyle?: object;
}) {
  return (
    <Focusable style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", width: "100%" }}>
      <Focusable style={{ minWidth: 0 }}>
        <DialogButton onClick={onCancel} style={{ width: "100%", minWidth: 0, boxSizing: "border-box", ...glassStyle }}>
          {cancelLabel}
        </DialogButton>
      </Focusable>
      <Focusable style={{ minWidth: 0 }}>
        <DialogButton onClick={onOk} style={{ width: "100%", minWidth: 0, boxSizing: "border-box", ...glassStyle }}>
          OK
        </DialogButton>
      </Focusable>
    </Focusable>
  );
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
  libraryMode,
}: {
  appid: string;
  appName: string;
  closeModal?: () => void;
  onUnlocked?: () => void;
  settling?: boolean;
  onDismiss?: () => void;
  // Used for the Library route lock (see openLibraryRouteLockModal): same full-screen
  // keypad layout as a game's own lock screen, but there's no real app behind it —
  // skips art loading (no appid to look up) and app-specific unlock/cancel side effects
  // (unlockedThisSession/terminateAppAggressively, both meant for actual running games),
  // and shows a plain text label where the cover art would otherwise go.
  libraryMode?: boolean;
}) {
  const [digits, setDigits] = useState<string[]>([]);
  // Only used when lockMethod is "password" — the numeric keypad above stays PIN-only,
  // this is the parallel text-entry value for the password variant of this same screen
  // (see the isPassword branch below).
  const [passwordValue, setPasswordValue] = useState("");
  const passwordFieldWrapperRef = useRef<HTMLDivElement | null>(null);
  // Only used when lockMethod is "pattern" — the sequence of dot indices (0-8) drawn
  // so far, in order. See the isPattern branch below and PatternPad.
  const [patternNodes, setPatternNodes] = useState<number[]>([]);
  // Only used when lockMethod is "tap_code" — the sequence of cell indices (0-3)
  // tapped so far, in order, repeats allowed. See the isTapCode branch below and
  // KnockCodePad.
  const [knockSequence, setKnockSequence] = useState<number[]>([]);
  const [focusedKeyKey, setFocusedKeyKey] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useHideSteamFooter(rootRef);

  const lockMethod = cachedSettings?.lock_method ?? "pin";
  const isPassword = lockMethod === "password";
  const isPattern = lockMethod === "pattern";
  const isTapCode = lockMethod === "tap_code";
  const enteredLength = isPassword
    ? passwordValue.length
    : isPattern
    ? patternNodes.length
    : isTapCode
    ? knockSequence.length
    : digits.length;

  // Hides the real typed characters (bIsPassword doesn't actually mask text in Steam's
  // UI) so the dot indicator below is the only thing visibly showing password length —
  // same technique as DeckyPanelPinPrompt's PIN field. textAlign is this screen's own
  // addition (not applied to DeckyPanelPinPrompt's field) — centers the dot overlay
  // over the field the same way this full-screen layout centers everything else.
  useEffect(() => {
    if (!isPassword) return;
    const input = passwordFieldWrapperRef.current?.querySelector("input") as HTMLInputElement | null;
    if (input) {
      input.style.color = "transparent";
      input.style.caretColor = "transparent";
      (input.style as any).WebkitTextFillColor = "transparent";
      input.style.textAlign = "center";
    }
  }, [isPassword]);


  // Steam's on-screen keyboard (id "virtual keyboard") renders correctly and still
  // takes input while this is up, but visually ends up UNDER this screen's own
  // zIndex: 999999 backdrop — chosen to sit above everything else on the page, which
  // the keyboard apparently doesn't clear. Watched via MutationObserver (rather than a
  // one-time lookup) since the keyboard mounts asynchronously when the field gains
  // focus, well after this component's own mount. Bumped one above our own backdrop,
  // not to some arbitrarily larger number, so it stays correctly under anything else
  // that legitimately needs to sit above this whole screen.
  useEffect(() => {
    if (!isPassword) return;
    const doc = rootRef.current?.ownerDocument;
    const view = doc?.defaultView;
    if (!doc || !view) return;
    const applyKeyboardZIndex = () => {
      const kb = doc.getElementById("virtual keyboard") as HTMLElement | null;
      if (kb && kb.style.zIndex !== "1000000") kb.style.zIndex = "1000000";
    };
    applyKeyboardZIndex();
    const observer = new view.MutationObserver(applyKeyboardZIndex);
    observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["style"] });
    return () => observer.disconnect();
  }, [isPassword]);

  const [error, setError] = useState("");
  const [pinStatus, setPinStatus] = useState<"neutral" | "correct" | "incorrect">("neutral");
  const [checking, setChecking] = useState(false);
  const [artSource, setArtSource] = useState<"capsule" | "header" | "local" | "none">(libraryMode ? "none" : "local");
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
    if (libraryMode || artSource !== "local") return;
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
    if (enteredLength === 0 || checking || pinStatus === "incorrect") return;
    setChecking(true);
    const value = isPassword
      ? passwordValue
      : isPattern
      ? sequenceToString(patternNodes)
      : isTapCode
      ? sequenceToString(knockSequence)
      : digits.join("");
    const ok = await checkCredential(lockMethod, value);
    setChecking(false);
    if (ok) {
      playUnlockSound();
      if (!libraryMode && appid) unlockedThisSession.add(appid);
      setPinStatus("correct");
      onUnlocked?.();
      closeModal?.();
      onDismiss?.();
    } else {
      setError(`Incorrect ${credentialLabel(lockMethod)}`);
      setPinStatus("incorrect");
      setTimeout(() => {
        setPinStatus("neutral");
        setError("");
        setDigits([]);
        setPasswordValue("");
        setPatternNodes([]);
        setKnockSequence([]);
      }, 2000);
    }
  };

  const onPasswordChange = (next: string) => {
    if (checking || pinStatus === "incorrect") return;
    setError("");
    setPasswordValue(next);
  };

  const onPatternChange = (nodes: number[]) => {
    if (checking || pinStatus === "incorrect") return;
    setError("");
    setPatternNodes(nodes);
  };

  // A real drag gesture submits on release, same as Android — tap-per-node input
  // (gamepad, or a click without dragging) waits for the explicit OK button instead.
  const onPatternDragComplete = () => {
    onOk();
  };

  // Clears the in-progress pattern while any nodes are selected, cancels out of the
  // screen once it's already empty (see clearOrCancel).
  const onPatternClearOrCancel = () => clearOrCancel(patternNodes, setPatternNodes, onCancel);

  const onKnockTap = (index: number) => {
    if (checking || pinStatus === "incorrect") return;
    setError("");
    setKnockSequence((prev) => [...prev, index]);
  };

  // Same dual-purpose convention as onPatternClearOrCancel above.
  const onKnockClearOrCancel = () => clearOrCancel(knockSequence, setKnockSequence, onCancel);

  const onCancel = () => {
    if (!libraryMode) terminateAppAggressively(appid);
    // Navigate away before closing the gate itself, not after — closing first left the
    // real page behind it visible for a frame before the navigation actually took over.
    Navigation.NavigateBack();
    closeModal?.();
    onDismiss?.();
  };

  // Acts as Delete while digits are entered, Cancel when the field is empty.
  const onBottomLeftKey = () => {
    if (digits.length > 0) {
      backspace();
    } else {
      onCancel();
    }
  };

  const glassEffect = cachedSettings?.keypad_glass_effect ?? false;
  const keypadOnRight = cachedSettings?.keypad_on_right ?? false;
  const hideGameArt = cachedSettings?.hide_game_art ?? false;
  // Shared background applied to keypad cells and the art placeholder so they match visually.
  const panelBg = glassEffect
    ? { ...FROSTED_GLASS_STYLE, boxShadow: "inset 0 1px 1px rgba(255,255,255,0.3)" }
    : { background: "rgba(255,255,255,0.06)" };

  // Applied to Password's and Pattern's own Cancel/OK DialogButtons — PIN's own
  // Cancel/OK are keypad cells and already get panelBg above, but Password/Pattern's
  // dedicated button row otherwise renders as Steam's plain flat DialogButton.
  const actionButtonGlassStyle = cachedSettings?.action_button_glass_effect ? FROSTED_GLASS_STYLE : {};

  const keypadShape = cachedSettings?.keypad_shape ?? "rounded";
  // Circle shape shrinks the visible cell within its grid slot (same ~78% ratio as the
  // original fixed 72/92px sizes) so circles keep a gap between them, like square keys.
  const keySize = cachedSettings?.keypad_key_size ?? 80;
  const circleKeySize = Math.round(keySize * (72 / 92));
  const keyBorderRadius =
    keypadShape === "circle" ? "50%" : keypadShape === "square" ? "0px" : `${cachedSettings?.keypad_corner_radius ?? 14}px`;

  // Knock Code's own container — 15% narrower than Password/Pattern's. Height comes
  // from KnockCodePad's own 1:1 aspect-ratio in fluid mode, not a computed size here.
  const knockContainerWidth = Math.round((keySize * 3 + 28) * 1.15 * 0.85);
  const knockGap = 17;

  // Digit font size is user-adjustable; the smaller hint labels (CANCEL/OK) and the
  // backspace icon scale proportionally so the keypad stays visually balanced.
  const keyFontSize = cachedSettings?.keypad_font_size ?? 22;
  const hintFontSize = Math.round(keyFontSize * (14 / 22));
  const backspaceIconSize = Math.round(keyFontSize * (20 / 22));

  // Controller mapping: A = select (Focusable default), B = Delete/Cancel, X = OK.
  const keypadButtons: { key: string; label: string | ReactNode; hint?: string; onClick: () => void; fontSize: string }[] = [
    { key: "1", label: "1", onClick: () => press("1"), fontSize: `${keyFontSize}px` },
    { key: "2", label: "2", onClick: () => press("2"), fontSize: `${keyFontSize}px` },
    { key: "3", label: "3", onClick: () => press("3"), fontSize: `${keyFontSize}px` },
    { key: "4", label: "4", onClick: () => press("4"), fontSize: `${keyFontSize}px` },
    { key: "5", label: "5", onClick: () => press("5"), fontSize: `${keyFontSize}px` },
    { key: "6", label: "6", onClick: () => press("6"), fontSize: `${keyFontSize}px` },
    { key: "7", label: "7", onClick: () => press("7"), fontSize: `${keyFontSize}px` },
    { key: "8", label: "8", onClick: () => press("8"), fontSize: `${keyFontSize}px` },
    { key: "9", label: "9", onClick: () => press("9"), fontSize: `${keyFontSize}px` },
    {
      key: "bottomleft",
      label: digits.length > 0 ? <FaBackspace size={backspaceIconSize} /> : "CANCEL",
      hint: "B",
      onClick: onBottomLeftKey,
      fontSize: `${hintFontSize}px`,
    },
    { key: "0", label: "0", onClick: () => press("0"), fontSize: `${keyFontSize}px` },
    { key: "ok", label: "OK", hint: "X", onClick: onOk, fontSize: `${hintFontSize}px` },
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
        flexDirection: hideGameArt ? "column" : (keypadOnRight ? "row-reverse" : "row"),
        alignItems: hideGameArt ? "center" : undefined,
        justifyContent: hideGameArt ? "center" : undefined,
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
      {/* Hidden probe image used to detect CDN failures; background-image has no onError of its own. */}
      {cachedSettings?.lockscreen_hero_bg_enabled && heroBgSource === "cdn" && (
        <img
          src={`https://cdn.akamai.steamstatic.com/steam/apps/${appid}/library_hero.jpg`}
          onError={() => setHeroBgSource("none")}
          style={{ display: "none" }}
        />
      )}

      {/* Left panel: status text, credential-length dot indicator, and the numeric
          keypad grid (PIN) or text field + buttons (Password). */}
      <div
        style={{
          width: hideGameArt ? "auto" : "50%",
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
            error || `Enter ${credentialLabel(lockMethod)}`
          )}
        </div>

        {/* Password's own field shows its own dot overlay, and Pattern's own grid shows
            selection via filled/connected dots — this shared row is the PIN keypad's
            only length indicator, so it's skipped for both to avoid double-counting. */}
        {!isPassword && !isPattern && (
          <div
            style={{
              display: "flex",
              gap: "10px",
              // Knock Code sits noticeably closer below this row than PIN's numeric
              // grid does — the grid itself already reads as a distinct block thanks
              // to its own outline, so it doesn't need as much breathing room above it.
              marginBottom: isTapCode ? "8px" : "24px",
              minHeight: "16px",
              animation: pinStatus === "incorrect" ? "decklocker-shake 0.4s ease-in-out" : undefined,
            }}
          >
            {enteredLength === 0 && <div style={{ width: "14px", height: "14px" }} />}
            {Array.from({ length: enteredLength }).map((_, i) => (
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
        )}

        {isPassword ? (
          // Password variant: a hidden-text field (dots overlaid on the field itself
          // show length — no separate dot row, see above) plus explicit Cancel/OK
          // buttons in place of the numeric keypad grid. This container is sized 15%
          // past the keypad's own footprint (keySize * 3 + 28) — a password field reads
          // as cramped at the same width the 3-column digit grid needs. TextField fills
          // 100% of this container on its own (confirmed live), so Cancel/OK below are
          // just given the same 100% rather than a value read off the field's own
          // rendered box — reading getBoundingClientRect() here previously caught the
          // field mid-way through its modal entrance scale animation and froze that
          // shrunken width in state, since a pure CSS transform never fires a
          // ResizeObserver (the layout box itself never changes size, only its painted
          // one) — that's exactly what left Cancel+OK narrower than the field.
          <Focusable
            onCancelButton={onCancel}
            onSecondaryButton={onOk}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "12px",
              marginTop: "6px",
              width: `${Math.round((keySize * 3 + 28) * 1.15)}px`,
            }}
          >
            <div ref={passwordFieldWrapperRef} style={{ position: "relative" }}>
              {/* Plain TextField, same as DeckyPanelPinPrompt's field — no extra
                  wrapping Focusable. An earlier attempt wrapped this in its own nested
                  Focusable to try to force gamepad-nav focus onto the input, but Steam's
                  own gamepad-nav periodically re-asserts focus onto ITS OWN Focusable
                  landing target, which blurred the real <input> a couple of seconds in
                  and dismissed the on-screen keyboard mid-type. Matching the compact
                  field's plain (unwrapped) approach avoids that extra Focusable
                  registration entirely. */}
              <TextField
                value={passwordValue}
                onChange={(e) => onPasswordChange(e.target.value)}
                bIsPassword={true}
                focusOnMount={true}
              />
              {/* Same dot overlay as DeckyPanelPinPrompt's field, centered instead of
                  left-aligned — this screen's own variant, not a change to that
                  component. */}
              {passwordValue.length > 0 && (
                <div
                  style={{
                    position: "absolute",
                    left: 0,
                    right: 0,
                    top: 0,
                    bottom: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: "6px",
                    pointerEvents: "none",
                    mixBlendMode: "difference",
                  }}
                >
                  {passwordValue.split("").map((_, i) => (
                    <div key={i} style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#fff" }} />
                  ))}
                </div>
              )}
            </div>
            <CancelOkRow cancelLabel="Cancel" onCancel={onCancel} onOk={onOk} glassStyle={actionButtonGlassStyle} />
          </Focusable>
        ) : isPattern ? (
          // Pattern variant: the drag-to-connect PatternPad in place of the numeric
          // keypad, plus the same Clear/Cancel-and-OK row as Password — Clear instead of
          // a lone Cancel since a mis-drawn pattern is more naturally undone by wiping
          // the whole grid than by removing one node at a time (see
          // onPatternClearOrCancel, the same dual-purpose convention as the PIN keypad's
          // own bottom-left key).
          <Focusable
            onCancelButton={onPatternClearOrCancel}
            onSecondaryButton={onOk}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "16px",
              marginTop: "6px",
            }}
          >
            <PatternPad
              value={patternNodes}
              onChange={onPatternChange}
              onDragComplete={onPatternDragComplete}
              disabled={checking || pinStatus === "incorrect"}
              useThemeColor={cachedSettings?.pattern_line_theme_color ?? false}
              transparentLine={cachedSettings?.pattern_line_transparent ?? false}
              size={cachedSettings?.pattern_dot_size ?? 72}
              gap={14}
              shape={cachedSettings?.pattern_dot_shape ?? "rounded"}
              cornerRadius={cachedSettings?.pattern_corner_radius ?? 14}
              glassEffect={cachedSettings?.pattern_glass_effect ?? false}
            />
            <CancelOkRow
              cancelLabel={patternNodes.length > 0 ? "Clear" : "Cancel"}
              onCancel={onPatternClearOrCancel}
              onOk={onOk}
              glassStyle={actionButtonGlassStyle}
            />
          </Focusable>
        ) : isTapCode ? (
          // Knock Code variant: the 2x2 KnockCodePad grid in place of the numeric
          // keypad/pattern grid, plus the same Clear/Cancel-and-OK row as Pattern —
          // Clear wipes the tap sequence built up so far (see onKnockClearOrCancel,
          // the same dual-purpose convention as the PIN keypad's own bottom-left key).
          <Focusable
            onCancelButton={onKnockClearOrCancel}
            onSecondaryButton={onOk}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "16px",
              marginTop: "6px",
              // 15% narrower than Password/Pattern's own container — both the
              // Cancel/OK row and the KnockCodePad grid (fluid, width:100% of this)
              // stay matched to each other since they're sized off this same width.
              width: `${knockContainerWidth}px`,
            }}
          >
            <KnockCodePad
              onTap={onKnockTap}
              disabled={checking || pinStatus === "incorrect"}
              showOutline={cachedSettings?.tap_code_show_outline ?? true}
              showDividers={cachedSettings?.tap_code_show_dividers ?? false}
              fluid
              gap={knockGap}
            />
            <CancelOkRow
              cancelLabel={knockSequence.length > 0 ? "Clear" : "Cancel"}
              onCancel={onKnockClearOrCancel}
              onOk={onOk}
            />
          </Focusable>
        ) : (
        /* Single flat Focusable grid so Steam's spatial nav moves between keys
            correctly without jumping to the first item of the next row. */
        <Focusable
          onCancelButton={onBottomLeftKey}
          onSecondaryButton={onOk}
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(3, ${keySize}px)`,
            gridAutoRows: `${keySize}px`,
            gap: "14px",
            justifyItems: "center",
            alignItems: "center",
          }}
        >
          {keypadButtons.map((btn) => (
            <div
              key={btn.key}
              style={{
                width: keypadShape === "circle" ? `${circleKeySize}px` : `${keySize}px`,
                height: keypadShape === "circle" ? `${circleKeySize}px` : `${keySize}px`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                overflow: "hidden",
                boxSizing: "border-box",
                borderRadius: keyBorderRadius,
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
                      lineHeight: `${keyFontSize}px`,
                      height: `${keyFontSize}px`,
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
        )}
      </div>

      {/* Right panel: game cover art (local → capsule CDN → header CDN) and title. */}
      {!hideGameArt && <div
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
          {artSource === "none" && !libraryMode && <FaLock size={64} />}
          {libraryMode && (
            <div style={{ padding: "0 16px", textAlign: "center", fontSize: "18px", fontWeight: 600, opacity: 0.85 }}>
              View more in your Library
            </div>
          )}
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

// Whether the Decky-panel PIN gate is currently shown, substituted in place of the
// real Decky tab panel (plugin list / active plugin). Read synchronously by
// DeckyTabGate (a component actually mounted inside the QAM's own render tree) rather
// than a routerHook.addGlobalComponent overlay — the QAM's content renders inside a
// separate, natively-composited Steam browser view, so a same-window overlay can never
// visually appear on top of it no matter its z-index.
let deckyPanelGateVisible = false;

// Cache of the QAM tab panel's actual on-screen width, captured from a tab that renders
// its width correctly (i.e. any DeckyPanelPinPrompt instance not opting into
// forceCollapsedWidth). The Friends tab is the one exception: Steam gives its container
// a dynamic width tied to its own (unmounted, since we substitute its content) expanded/
// collapsed chat state, so left alone it renders at that tab's "expanded" width even
// while the QAM itself is still showing the narrow collapsed panel. Reusing a width
// measured from a normal tab and forcing it onto Friends' container (see
// forceCollapsedWidth below) sidesteps needing to know Steam's own expand/collapse state.
let knownTabPanelWidthPx: number | null = null;

// Simple text-field-and-button PIN prompt, same style as the "Lock This Plugin" gate —
// as opposed to PinLockScreen's full numeric keypad, which doesn't fit well substituted
// into the QAM's own (narrower) panel area alongside the rest of the QAM's tabs.
// Compact "Enter <credential>" entry UI shared by DeckyPanelPinPrompt (QAM tab gate,
// plugin gate, Main Menu item gate) and the QAM self-lock gate in Content(): a length-
// feedback dot row (Knock Code only), then the method's own input — PatternPad,
// KnockCodePad, or a masked TextField with a dot overlay showing entered length (the
// dots use mix-blend-mode: difference instead of a fixed background color — Steam's
// native focus style turns the input's background white, and a hardcoded dark
// background would both fight that and drift from whatever theme is active; a
// difference blend stays visible against light or dark automatically).
function CredentialCompactEntry({
  lockMethod,
  pin,
  onPinChange,
  pattern,
  onPatternChange,
  onPatternSubmit,
  patternSettings,
  knock,
  onKnockTap,
  knockSettings,
}: {
  lockMethod: LockMethod;
  pin: string;
  onPinChange: (value: string) => void;
  pattern: number[];
  onPatternChange: (nodes: number[]) => void;
  onPatternSubmit: () => void;
  patternSettings: {
    lineThemeColor: boolean;
    lineTransparent: boolean;
    dotShape: "square" | "rounded" | "circle" | "none";
    cornerRadius: number;
    glassEffect: boolean;
  };
  knock: number[];
  onKnockTap: (index: number) => void;
  knockSettings: { showOutline: boolean; showDividers: boolean };
}) {
  const isPattern = lockMethod === "pattern";
  const isTapCode = lockMethod === "tap_code";
  const isPassword = lockMethod === "password";
  const pinWrapperRef = useRef<HTMLDivElement | null>(null);

  // Hides the real typed characters (bIsPassword doesn't actually mask text in Steam's
  // UI) so the dot overlay below is the only thing visibly showing entry length.
  useEffect(() => {
    const input = pinWrapperRef.current?.querySelector("input") as HTMLInputElement | null;
    if (input) {
      input.style.color = "transparent";
      input.style.caretColor = "transparent";
      (input.style as any).WebkitTextFillColor = "transparent";
    }
  }, [pin]);

  return (
    <>
      {/* Knock Code cells show no persistent fill (see KnockCodePad), so this is the
          only length feedback in this compact view — the full lock screen already gets
          an equivalent row for free via its shared PIN-style indicator. */}
      {isTapCode && (
        <PanelSectionRow>
          <div style={{ display: "flex", justifyContent: "center", gap: "6px", minHeight: "10px", marginTop: "8px" }}>
            {knock.map((_, i) => (
              <div key={i} style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#fff" }} />
            ))}
          </div>
        </PanelSectionRow>
      )}
      {isPattern ? (
        <PanelSectionRow>
          <div style={{ display: "flex", justifyContent: "center", marginTop: "12px" }}>
            <PatternPad
              value={pattern}
              onChange={onPatternChange}
              onDragComplete={onPatternSubmit}
              useThemeColor={patternSettings.lineThemeColor}
              transparentLine={patternSettings.lineTransparent}
              size={55}
              gap={12}
              shape={patternSettings.dotShape}
              cornerRadius={patternSettings.cornerRadius}
              glassEffect={patternSettings.glassEffect}
            />
          </div>
        </PanelSectionRow>
      ) : isTapCode ? (
        <PanelSectionRow>
          <div style={{ display: "flex", justifyContent: "center", marginTop: "12px" }}>
            {/* fluid sizes KnockCodePad to 100% of ITS OWN parent, so that parent needs
                an explicit width here rather than inheriting whatever the ambient QAM
                panel happens to provide — the QAM's real rendered width isn't the same
                on every tab (the Friends tab in particular gets a different container
                than the rest, see BUILTIN_LOCKABLE_TABS/forceCollapsedWidth), which
                otherwise rendered this grid at a visibly different size there than on
                other tabs. Fixed at Pattern's own compact footprint (size 55, gap 12 →
                55*3 + 12*2 = 189px) so both look identically sized, and identically on
                every tab, the same fixed-width-wrapper technique PinLockScreen's own
                full-screen KnockCodePad already uses (knockContainerWidth). */}
            <div style={{ width: "189px" }}>
              <KnockCodePad
                onTap={onKnockTap}
                showOutline={knockSettings.showOutline}
                showDividers={knockSettings.showDividers}
                fluid
                gap={12}
              />
            </div>
          </div>
        </PanelSectionRow>
      ) : (
        <PanelSectionRow>
          <div ref={(el) => { pinWrapperRef.current = el; }} style={{ position: "relative" }}>
            <TextField
              value={pin}
              onChange={(e) => onPinChange(isPassword ? e.target.value : e.target.value.replace(/\D/g, ""))}
              bIsPassword={true}
              focusOnMount={true}
            />
            {pin.length > 0 && (
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
                  mixBlendMode: "difference",
                }}
              >
                {pin.split("").map((_, i) => (
                  <div key={i} style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#fff" }} />
                ))}
              </div>
            )}
          </div>
        </PanelSectionRow>
      )}
    </>
  );
}

function DeckyPanelPinPrompt({
  title,
  plainTitle,
  forceCollapsedWidth,
  onBack,
  onUnlocked,
}: {
  title?: string;
  // Renders `title` as plain bold text instead of QAM's own title-bar styling
  // (staticClasses.Title) — used for the Main Menu, where every real row is just plain
  // text with no special background of its own, so the QAM-style title bar looked out
  // of place (the original "only the title has a background" complaint).
  plainTitle?: boolean;
  forceCollapsedWidth?: boolean;
  onBack?: () => void;
  onUnlocked: () => void;
}) {
  const [pin, setPin] = useState("");
  const [patternNodes, setPatternNodes] = useState<number[]>([]);
  const [knockSequence, setKnockSequence] = useState<number[]>([]);
  const [error, setError] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);

  // This component can stay mounted for a whole session (the QAM tab gate, plugin
  // gate, and Main Menu item gate don't unmount it on close/reopen, just toggle
  // visibility elsewhere), so without this, changing the Lock Method in settings never
  // caused a re-render here and this kept showing the old method's entry UI below
  // (lockMethod is read straight from cachedSettings each render, not tracked state).
  useCachedSettingsVersion();

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    if (!forceCollapsedWidth) {
      // A normally-sized tab (Decky, other plugins, other built-in tabs) — trust its
      // ambient container width as the reference for Friends to match.
      const w = root.parentElement?.getBoundingClientRect().width;
      if (w && w > 0) knownTabPanelWidthPx = w;
      return;
    }

    // Friends: walk up until we find (and clamp) any ancestor whose inline width is
    // wider than the known-good collapsed panel width, and keep re-clamping if Steam's
    // own code changes it later (e.g. in response to the chat-expand state it thinks
    // it's in).
    const applyClamp = () => {
      if (!knownTabPanelWidthPx) return;
      let el: HTMLElement | null = root.parentElement;
      let hops = 0;
      while (el && hops < 8) {
        const inlineWidth = el.style.width;
        const parsed = inlineWidth ? parseFloat(inlineWidth) : NaN;
        if (!Number.isNaN(parsed) && parsed > knownTabPanelWidthPx + 8) {
          el.style.setProperty("width", `${knownTabPanelWidthPx}px`, "important");
          el.style.setProperty("max-width", `${knownTabPanelWidthPx}px`, "important");
        }
        el = el.parentElement;
        hops++;
      }
      root.style.setProperty("width", `${knownTabPanelWidthPx}px`, "important");
      root.style.setProperty("max-width", `${knownTabPanelWidthPx}px`, "important");
    };

    applyClamp();
    const observer = new MutationObserver(applyClamp);
    let node: HTMLElement | null = root.parentElement;
    let hops = 0;
    while (node && hops < 8) {
      observer.observe(node, { attributes: true, attributeFilter: ["style", "class"] });
      node = node.parentElement;
      hops++;
    }
    return () => observer.disconnect();
  }, [forceCollapsedWidth]);

  const lockMethod = cachedSettings?.lock_method ?? "pin";
  const isPattern = lockMethod === "pattern";
  const isTapCode = lockMethod === "tap_code";

  const onSubmit = async () => {
    if (isTapCode ? knockSequence.length === 0 : isPattern ? patternNodes.length === 0 : pin.length === 0) return;
    const value = isPattern ? sequenceToString(patternNodes) : isTapCode ? sequenceToString(knockSequence) : pin;
    const ok = await checkCredential(lockMethod, value);
    if (ok) {
      onUnlocked();
    } else {
      setError(`Incorrect ${credentialLabel(lockMethod)}`);
      setPin("");
      setPatternNodes([]);
      setKnockSequence([]);
    }
  };

  return (
    <div ref={rootRef} style={{ width: "100%", maxWidth: "100%", boxSizing: "border-box" }}>
      {(title || onBack) && (
        <Focusable
          className={plainTitle ? undefined : staticClasses.Title}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            width: "100%",
            boxSizing: "border-box",
            paddingLeft: onBack ? "16px" : undefined,
            paddingRight: "16px",
            position: "sticky",
            top: "0px",
            fontWeight: plainTitle ? "bold" : undefined,
          }}
        >
          {onBack && (
            <DialogButton
              onClick={onBack}
              style={{
                minWidth: 0,
                width: "28px",
                height: "28px",
                padding: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <FaChevronLeft />
            </DialogButton>
          )}
          {title && <div style={{ marginRight: "auto", flex: 0.9 }}>{title}</div>}
        </Focusable>
      )}
      <div style={{ paddingTop: title || onBack ? "16px" : 0, width: "100%", boxSizing: "border-box" }}>
        <PanelSection>
          <PanelSectionRow>
            <div style={{ fontWeight: "bold", marginBottom: "4px" }}>Enter {credentialLabel(lockMethod)}</div>
          </PanelSectionRow>
          <CredentialCompactEntry
            lockMethod={lockMethod}
            pin={pin}
            onPinChange={(value) => {
              setError("");
              setPin(value);
            }}
            pattern={patternNodes}
            onPatternChange={(nodes) => {
              setError("");
              setPatternNodes(nodes);
            }}
            onPatternSubmit={onSubmit}
            patternSettings={{
              lineThemeColor: cachedSettings?.pattern_line_theme_color ?? false,
              lineTransparent: cachedSettings?.pattern_line_transparent ?? false,
              dotShape: cachedSettings?.pattern_dot_shape ?? "rounded",
              cornerRadius: cachedSettings?.pattern_corner_radius ?? 14,
              glassEffect: cachedSettings?.pattern_glass_effect ?? false,
            }}
            knock={knockSequence}
            onKnockTap={(index) => {
              setError("");
              setKnockSequence((prev) => [...prev, index]);
            }}
            knockSettings={{
              showOutline: cachedSettings?.tap_code_show_outline ?? true,
              showDividers: cachedSettings?.tap_code_show_dividers ?? false,
            }}
          />
          {error && (
            <PanelSectionRow>
              <div style={{ color: "#f44336", fontSize: "13px" }}>{error}</div>
            </PanelSectionRow>
          )}
          {/* Pattern submits on drag-release (see PatternPad's onDragComplete) — no
              separate confirm step needed, unlike PIN/Password which still need this
              button. */}
          {!isPattern && (
            <PanelSectionRow>
              <DialogButton onClick={onSubmit} style={{ width: "100%", marginTop: "12px" }}>
                Unlock
              </DialogButton>
            </PanelSectionRow>
          )}
        </PanelSection>
      </div>
    </div>
  );
}

// Wraps Decky's own tab panel so the PIN gate can render INSIDE the QAM's own tree,
// in place of the plugin list, instead of as a same-window overlay (see above).
function DeckyTabGate({ children }: { children: ReactNode }) {
  const [locked, setLocked] = useState(deckyPanelGateVisible);

  useEffect(() => {
    const listener = () => setLocked(deckyPanelGateVisible);
    listener();
    deckyQamLockListeners.add(listener);
    return () => {
      deckyQamLockListeners.delete(listener);
    };
  }, []);

  if (locked) {
    return (
      <DeckyPanelPinPrompt
        title="Decky"
        onUnlocked={() => {
          deckyQamLocked = false;
          deckyPanelGateVisible = false;
          notifyDeckyQamLockChange();
        }}
      />
    );
  }
  return <>{children}</>;
}

// Other installed plugins the user has chosen to lock — unlocked until the whole QAM
// is closed (same persistence model as Lock Decky Panel), not the game/session model.
const unlockedPluginsThisSession = new Set<string>();
const pluginLockListeners = new Map<string, Set<() => void>>();
function notifyPluginLockChange(name: string) {
  pluginLockListeners.get(name)?.forEach((fn) => fn());
}

// Wraps another installed plugin's own content (substituted in place of it, the same
// way DeckyTabGate substitutes Decky's own tab panel) so it requires a PIN before
// showing, without needing to patch that plugin's own component at all.
function LockedPluginGate({
  pluginName,
  title,
  forceCollapsedWidth,
  children,
}: {
  pluginName: string;
  title?: string;
  forceCollapsedWidth?: boolean;
  children: ReactNode;
}) {
  const [unlocked, setUnlocked] = useState(() => unlockedPluginsThisSession.has(pluginName));

  useEffect(() => {
    const listener = () => setUnlocked(unlockedPluginsThisSession.has(pluginName));
    if (!pluginLockListeners.has(pluginName)) pluginLockListeners.set(pluginName, new Set());
    pluginLockListeners.get(pluginName)!.add(listener);
    listener();
    return () => {
      pluginLockListeners.get(pluginName)?.delete(listener);
    };
  }, [pluginName]);

  if (unlocked) return <>{children}</>;

  return (
    <DeckyPanelPinPrompt
      title={title}
      forceCollapsedWidth={forceCollapsedWidth}
      onUnlocked={() => {
        unlockedPluginsThisSession.add(pluginName);
        notifyPluginLockChange(pluginName);
      }}
    />
  );
}

// Finds Decky Loader's own internal plugin-state Context by walking the live React
// tree from the true app root and matching its value's shape (has `plugins` and
// `pluginOrder` arrays) — this Context (frontend/src/components/DeckyState.tsx in
// SteamDeckHomebrew/decky-loader) isn't exported to plugins at all, unlike the Steam
// Client internals used elsewhere in this file, so there's no module or prop name to
// search for; duck-typing the value shape is the only way in. Returns null if it can't
// be found (e.g. after a Decky Loader update changes this shape).
let loggedDeckyStateResult = false;
function getDeckyStateValue(): { plugins: { name: string; icon?: ReactNode; content?: ReactNode }[] } | null {
  try {
    const root = getReactRoot(document.getElementById("root") as any);
    if (!root) {
      if (!loggedDeckyStateResult) {
        loggedDeckyStateResult = true;
        console.warn("DeckLocker: getReactRoot found nothing while looking for Decky's plugin state");
      }
      return null;
    }
    const node = findInReactTree(root, (n: any) => {
      const val = n?.props?.value ?? n?.memoizedProps?.value;
      return !!val && Array.isArray(val.plugins) && Array.isArray(val.pluginOrder);
    });
    const value = (node?.props?.value ?? node?.memoizedProps?.value) ?? null;
    if (!loggedDeckyStateResult) {
      loggedDeckyStateResult = true;
      if (!value) {
        console.warn("DeckLocker: could not locate Decky's plugin state Context in the React tree");
      }
    }
    return value;
  } catch (e) {
    console.error("DeckLocker: failed to read Decky's plugin list", e);
    return null;
  }
}

// Wraps (or unwraps) each OTHER installed plugin's own `content` with LockedPluginGate
// based on the current locked_plugins setting — mutating the plugin object Decky Loader
// itself holds, the same in-place-mutation technique TabsHook uses to install each
// plugin's panel in the first place. Idempotent: safe to call repeatedly (e.g. every
// time the Decky tab becomes active) to pick up newly installed/locked plugins.
function applyPluginLocks() {
  const state = getDeckyStateValue();
  if (!state) return;
  const lockedNames = new Set(cachedSettings?.locked_plugins ?? []);
  for (const plugin of state.plugins) {
    if (!plugin || plugin.name === "Deck Locker") continue;
    const p = plugin as any;
    if (p.__decklockerOriginalContent === undefined) {
      p.__decklockerOriginalContent = p.content;
    }
    const shouldLock = lockedNames.has(plugin.name);
    const isLocked = p.__decklockerLocked === true;
    if (shouldLock && !isLocked) {
      p.content = <LockedPluginGate pluginName={plugin.name}>{p.__decklockerOriginalContent}</LockedPluginGate>;
      p.__decklockerLocked = true;
    } else if (!shouldLock && isLocked) {
      p.content = p.__decklockerOriginalContent;
      p.__decklockerLocked = false;
    }
  }
}

// Steam's own built-in QAM tabs that can be individually locked, alongside Decky
// plugins. Unlike plugins (found via getDeckyStateValue's React-tree walk), these
// already sit in the same `tabs` array the Decky tab itself is found in, so they're
// wrapped inline wherever that array is available, with no separate lookup needed.
// showTitle: only Friends lacks its own native title once its content is swapped out
// for the PIN prompt — every other built-in tab already renders its own title, so
// injecting one there would show two titles at once.
const BUILTIN_LOCKABLE_TABS: { id: number; name: string; showTitle?: boolean }[] = [
  { id: QuickAccessTab.Notifications, name: "Notifications" },
  { id: QuickAccessTab.Friends, name: "Friends", showTitle: true },
  { id: QuickAccessTab.Settings, name: "Quick Settings" },
  { id: QuickAccessTab.Perf, name: "Performance" },
  { id: QuickAccessTab.Help, name: "Help" },
  { id: QuickAccessTab.Music, name: "Music" },
  { id: QuickAccessTab.RemotePlayTogetherControls, name: "Remote Play Together" },
  { id: QuickAccessTab.VoiceChat, name: "Voice Chat" },
];
// Namespaced so a built-in tab's name can never collide with an actual plugin's name
// in the shared unlockedPluginsThisSession set (reused as-is for both — same "unlock
// once, re-lock on QAM close" model applies equally to either kind of lock).
function builtinTabLockKey(name: string): string {
  return `tab:${name}`;
}

// Wraps (or unwraps) each built-in tab's own panel with LockedPluginGate, the same
// in-place mutation applyPluginLocks uses for Decky plugins — just operating directly
// on the tabs array already in scope here instead of a separate lookup.
function applyBuiltinTabLocks(tabs: any[]) {
  const lockedNames = new Set(cachedSettings?.locked_qam_tabs ?? []);
  for (const { id, name, showTitle } of BUILTIN_LOCKABLE_TABS) {
    const entry = tabs?.find((t: any) => t?.key === id);
    if (!entry) continue;
    if (entry.__decklockerOriginalPanel === undefined) {
      entry.__decklockerOriginalPanel = entry.panel;
    }
    const shouldLock = lockedNames.has(name);
    const isLocked = entry.__decklockerTabLocked === true;
    if (shouldLock && !isLocked) {
      entry.panel = (
        <LockedPluginGate
          pluginName={builtinTabLockKey(name)}
          title={showTitle ? name : undefined}
          forceCollapsedWidth={name === "Friends"}
        >
          {entry.__decklockerOriginalPanel}
        </LockedPluginGate>
      );
      entry.__decklockerTabLocked = true;
    } else if (!shouldLock && isLocked) {
      entry.panel = entry.__decklockerOriginalPanel;
      entry.__decklockerTabLocked = false;
    }
  }
}

// Real-time tracking of when any dialog/dropdown last opened anywhere in the app —
// independent of the QAM's own render cycle. Confirmed by precise-timestamp testing
// that Steam's QAM component only re-renders (and reports itself closed) *after* such
// a dialog has already fully opened and closed, so checking DOM/state at that render is
// always too late — ruled out CSS-class DOM matching (Steam's classes are mostly
// per-build hashes, not semantic), polling window.FocusNavController (changes, but not
// correlated with the actual interaction's timing), and patching @decky/ui's own
// showContextMenu export directly (a frozen, non-configurable webpack getter).
//
// Documented in decky-frontend-lib's source (SteamDeckHomebrew/decky-frontend-lib,
// src/components/Menu.ts) as a thin wrapper around Steam's own
// GetContextMenuManagerFromWindow().CreateContextMenuInstance() — a real Steam Client
// method, not a guessed CSS class, and the function backing the Dropdown component most
// plugins use for exactly this kind of "dropdown button that shows a menu" UI. Since
// GetContextMenuManagerFromWindow's own name is minified (unlike showContextMenu's) and
// can't be found by name, the manager is instead obtained by calling showContextMenu
// once ourselves (hidden, harmless) and reading it off the returned instance's own
// m_ContextMenuManager field (confirmed present by direct testing) — then patching
// CreateContextMenuInstance on that (singleton) manager object catches every plugin's
// own showContextMenu call regardless of load order, since showContextMenu re-fetches
// the manager fresh on every call rather than caching it.
let lastOverlayActivityAt = 0;
let overlayActivityWatcherStarted = false;

// Marks activity and wraps the returned ContextMenuInstance's Hide() so the grace
// window also extends through however long the menu stays open, not just its opening.
function markContextMenuOpened(ret: any) {
  lastOverlayActivityAt = Date.now();
  try {
    const origHide = ret?.Hide;
    if (typeof origHide === "function" && !ret.__decklockerHidePatched) {
      ret.__decklockerHidePatched = true;
      ret.Hide = function (this: any, ...hideArgs: any[]) {
        lastOverlayActivityAt = Date.now();
        return origHide.apply(this, hideArgs);
      };
    }
  } catch (e) {
    console.error("DeckLocker: failed to patch ContextMenuInstance.Hide", e);
  }
}

// Patches CreateContextMenuInstance directly on a manager instance (a regular runtime
// object, not a frozen webpack module export) so it catches every caller — including
// other plugins' own bundled copies of showContextMenu — regardless of load order,
// since showContextMenu's own code re-fetches the manager fresh on every call.
function patchContextMenuManagerOnce(mgr: any) {
  if (!mgr || mgr.__decklockerPatched || typeof mgr.CreateContextMenuInstance !== "function") return;
  mgr.__decklockerPatched = true;
  const origCreate = mgr.CreateContextMenuInstance;
  mgr.CreateContextMenuInstance = function (this: any, ...args: any[]) {
    const ret = origCreate.apply(this, args);
    markContextMenuOpened(ret);
    return ret;
  };
}

function ensureOverlayActivityWatcher() {
  if (overlayActivityWatcherStarted) return;
  overlayActivityWatcherStarted = true;
  try {
    // showContextMenu's own export is a frozen (non-configurable) webpack getter —
    // confirmed by testing ("Cannot redefine property"), so it can't be wrapped
    // directly, and GetContextMenuManagerFromWindow's name turned out to be minified
    // (unlike showContextMenu's), so it can't be found by name either. Instead, make
    // one harmless, hidden showContextMenu call ourselves and read the manager off the
    // returned instance's own m_ContextMenuManager field — confirmed present by
    // direct testing — then patch CreateContextMenuInstance on that (singleton)
    // manager object, which every plugin's own showContextMenu call goes through
    // regardless of load order, since showContextMenu re-fetches it fresh each call.
    const probeInstance: any = showContextMenu("" as any, undefined, { bCreateHidden: true });
    const mgr = probeInstance?.m_ContextMenuManager;
    probeInstance?.Hide?.();
    if (!mgr) {
      console.error("DeckLocker: probe instance had no m_ContextMenuManager field");
      return;
    }
    patchContextMenuManagerOnce(mgr);
  } catch (e) {
    console.error("DeckLocker: failed to start overlay activity watcher", e);
  }
}

const OVERLAY_GRACE_MS = 4000;
function recentOverlayActivity(): boolean {
  return Date.now() - lastOverlayActivityAt < OVERLAY_GRACE_MS;
}

// Labels exactly as Steam renders them in the Main Menu (opened via the ● STEAM
// button) — confirmed by live-patching MainMenuBrowserView/MainMenuEmbedded and
// inspecting its actual rendered item list. "Home" and "Friends & Chat" also appear in
// that list but weren't requested, so they're left alone. Of these six, "Power" is
// built as a plain action-only item (no route at all); the rest navigate to a route
// via the module's exported route-item builder — the two need different interception
// points below (patchMainMenuRouteItems vs. the item-list wrapper in
// getMainMenuItemsGate).
const MAIN_MENU_LOCKABLE_ITEMS = ["Library", "Store", "Media", "Downloads", "Settings", "Power"];
function mainMenuItemLockKey(label: string): string {
  return `mainmenu:${label}`;
}

// Shared "is this Main Menu item currently locked" check — used both for the Main
// Menu's own item list (below) and for guarding the Library route directly (see
// patchLibraryRouteLock), since Home's own "View more in your Library" shortcut tile
// reaches that same destination without ever going through the Main Menu's list at all.
function isMainMenuItemLocked(label: string): boolean {
  return !!cachedSettings?.locked_main_menu_items?.includes(label) && !unlockedPluginsThisSession.has(mainMenuItemLockKey(label));
}

// Main Menu items share the same "unlock once, re-lock when the container closes"
// model as QAM tabs/plugins (unlockedPluginsThisSession, namespaced), just re-armed on
// the Main Menu's own open/close transition instead of the QAM's.
function rearmMainMenuLocks() {
  const names = Array.from(unlockedPluginsThisSession).filter((k) => k.startsWith("mainmenu:"));
  if (names.length === 0) return;
  names.forEach((k) => unlockedPluginsThisSession.delete(k));
  names.forEach(notifyPluginLockChange);
}

// Cached count of real items in the Main Menu's list (Home, Library, Store, Friends &
// Chat, Media, Downloads, Settings, Power — updated on every render of the item-list
// gate wrapper below), used only to pad MainMenuPinModalContent with matching "ghost"
// rows so its content block ends up the same total height as the real list — the real
// list centers its children as a whole block, so a shorter PIN prompt alone would land
// noticeably higher than the real list's first item does.
let knownMainMenuItemCount = 0;

// The actual modal content — DeckyPanelPinPrompt plus invisible ghost rows (see
// knownMainMenuItemCount) so the visible content centers the same way the real list
// does, in the same visual shell measured off the real list ("g"): pure black
// background, flush left/right but inset ~40px top/bottom (the "status bar" allowance),
// right-side-only rounded corners, ~241px wide to match the real panel.
//
// Wires both the title-bar Back button and the controller B button (Focusable's
// onCancel) to the same dismiss path. Also listens for the render surface's own window
// losing OS focus as a fallback dismiss path — live testing found this actually renders
// inline inside Big Picture Mode's own document rather than a separate native window
// (see openMainMenuPinModal below), so this listener is a no-op there; outside-click
// dismissal in that (confirmed, current) case is instead handled by the full-size
// click-catcher div rendered below. Left in place in case a future Steam Client build
// pops this out into a real separate window after all, per showModal's own internal
// logic (module 13869 in Steam's own webpack bundle) choosing between the two.
function MainMenuPinModalContent({
  label,
  onDismiss,
  onUnlocked,
}: {
  label: string;
  onDismiss: () => void;
  onUnlocked: () => void;
}) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [rowHeightPx, setRowHeightPx] = useState(0);
  useEffect(() => {
    const btn = wrapperRef.current?.querySelector('[role="button"]') as HTMLElement | null;
    if (btn) setRowHeightPx(btn.getBoundingClientRect().height);
  }, []);

  useEffect(() => {
    // Our own component code executes in SharedJSContext's JS realm regardless of
    // which document its DOM actually renders into — confirmed earlier for the Main
    // Menu's own document/focus quirks — so the bare global `window` here is
    // SharedJSContext's, not the render surface's, and would never blur on an outside
    // click there. wrapperRef's real DOM node's ownerDocument.defaultView is correct
    // whichever surface this actually rendered into.
    const popupWindow = wrapperRef.current?.ownerDocument?.defaultView;
    if (!popupWindow) return;
    const onBlur = () => onDismiss();
    popupWindow.addEventListener("blur", onBlur);
    return () => popupWindow.removeEventListener("blur", onBlur);
  }, [onDismiss]);

  // Steam's own dialog layout always reserves footer height at the bottom of the modal
  // area, even when the on-screen keyboard is up and has already taken over that same
  // area — measured live: with the keyboard open, the modal's own container stops a
  // full footer-height short of where the keyboard actually starts, leaving that
  // reserved (but now pointless, since the keyboard already covers it) footer band as a
  // visible gap between our panel and the keyboard. Detected via the keyboard's own DOM
  // node's real height (there's no exposed prop for this), so the panel's bottom edge
  // can be pinned to exactly where the keyboard actually starts (not just flush to the
  // literal screen bottom, which would extend the panel behind the keyboard instead of
  // shrinking to meet it) — and left alone (0) the rest of the time, keeping the
  // already-correct (footer visible, no gap) layout.
  // Polled rather than driven off a MutationObserver: the keyboard slides in with its
  // own transition, so the DOM mutation announcing its presence fires well before it
  // reaches its final height — a MutationObserver-only check kept measuring that first,
  // mid-animation (often ~0) sample and then never fired again (transitions don't
  // themselves re-trigger attribute-value mutations), so the panel only actually
  // resized whenever some UNRELATED mutation happened to occur later (e.g. moving the
  // on-screen keyboard's own key selection). Polling sidesteps needing to know when the
  // animation actually finishes at all.
  const [keyboardHeightPx, setKeyboardHeightPx] = useState(0);
  useEffect(() => {
    const doc = wrapperRef.current?.ownerDocument;
    if (!doc) return;
    const interval = doc.defaultView?.setInterval(() => {
      const kb = doc.getElementById("virtual keyboard");
      setKeyboardHeightPx(kb ? kb.getBoundingClientRect().height : 0);
    }, 100);
    return () => {
      if (interval) doc.defaultView?.clearInterval(interval);
    };
  }, []);

  const ghostCount = Math.max(0, knownMainMenuItemCount - 4 + 2); // 4 = title, "Enter PIN", field, Unlock; +2 extra ghost gaps
  const ghostHeightPx = rowHeightPx * 1.3;

  return (
    // Live DOM inspection showed this content is NOT actually popped out into its own
    // native window (despite bForcePopOut) — it renders inline inside Steam Big Picture
    // Mode's own document, inside a wrapper (#ModalDialogOverlay_Modal_2) that Steam
    // sizes to the FULL screen width even though our own visible panel is only 241px
    // wide. The "empty" area beside our panel is still inside that wrapper's own hit
    // area (not Steam's separate dismiss-on-click backdrop behind it, which never
    // receives the click), so nothing dismissed on a click there. This full-size div
    // fills that same space itself and handles the click directly; the actual panel
    // stops the click from bubbling back up to it.
    <div
      style={
        keyboardHeightPx > 0
          ? {
              position: "fixed",
              top: 0,
              left: 0,
              right: 0,
              bottom: `${keyboardHeightPx}px`,
              transition: "bottom 0.15s ease-out",
            }
          : { width: "100%", height: "100%" }
      }
      onClick={onDismiss}
    >
      <Focusable
        ref={wrapperRef}
        flow-children="vertical"
        onCancel={onDismiss}
        onClick={(e: any) => e.stopPropagation()}
        style={
          keyboardHeightPx > 0
            ? // Break out of the modal's own (too-short) reserved height entirely —
              // pinned to exactly where the keyboard itself starts (not just flush to
              // the literal screen bottom, which would extend the panel behind the
              // keyboard instead of shrinking to meet it), closing the reserved-but-
              // now-pointless footer gap that would otherwise sit between them.
              {
                width: "241px",
                position: "fixed",
                top: "40px",
                left: 0,
                bottom: `${keyboardHeightPx}px`,
                boxSizing: "border-box",
                transition: "bottom 0.15s ease-out",
              }
            : {
                width: "241px",
                height: "100%",
                // Padding, not margin: measured live that a top *margin* on the black
                // box below collapses straight through this Focusable (neither has its
                // own padding/border to stop it), which pushes Focusable's own rendered
                // box down 40px without shrinking it — so it silently overflows past
                // its container's real bottom edge by that same 40px, while the black
                // box's own "calc(100% - 40px)" height then subtracts *another* 40px
                // expecting that space to still be inside it, landing 40px short of the
                // actual bottom. Padding isn't subject to collapsing, so with
                // boxSizing: border-box the black box can just be height: "100%" of
                // Focusable's own (correctly contained) content box, no gap either end.
                boxSizing: "border-box",
                paddingTop: "40px",
              }
        }
      >
        <style>{`
          @keyframes decklocker-mainmenu-slide-in {
            0% { transform: translateX(24px); opacity: 0; }
            100% { transform: translateX(0); opacity: 1; }
          }
          /* Steam's own modal backdrop applies a backdrop-filter blur behind every
             dialog (confirmed live: .ModalOverlayBackground computed backdropFilter is
             "blur(3px)", background already transparent on its own) — scoped to this
             component's own mounted lifetime via this <style> tag, rather than a global
             override, so it doesn't affect any other dialog shown while this isn't. */
          .ModalOverlayBackground {
            backdrop-filter: none !important;
          }
        `}</style>
        <div
          style={{
            background: "rgb(0, 0, 0)",
            width: "100%",
            height: "100%",
            paddingTop: "16px",
            borderRadius: "0px 16px 16px 0px",
            boxSizing: "border-box",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            animation: "decklocker-mainmenu-slide-in 0.25s ease-out",
          }}
        >
          <DeckyPanelPinPrompt title={label} plainTitle onBack={onDismiss} onUnlocked={onUnlocked} />
          {rowHeightPx > 0 &&
            Array.from({ length: ghostCount }).map((_, i) => (
              <div key={i} style={{ height: `${ghostHeightPx}px`, visibility: "hidden" }} />
            ))}
        </div>
      </Focusable>
    </div>
  );
}

// The PIN gate shown for a locked Main Menu item, via showModal (with bForcePopOut)
// rather than substituted in place of the item list.
//
// Why: the Main Menu's own list container ("g") lives in a genuinely different native
// popup window (MainMenu_uid2) from the one Steam's on-screen keyboard actually renders
// into (the base "Steam Big Picture Mode" window) — confirmed by live DOM inspection of
// both while the keyboard was shown. MainMenu_uid2 is always composited *above* that
// base window (by design — it's the system menu opened by the physical STEAM button), so
// any content substituted inside it can never show the keyboard on top, no matter its
// CSS — the keyboard is drawn as a full-width band in a *different, lower* native
// window. QAM's own text fields don't have this problem only because QuickAccess_uid2
// happens to be composited *below* the base window instead (confirmed: same keyboard
// DOM, same rect, opposite visual stacking) — not because of anything different in QAM's
// React tree. Since a plugin can't change MainMenu_uid2's native window level, the fix
// is to stop rendering the PIN prompt inside it at all: showModal renders this content
// somewhere else entirely — confirmed live to actually be inline inside Big Picture
// Mode's own document on this Steam Client build (not a genuinely separate popup, despite
// bForcePopOut — see MainMenuPinModalContent), which happens to be exactly the window the
// keyboard already renders into, so the keyboard now shows correctly on top as a side
// effect. Back-button/outside-click dismissal are wired explicitly (see
// MainMenuPinModalContent) since neither comes for free in that inline case.
function openMainMenuPinModal(label: string, runOriginalAction: () => void) {
  let modal: { Close: () => void; Update: (n: ReactNode) => void };
  modal = showModal(
    <MainMenuPinModalContent
      label={label}
      onDismiss={() => modal.Close()}
      onUnlocked={() => {
        unlockedPluginsThisSession.add(mainMenuItemLockKey(label));
        modal.Close();
        runOriginalAction();
      }}
    />,
    window,
    { bForcePopOut: true, popupWidth: 241, popupHeight: 599 }
  );
}

// Whether a route path is "the Library section" for the purposes of the Main Menu's
// Library lock — i.e. the actual browse-all-games destination, not the Home screen
// (which — confirmed live — is itself routed at /library/home, so a naive "starts with
// /library" match would wrongly gate Home too) and not individual game pages
// (/library/app/:appid, already separately gated by patchAppPage/LockedPageGate using
// the per-app locked_apps list, not this one).
function isLibraryBrowseRoute(pathname: string): boolean {
  // window.location.pathname carries a "/routes" prefix ahead of the route path used
  // everywhere else in this file (confirmed live: the Home screen's own pathname is
  // "/routes/library/home", not "/library/home") — easy to miss since routerHook's own
  // patch paths (e.g. "/library/app/:appid" above) are given without it.
  return (
    pathname === "/routes/library" ||
    pathname.startsWith("/routes/library/tab/") ||
    pathname.startsWith("/routes/library/collection/")
  );
}

// Full-screen keypad lock screen for someone who reached the Library route some other
// way than the Main Menu's own "Library" item (see startLibraryRouteLockWatcher below)
// — the same PinLockScreen used for individual games, in libraryMode since there's no
// real app behind this one (no art to load, and PIN success/cancel shouldn't touch
// unlockedThisSession/terminateAppAggressively, both meant for actual running games).
// PinLockScreen's own onCancel already navigates back on dismiss, so simply closing the
// modal never leaves the real (unlocked-looking, though still not interactive without
// this gate) Library page sitting there underneath.
function openLibraryRouteLockModal() {
  let modal: { Close: () => void; Update: (n: ReactNode) => void };
  modal = showModal(
    <PinLockScreen
      appid="library"
      appName="Library"
      libraryMode
      closeModal={() => modal.Close()}
      onUnlocked={() => unlockedPluginsThisSession.add(mainMenuItemLockKey("Library"))}
    />
  );
}

// Home's own "View more in your Library" shortcut tile (and potentially other future
// bypasses) reaches the Library route directly through its own onClick prop, without
// ever going through the Main Menu's own patched item list at all — confirmed live that
// a capture-phase DOM click listener never even sees gamepad Activate on that tile
// (nothing in the DOM event system fires for it), and patching the Library route's own
// top-level component tree crashed the app outright (a class component's own render
// method got replaced with a non-class-calling-convention wrapper — minified React
// error #130). Polling the current route instead avoids touching Library's own
// component tree entirely: whenever it becomes the Library section while locked, this
// shows the same PIN gate over it and backs out on cancel, using only the same
// supported Navigation API any plugin can call.
function startLibraryRouteLockWatcher(): () => void {
  let lastGatedPath = "";
  const check = () => {
    const pathname = window.location.pathname;
    if (!isLibraryBrowseRoute(pathname)) {
      lastGatedPath = "";
      return;
    }
    if (pathname === lastGatedPath) return;
    if (!isMainMenuItemLocked("Library")) return;
    lastGatedPath = pathname;
    openLibraryRouteLockModal();
  };
  check();
  const interval = setInterval(check, 300);
  return () => clearInterval(interval);
}

// Recursively searches a React element tree (via .props.children, handling arrays) for
// the first element whose props contain every key in `requiredKeys` — used to find the
// Main Menu's inner components structurally (by the distinctive prop shape they carry,
// e.g. {bLoggedIn, popup} or {loggedIn, menuOpen}) rather than by their minified
// function name, which is build-specific and not something to depend on long-term.
function findElementByProps(el: any, requiredKeys: string[]): any {
  if (el == null || typeof el !== "object") return null;
  if (Array.isArray(el)) {
    for (const c of el) {
      const found = findElementByProps(c, requiredKeys);
      if (found) return found;
    }
    return null;
  }
  if ("type" in el) {
    const props = el.props;
    if (props && typeof props === "object" && requiredKeys.every((k) => k in props)) return el;
    if (props?.children !== undefined) {
      const found = findElementByProps(props.children, requiredKeys);
      if (found) return found;
    }
  }
  return null;
}

// Recursively searches a React element tree for every element whose `label` prop is in
// `labels`, calling `visit` on each. Used to find action-only locked items (Power) that
// never pass through the route-item builder patchMainMenuRouteItems intercepts, since
// they're built directly with a plain `action` function and no `route` at all.
function forEachElementWithLabel(el: any, labels: Set<string>, visit: (el: any) => void) {
  if (el == null || typeof el !== "object") return;
  if (Array.isArray(el)) {
    for (const c of el) forEachElementWithLabel(c, labels, visit);
    return;
  }
  if ("type" in el) {
    const label = el.props?.label;
    if (typeof label === "string" && labels.has(label)) visit(el);
    if (el.props?.children !== undefined) forEachElementWithLabel(el.props.children, labels, visit);
  }
}

// Wraps the Main Menu's item-list component (an unexported local component, reached
// only via the element tree — see patchMainMenuLock below) so it can intercept locked
// items' actions and route them through openMainMenuPinModal instead. Cached per
// original component reference (not recreated per render) so React sees a STABLE
// function identity across renders — a fresh function object would otherwise look like
// a brand new component type to React each time, remounting the real item list.
//
// Not a component with hooks of its own — just a plain wrapper called with the same
// args React would pass to OriginalItemList (mirroring getWrappedRouteItemType below),
// since there's no longer any local state to hold: the PIN gate is now a showModal
// pop-out (see openMainMenuPinModal) rather than something substituted into this
// component's own render output, so nothing here needs to react to menuOpen/pendingLabel
// transitions or worry about hook-call-count consistency across renders.
const mainMenuItemsGateCache = new WeakMap<Function, Function>();
function getMainMenuItemsGate(OriginalItemList: Function): Function {
  const cached = mainMenuItemsGateCache.get(OriginalItemList);
  if (cached) return cached;

  const GateComponent = function (this: any, ...args: any[]) {
    const innerRet = OriginalItemList.apply(this, args);

    // Read directly off the real list's own element tree (its children are
    // [itemsArray, trailingDiv] per live inspection) rather than a DOM query, for
    // MainMenuPinModalContent's ghost rows to consume later.
    const listChildren = innerRet?.props?.children;
    const items = Array.isArray(listChildren) ? listChildren[0] : null;
    if (Array.isArray(items) && items.length > 0) {
      knownMainMenuItemCount = items.length;
    }

    const lockedNames = new Set((cachedSettings?.locked_main_menu_items ?? []).filter(isMainMenuItemLocked));
    if (lockedNames.size > 0) {
      forEachElementWithLabel(innerRet, lockedNames, (itemEl) => {
        if (typeof itemEl.props?.action === "function") {
          // Action-only item (Power): the action is already computed, so it can be
          // wrapped directly.
          const label = itemEl.props.label;
          const originalAction = itemEl.props.action;
          itemEl.props.action = () => {
            try {
              openMainMenuPinModal(label, originalAction);
            } catch (e) {
              console.error("DeckLocker: action item gate trigger threw", e);
            }
          };
        } else if (typeof itemEl.type === "function") {
          // Route item (Library/Store/Media/Downloads/Settings): its action isn't
          // computed until it renders, so wrap the component itself instead.
          itemEl.type = getWrappedRouteItemType(itemEl.type);
        }
      });
    }

    return innerRet;
  };

  mainMenuItemsGateCache.set(OriginalItemList, GateComponent);
  return GateComponent;
}

// Wraps a route item's own component (e.g. the unexported "Ae" that renders Library/
// Store/Media/Downloads/Settings) in place, the same way getMainMenuItemsGate wraps the
// item-list component itself — needed because, unlike Power (built directly as a plain
// action item), a route item's `action` isn't computed until this component actually
// renders (internally calling the module's route-item builder, e.g. "pe"), so it can't
// be intercepted from the outside by mutating a prop the way Power's is.
//
// Patching the route-item BUILDER directly (module export "AX"/pe) was the first
// approach tried, but webpack defines every named export as a getter-only accessor —
// `afterPatch(mod, "AX", ...)` throws "Cannot set property AX of #<Object> which has
// only a getter" — and even if that succeeded, the component calls the builder via its
// own internal closure, not through the module's exports object, so patching the export
// wouldn't reach that call anyway (the same reason showContextMenu's own export
// couldn't be patched directly — see ensureOverlayActivityWatcher above). Wrapping the
// element's `.type` sidesteps both problems entirely, mirroring the `.type` mutation
// already proven to work for Ie and for QAM's own already-mounted-fiber fixup.
//
// One shared component (e.g. "Ae") renders every route item, just with different props
// per item (route/label/icon), so the wrapper can't bake in a specific label at wrap
// time — it has to read `args[0].label` fresh on every call and check the CURRENT lock
// state itself, the same way getMainMenuItemsGate's Power-item check does.
const mainMenuRouteItemWrapperCache = new WeakMap<Function, Function>();
function getWrappedRouteItemType(OriginalRouteItem: Function): Function {
  const cached = mainMenuRouteItemWrapperCache.get(OriginalRouteItem);
  if (cached) return cached;

  const Wrapped = function (this: any, ...args: any[]) {
    const meElement = OriginalRouteItem.apply(this, args);
    const label = args?.[0]?.label;
    const locked = typeof label === "string" && isMainMenuItemLocked(label);
    if (
      locked &&
      meElement &&
      typeof meElement === "object" &&
      typeof meElement.props?.action === "function"
    ) {
      const originalAction = meElement.props.action;
      meElement.props.action = () => {
        try {
          openMainMenuPinModal(label, originalAction);
        } catch (e) {
          console.error("DeckLocker: route item gate trigger threw", e);
        }
      };
    }
    return meElement;
  };

  mainMenuRouteItemWrapperCache.set(OriginalRouteItem, Wrapped);
  return Wrapped;
}

// Finds Steam's own Main Menu (opened via the ● STEAM button, as opposed to the •••
// QAM button patched by patchQamDeckyTabLock below), and wraps its item list so a
// locked item (Library/Store/Media/Downloads/Settings/Power) opens the PIN gate as a
// showModal pop-out (see openMainMenuPinModal) instead of running its normal action.
//
// Found via the same "search a real console.log tag back to its owning module, then
// content-match the actual component" process used for the QAM tab strip: the STEAM
// button's gamepad handler logs `onGlobalMenuButtonDown` then calls
// `e.OnHomeButtonPressed()` (the QAM button's equivalent calls
// `e.OnQuickAccessButtonPressed()`), which — confirmed by live-patching and inspecting
// what actually renders — leads to two React.memo-wrapped components, MainMenuBrowserView
// and MainMenuEmbedded, both rendering a shared inner component reliably anchored by its
// distinctive {bLoggedIn, popup} props (mirroring patchQamDeckyTabLock's own
// onFocusNavDeactivated anchor). That inner component renders exactly one child, the
// item-list component (found here by its own distinctive {loggedIn, menuOpen} props),
// which is where the actual Library/Store/Media/Downloads/Settings/Power items live.
function patchMainMenuLock(): { unregister: () => void } {
  let wasMenuOpen = false;
  let pendingDialogInducedClose = false;
  let latestMenuOpen = false;
  let recheckTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleRecheck = () => {
    if (recheckTimer) clearTimeout(recheckTimer);
    recheckTimer = setTimeout(() => {
      recheckTimer = null;
      if (latestMenuOpen) {
        pendingDialogInducedClose = false;
        return;
      }
      if (recentOverlayActivity()) {
        scheduleRecheck();
        return;
      }
      rearmMainMenuLocks();
      pendingDialogInducedClose = false;
    }, OVERLAY_GRACE_MS);
  };

  ensureOverlayActivityWatcher();

  let attempts = 0;
  const maxAttempts = 15; // 30s of retries in case the module isn't loaded yet
  let timer: ReturnType<typeof setInterval> | null = null;

  const tryPatch = (): boolean => {
    try {
      const mainMenuModule = findModuleByExport((e: any) => e?.type?.toString?.()?.includes("MainMenuBrowserView"));
      if (!mainMenuModule) return false;

      const renderers = [
        Object.values(mainMenuModule).find((e: any) => e?.type?.toString?.()?.includes("MainMenuBrowserView")),
        Object.values(mainMenuModule).find((e: any) => e?.type?.toString?.()?.includes("MainMenuEmbedded")),
      ].filter(Boolean) as any[];
      if (renderers.length === 0) return false;

      const handler = createReactTreePatcher(
        [
          (tree: any) =>
            findInReactTree(tree, (node: any) => {
              const p = node?.props;
              return !!p && typeof p === "object" && "bLoggedIn" in p && "popup" in p;
            }),
        ],
        (args: any, ret: any) => {
          const menuOpen = !!args?.[0]?.open;
          latestMenuOpen = menuOpen;

          if (!menuOpen && wasMenuOpen) {
            if (recentOverlayActivity()) {
              pendingDialogInducedClose = true;
              scheduleRecheck();
            } else {
              rearmMainMenuLocks();
              pendingDialogInducedClose = false;
            }
          } else if (menuOpen && pendingDialogInducedClose) {
            pendingDialogInducedClose = false;
            if (recheckTimer) {
              clearTimeout(recheckTimer);
              recheckTimer = null;
            }
          }
          wasMenuOpen = menuOpen;

          const itemListElement = findElementByProps(ret, ["loggedIn", "menuOpen"]);
          if (itemListElement && typeof itemListElement.type === "function") {
            itemListElement.type = getMainMenuItemsGate(itemListElement.type);
          }

          return ret;
        },
        "DeckLockerMainMenuLock"
      );

      for (const renderer of renderers) {
        afterPatch(renderer, "type", handler);
      }

      // Mirrors patchQamDeckyTabLock's own already-mounted-fiber fixup: the Main Menu's
      // components are mounted once at startup and kept alive (just hidden) rather than
      // remounted each time it opens, so patching the module export's `.type` alone
      // never reaches the already-existing fiber.
      const root = getReactRoot(document.getElementById("root") as any);
      if (root) {
        for (const renderer of renderers) {
          const existingNode = findInReactTree(root, (n: any) => n?.elementType === renderer);
          if (existingNode) {
            existingNode.type = existingNode.elementType.type;
            if (existingNode.alternate) existingNode.alternate.type = existingNode.type;
          }
        }
      } else {
        console.warn("DeckLocker: getReactRoot found nothing; could not patch already-mounted Main Menu node");
      }

      return true;
    } catch (e) {
      console.error("DeckLocker: failed to patch Main Menu item locks", e);
      return false;
    }
  };

  const search = () => {
    attempts++;
    if (tryPatch() || attempts >= maxAttempts) {
      if (timer) clearInterval(timer);
    }
  };
  timer = setInterval(search, 2000);
  search();

  return {
    unregister: () => {
      if (timer) clearInterval(timer);
      if (recheckTimer) clearTimeout(recheckTimer);
    },
  };
}

// Finds Steam's own QAM tab-strip renderer, tracks whether Decky's own tab (the plug
// icon) is the currently active tab, and substitutes the Decky tab's own panel content
// with DeckyTabGate the first time it's seen — so the PIN gate can render inside the
// QAM's own tree, in place of the plugin list, rather than as a separate overlay.
//
// Mirrors the technique Decky Loader's own TabsHook uses internally to find the QAM
// renderer (frontend/src/tabs-hook.tsx in SteamDeckHomebrew/decky-loader) and to
// substitute tab panels (its own `render()` method does the same kind of in-place
// mutation to install each plugin's panel in the first place). Also reads the
// `activeTab` prop Valve's tab-strip component receives as a sibling of `tabs`,
// confirmed by reading Steam's own (de-minified) UI source. This reaches into
// undocumented internals, so it can break on a future Steam Client update; if the hook
// can't be installed, the panel lock simply fails to activate rather than throwing.
function patchQamDeckyTabLock(): { unregister: () => void } {
  const patches: any[] = [];
  let wasQamOpen = false;
  let wasDeckyTabActive = false;
  let loggedMissingOpenProp = false;
  // Tracks the pattern: QAM closes WHILE a dialog/dropdown is open (a false close signal
  // — the QAM only looks closed because the dialog covers it) vs. a genuine close. Only
  // re-arms once the QAM is seen still closed AFTER that dialog has also closed; if the
  // QAM instead reports open again first, the earlier close was confirmed bogus.
  let pendingDialogInducedClose = false;

  const rearmLocks = () => {
    if (cachedSettings?.decky_panel_lock_enabled) {
      deckyQamLocked = true;
    }
    // Reset so reopening directly onto the Decky tab (if it was already selected when
    // the QAM closed) is treated as a fresh "became active" transition below, instead
    // of a no-op continuation of the state from before closing.
    wasDeckyTabActive = false;
    // Individual plugin locks re-lock on every QAM close, unlike Lock This Plugin's
    // persist-until-sleep model.
    if (unlockedPluginsThisSession.size > 0) {
      const names = Array.from(unlockedPluginsThisSession);
      unlockedPluginsThisSession.clear();
      names.forEach(notifyPluginLockChange);
    }
  };

  // Updated on every render regardless of anything else, so the recheck timer below
  // (which runs outside React's render cycle) can consult the latest known value.
  let latestQamOpen = false;
  let recheckTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleRecheck = () => {
    if (recheckTimer) clearTimeout(recheckTimer);
    recheckTimer = setTimeout(() => {
      recheckTimer = null;
      if (latestQamOpen) {
        pendingDialogInducedClose = false;
        return;
      }
      if (recentOverlayActivity()) {
        scheduleRecheck();
        return;
      }
      rearmLocks();
      pendingDialogInducedClose = false;
    }, OVERLAY_GRACE_MS);
  };

  ensureOverlayActivityWatcher();

  try {
    const qamModule = findModuleByExport((e: any) => e?.type?.toString?.()?.includes("QuickAccessMenuBrowserView"));
    const renderers = [
      Object.values(qamModule ?? {}).find((e: any) => e?.type?.toString?.()?.includes("QuickAccessMenuBrowserView")),
      Object.values(qamModule ?? {}).find((e: any) => e?.type?.toString?.()?.includes("QuickAccessMenuEmbedded")),
    ].filter(Boolean);

    const handler = createReactTreePatcher(
      [(tree: any) => findInReactTree(tree, (node: any) => node?.props?.onFocusNavDeactivated)],
      (args: any, ret: any) => {
        const tabsNode = findInReactTree(ret, (x: any) => x?.props?.tabs && "activeTab" in x.props);
        if (!tabsNode) {
          console.warn("DeckLocker: could not locate QAM active-tab prop this render");
          return ret;
        }

        const deckyTabEntry = tabsNode.props.tabs?.find((t: any) => t?.key === QuickAccessTab.Decky);
        if (deckyTabEntry && !deckyTabEntry.__decklockerWrapped) {
          deckyTabEntry.__decklockerWrapped = true;
          const originalPanel = deckyTabEntry.panel;
          deckyTabEntry.panel = <DeckyTabGate>{originalPanel}</DeckyTabGate>;
        }
        applyBuiltinTabLocks(tabsNode.props.tabs);

        // The QAM's own overall open/closed state (as opposed to which tab is active
        // within it) — field name observed as `active` on some Steam Client builds,
        // `visible` on others, so check both.
        if (!loggedMissingOpenProp && args?.[0]?.active === undefined && args?.[0]?.visible === undefined) {
          loggedMissingOpenProp = true;
          console.warn("DeckLocker: QAM open/closed prop not found on args[0]; keys:", args?.[0] && Object.keys(args[0]));
        }
        // `visible` is the reliable "is the QAM actually on screen" signal — confirmed
        // by testing that it stays true the entire time a dropdown/dialog is open
        // inside a plugin, while `active` can flip to false (losing focus to that
        // dropdown) without the QAM itself closing. `visible` takes priority; `active`
        // is only a fallback for whichever Steam Client builds don't have `visible`.
        // (The previous `active ?? visible` was wrong for a different reason: `??`
        // only falls through on null/undefined, not on `false`, so it never actually
        // used `visible` at all once `active` was defined.)
        const expanded = !!args?.[0]?.expanded;
        const qamOpen = !!(args?.[0]?.visible ?? args?.[0]?.active) || expanded;
        const deckyTabActive = tabsNode.props.activeTab === QuickAccessTab.Decky;
        latestQamOpen = qamOpen;
        const dialogRecentlyActive = recentOverlayActivity();

        // Re-arm the gate only when the whole QAM closes — not merely switching to a
        // different tab and back while it stays open, which should stay unlocked, and
        // not when it "closes" only because a dialog/dropdown from within a plugin was
        // recently open. Confirmed by precise-timestamp testing that the QAM's own
        // render reporting "closed" happens *after* such a dialog has already fully
        // opened and closed (they don't overlap in time), so this checks real-time
        // overlay activity within a grace window instead of point-in-time DOM state.
        if (!qamOpen && wasQamOpen) {
          if (dialogRecentlyActive) {
            pendingDialogInducedClose = true;
            scheduleRecheck();
          } else {
            rearmLocks();
            pendingDialogInducedClose = false;
          }
        } else if (qamOpen && pendingDialogInducedClose) {
          pendingDialogInducedClose = false;
          if (recheckTimer) {
            clearTimeout(recheckTimer);
            recheckTimer = null;
          }
        }

        // Show the gate when the Decky tab becomes active, if still locked. Read
        // cachedSettings synchronously (rather than awaiting getSettingsCached()) so
        // deckyPanelGateVisible is already correct before React renders DeckyTabGate's
        // initial/updated state in this same pass — an async round-trip here caused a
        // visible flash of the unlocked plugin list before the gate caught up.
        if (deckyTabActive && !wasDeckyTabActive) {
          const s = cachedSettings;
          if (s?.decky_panel_lock_enabled && hasCredentialSet(s) && deckyQamLocked) {
            deckyPanelGateVisible = true;
            notifyDeckyQamLockChange();
          }
          applyPluginLocks();
        }

        wasQamOpen = qamOpen;
        wasDeckyTabActive = deckyTabActive;
        return ret;
      },
      "DeckLockerQamTab"
    );

    for (const renderer of renderers) {
      patches.push(afterPatch(renderer, "type", handler));
    }

    // The QAM tab-strip component is mounted once at startup and kept alive (just
    // hidden) rather than remounted each time the QAM opens, so patching the module
    // export's `.type` alone never reaches the already-existing fiber — it keeps calling
    // its own original, unpatched function forever. Force the existing instance to pick
    // up the patched version too; this is the same fix-up Decky Loader's own TabsHook
    // applies, for the exact same reason, when it patches this same component.
    const root = getReactRoot(document.getElementById("root") as any);
    if (root) {
      for (const renderer of renderers) {
        const existingNode = findInReactTree(root, (n: any) => n?.elementType === renderer);
        if (existingNode) {
          existingNode.type = existingNode.elementType.type;
          if (existingNode.alternate) {
            existingNode.alternate.type = existingNode.type;
          }
        }
      }
    } else {
      console.warn("DeckLocker: getReactRoot found nothing; could not patch already-mounted QAM node");
    }
  } catch (e) {
    console.error("DeckLocker: failed to patch QAM tab strip", e);
  }

  if (!patches.length) {
    console.error("DeckLocker: could not hook the QAM tab strip — Lock Decky Panel will not activate");
  }

  return {
    unregister: () => {
      if (recheckTimer) clearTimeout(recheckTimer);
      patches.forEach((p) => p?.unpatch?.());
    },
  };
}

// ---- Locked Badges: a small lock icon overlaid on locked games' capsules in Home,
// Recent, and the Library grid, so a locked game is recognizable without opening it. ----
//
// Reference implementation studied: decky-nonsteam-badges (installed at
// ~/homebrew/plugins/decky-nonsteam-badges), which overlays store-icon badges on the
// same native capsules using the same technique: rather than patching Steam's own React
// tree (these grid/list capsules are virtualized and remounted constantly, making
// individual-element patches fragile), find the real Big Picture document via a DOM
// ref's ownerDocument, then directly scan for and inject plain DOM <div> badges into
// game capsules, re-scanning on a MutationObserver plus a periodic fallback interval so
// it keeps up with games scrolling in/out of virtualized lists. One difference: that
// reference plugin locates the Big Picture window via window.DFL.getGamepadNavigationTrees(),
// which returned an empty list when tested live on this Steam Client build — so instead
// this reuses GlobalMenuWatcher's own already-working ref.current.ownerDocument (below),
// the same real-document access pattern already proven for its focus/context-menu work.
const LOCKED_BADGE_CLASSNAME = "decklocker-locked-badge";
const LOCKED_BADGE_STYLE_ID = "decklocker-locked-badge-style";
const LOCKED_BADGE_LOCK_SVG =
  '<svg viewBox="0 0 448 512" width="65%" height="65%" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M144 144v48H304V144c0-44.2-35.8-80-80-80s-80 35.8-80 80zM80 192V144C80 64.5 144.5 0 224 0s144 64.5 144 144v48h16c35.3 0 64 28.7 64 64V448c0 35.3-28.7 64-64 64H64c-35.3 0-64-28.7-64-64V256c0-35.3 28.7-64 64-64H80z"/></svg>';

const LOCKED_BADGE_CSS = `
.${LOCKED_BADGE_CLASSNAME} {
  position: absolute;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 4px;
  box-sizing: border-box;
  border-radius: 4px;
  background: #0000008a;
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  color: white;
  pointer-events: none;
  z-index: 50;
}
.${LOCKED_BADGE_CLASSNAME}.top-left { top: 4px; left: 4px; }
.${LOCKED_BADGE_CLASSNAME}.top-right { top: 4px; right: 4px; }
.${LOCKED_BADGE_CLASSNAME}.bottom-left { bottom: 4px; left: 4px; }
.${LOCKED_BADGE_CLASSNAME}.bottom-right { bottom: 4px; right: 4px; }
.${LOCKED_BADGE_CLASSNAME}.center { top: 50%; left: 50%; transform: translate(-50%, -50%); }
`;

function injectLockedBadgeStyle(doc: Document) {
  if (doc.getElementById(LOCKED_BADGE_STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = LOCKED_BADGE_STYLE_ID;
  style.textContent = LOCKED_BADGE_CSS;
  doc.head.appendChild(style);
}

// Robust multi-fallback AppID extraction from a native Big Picture capsule element —
// mirrors decky-nonsteam-badges' technique: React fiber props first (most reliable,
// checked under several possible prop names since Steam's own internal naming isn't
// consistent across capsule types), then a data-id attribute, then an anchor href,
// since native capsules don't expose a plain data-appid attribute directly.
function extractAppIdFromCapsule(capsule: Element): string | null {
  try {
    const elementsToCheck = [capsule, ...Array.from(capsule.querySelectorAll("*"))];
    for (const el of elementsToCheck) {
      const key = Object.keys(el).find(
        (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")
      );
      if (!key) continue;
      let fiber: any = (el as any)[key];
      let depth = 0;
      while (fiber && depth < 5) {
        const props = fiber.memoizedProps || fiber.return?.memoizedProps;
        if (props) {
          const id =
            props.appid ??
            props.appId ??
            props.unAppID ??
            props.nAppID ??
            props.m_unAppID ??
            props.overview?.appid ??
            props.appOverview?.appid ??
            props.app?.unAppID ??
            props.app?.nAppID ??
            props.app?.appid ??
            props.game?.appid ??
            props.item?.appid;
          if (id != null) return String(id);
        }
        fiber = fiber.return;
        depth++;
      }
    }
  } catch (e) {
    // fall through to the DOM-based fallbacks below
  }

  const dataId = capsule.getAttribute("data-id");
  if (dataId && !dataId.startsWith("placeholder")) return dataId;

  const anchor = capsule.tagName.toLowerCase() === "a" ? capsule : capsule.querySelector("a");
  const href = anchor?.getAttribute("href");
  if (href) {
    const match = href.match(/\/app\/(\d+)/i) || href.match(/\/details\/(\d+)/i) || href.match(/run\/(\d+)/i);
    if (match) return match[1];
  }

  return null;
}

function isAppCurrentlyLocked(appid: string): boolean {
  const s = cachedSettings;
  return (
    !!s?.global_lock_enabled &&
    !!s?.locked_badge_enabled &&
    s.locked_apps.includes(appid) &&
    !unlockedThisSession.has(appid)
  );
}

function applyLockedBadgeToCapsule(capsule: Element, doc: Document) {
  const existing = capsule.querySelector(`.${LOCKED_BADGE_CLASSNAME}`);
  const appid = extractAppIdFromCapsule(capsule);

  if (!appid || !isAppCurrentlyLocked(appid)) {
    existing?.remove();
    return;
  }

  const role = capsule.getAttribute("role");
  const img = capsule.querySelector("img");
  let targetElement: HTMLElement;
  if (role === "gridcell") {
    // Library grid cells are rendered with style="display: contents" (confirmed live)
    // — an element with that display value generates no box of its own, so
    // position:relative on it has no effect and an absolute-positioned badge ends up
    // anchored to some unrelated ancestor instead. The gridcell's own first child div
    // is the real, boxed wrapper (mirrors decky-nonsteam-badges' identical handling of
    // this same native capsule type).
    targetElement = (img ? (capsule.querySelector("div") as HTMLElement | null) : null) ?? (capsule as HTMLElement);
  } else if (role === "listitem") {
    targetElement =
      (img?.closest('div[class*="_1pwP4"]') as HTMLElement | null) ??
      (img?.closest("div") as HTMLElement | null) ??
      (capsule as HTMLElement);
  } else {
    targetElement = capsule as HTMLElement;
  }

  const desiredClassName = `${LOCKED_BADGE_CLASSNAME} ${cachedSettings?.locked_badge_position ?? "top-left"}`;

  // Navigation Persistence Fix: if a badge exists but isn't a direct child of the
  // current target (React throws away and regenerates capsule DOM on navigation), drop
  // the stale one and re-create it below. If it's already correctly parented, just keep
  // its className in sync with the current position setting instead of leaving it as
  // whatever it was when first created — otherwise changing the position dropdown never
  // affects an already-badged capsule until its DOM happens to get thrown away.
  if (existing) {
    if (existing.parentElement !== targetElement) {
      existing.remove();
    } else {
      if (existing.className !== desiredClassName) existing.className = desiredClassName;
      return;
    }
  }

  const win = doc.defaultView;
  const computedPosition = win ? win.getComputedStyle(targetElement).position : targetElement.style.position;
  if (computedPosition === "static" || !computedPosition) {
    targetElement.style.position = "relative";
  }

  const badge = doc.createElement("div");
  badge.className = desiredClassName;
  badge.innerHTML = LOCKED_BADGE_LOCK_SVG;
  targetElement.appendChild(badge);
}

function scanAndApplyLockedBadges(doc: Document) {
  injectLockedBadgeStyle(doc);
  const selectors = [
    'div[role="tabpanel"] div[role="gridcell"]', // Library grid
    '.ReactVirtualized__Grid__innerScrollContainer div[role="listitem"]', // Home/Recent carousels
  ];
  for (const selector of selectors) {
    doc.querySelectorAll(selector).forEach((capsule) => applyLockedBadgeToCapsule(capsule, doc));
  }
}

function startLockedBadgeWatcher(doc: Document): () => void {
  scanAndApplyLockedBadges(doc);

  let debounceHandle: number | null = null;
  const debouncedScan = () => {
    if (debounceHandle != null) return;
    debounceHandle = (doc.defaultView ?? window).requestAnimationFrame(() => {
      scanAndApplyLockedBadges(doc);
      debounceHandle = null;
    });
  };

  const observer = new MutationObserver((mutations) => {
    if (mutations.some((m) => m.addedNodes.length > 0)) debouncedScan();
  });
  doc.querySelectorAll('div[role="tabpanel"], div[class*="Panel"]').forEach((container) => {
    observer.observe(container, { childList: true, subtree: true });
  });

  // Backup: catches games scrolled into view without a qualifying mutation, and
  // whenever locked_badge_enabled/locked_apps/position changes (no dedicated
  // settings-changed event for this — cheap enough to just re-check on this interval).
  const interval = setInterval(() => scanAndApplyLockedBadges(doc), 2000);

  return () => {
    observer.disconnect();
    clearInterval(interval);
    if (debounceHandle != null) (doc.defaultView ?? window).cancelAnimationFrame(debounceHandle);
  };
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

    const stopLockedBadgeWatcher = startLockedBadgeWatcher(realDoc);

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
      stopLockedBadgeWatcher();
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

// Shared expand/collapse pattern for settings sections (Lock Method, More Settings,
// Show Games List, Show Plugin List, and any future ones): a toggle button, and its
// content indented and given a top gap when expanded so it reads as subordinate to it.
function CollapsibleSection({
  label,
  expanded,
  onToggle,
  topMargin,
  children,
}: {
  label: string;
  expanded: boolean;
  onToggle: () => void;
  topMargin?: boolean;
  children: ReactNode;
}) {
  return (
    <>
      <PanelSectionRow>
        <div style={topMargin ? { marginTop: "12px" } : undefined}>
          <DialogButton
            onClick={onToggle}
            style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between" }}
          >
            <span>{label}</span>
            {expanded ? <FaChevronDown size={14} /> : <FaChevronRight size={14} />}
          </DialogButton>
        </div>
      </PanelSectionRow>
      {expanded && <div style={{ marginTop: "8px", paddingLeft: "16px" }}>{children}</div>}
    </>
  );
}

// Quick-Access Menu panel content. Shows a PIN entry gate first when QAM lock is
// enabled and a PIN has been set, then the main settings panel.
function Content() {
  const [settings, setSettings] = useState<DeckLockerSettings>(() => ({
    global_lock_enabled: false,
    locked_apps: [],
    locked_plugins: [],
    locked_qam_tabs: [],
    locked_main_menu_items: [],
    pin_set: false,
    password_set: false,
    pattern_set: false,
    tap_code_set: false,
    qam_lock_enabled: false,
    keypad_corner_radius: 14,
    lockscreen_hero_bg_enabled: false,
    lockscreen_bg_blur_px: 8,
    lockscreen_bg_opacity_percent: 30,
    relock_animation_enabled: true,
    keypad_shape: "rounded",
    keypad_glass_effect: false,
    keypad_on_right: false,
    relock_on_sleep: false,
    relock_on_exit: false,
    decky_panel_lock_enabled: false,
    hide_game_art: false,
    keypad_key_size: 80,
    keypad_font_size: 22,
    locked_badge_enabled: true,
    locked_badge_position: "top-left",
    lock_method: "pin",
    pattern_dot_shape: "rounded",
    pattern_corner_radius: 14,
    pattern_dot_size: 72,
    pattern_glass_effect: false,
    pattern_line_theme_color: false,
    pattern_line_transparent: false,
    action_button_glass_effect: false,
    tap_code_show_outline: true,
    tap_code_show_dividers: false,
  }));
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [otherPlugins, setOtherPlugins] = useState<{ name: string; icon?: ReactNode }[]>([]);
  const [showGamesList, setShowGamesList] = useState(false);
  const [showPluginList, setShowPluginList] = useState(false);
  const [showTabsList, setShowTabsList] = useState(false);
  const [showMainMenuItemsList, setShowMainMenuItemsList] = useState(false);
  const [showLockMethod, setShowLockMethod] = useState(false);
  const [showCustomization, setShowCustomization] = useState(false);
  const [showMoreSettings, setShowMoreSettings] = useState(false);

  // Persists once unlocked — closing/reopening the QAM (or switching tabs) no longer
  // re-locks it; only an explicit relock event (sleep, if Re-lock on Sleep is enabled)
  // resets qamUnlockedThisSession.
  const [qamUnlocked, setQamUnlocked] = useState(() => qamUnlockedThisSession);
  const [qamPinInput, setQamPinInput] = useState("");
  const [qamPatternNodes, setQamPatternNodes] = useState<number[]>([]);
  const [qamKnockSequence, setQamKnockSequence] = useState<number[]>([]);
  const [qamPinError, setQamPinError] = useState("");

  useEffect(() => {
    getSettings().then(setSettings);
    setApps(getInstalledApps());
  }, []);

  // Refreshes the "other installed plugins" list each time the panel is opened, since
  // it's read from Decky Loader's own live plugin state rather than something we own.
  useEffect(() => {
    if (!showPluginList) return;
    const state = getDeckyStateValue();
    setOtherPlugins(
      (state?.plugins ?? [])
        .filter((p) => p.name !== "Deck Locker")
        .map((p) => ({ name: p.name, icon: p.icon }))
        .sort((a, b) => a.name.localeCompare(b.name))
    );
  }, [showPluginList]);

  const onGlobalToggle = async (checked: boolean) => {
    const updated = await setGlobalLock(checked);
    setSettings(updated);
    setCachedSettings(updated);
  };

  const onQamLockToggle = async (checked: boolean) => {
    const updated = await setQamLock(checked);
    setSettings(updated);
    setCachedSettings(updated);
  };

  const onDeckyPanelLockToggle = async (checked: boolean) => {
    const updated = await setCustomization({ decky_panel_lock_enabled: checked });
    setSettings(updated);
    setCachedSettings(updated);
  };

  const onRelockOnSleepToggle = async (checked: boolean) => {
    const updated = await setCustomization({ relock_on_sleep: checked });
    setSettings(updated);
    setCachedSettings(updated);
  };

  const onRelockOnExitToggle = async (checked: boolean) => {
    const updated = await setCustomization({ relock_on_exit: checked });
    setSettings(updated);
    setCachedSettings(updated);
  };

  const onAppToggle = async (appid: string, checked: boolean) => {
    const lockedApps = await toggleApp(appid, checked);
    setSettings((prev) => ({ ...prev, locked_apps: lockedApps }));
    if (cachedSettings) setCachedSettings({ ...cachedSettings, locked_apps: lockedApps });
  };

  const onPluginToggle = async (pluginName: string, checked: boolean) => {
    const lockedPlugins = await togglePluginLock(pluginName, checked);
    setSettings((prev) => ({ ...prev, locked_plugins: lockedPlugins }));
    if (cachedSettings) setCachedSettings({ ...cachedSettings, locked_plugins: lockedPlugins });
    // Apply immediately rather than waiting for the next time the Decky tab becomes
    // active — the user is already looking at this plugin's own panel right now.
    applyPluginLocks();
  };

  const onQamTabToggle = async (tabName: string, checked: boolean) => {
    const lockedTabs = await toggleQamTabLock(tabName, checked);
    setSettings((prev) => ({ ...prev, locked_qam_tabs: lockedTabs }));
    if (cachedSettings) setCachedSettings({ ...cachedSettings, locked_qam_tabs: lockedTabs });
    // No immediate apply needed here — the toggled tab isn't the one currently
    // visible (the user is looking at this settings panel, on Decky's own tab), and
    // the wrap/unwrap runs on every QAM render regardless, which happens often enough
    // while the QAM stays open.
  };

  const onMainMenuItemToggle = async (itemName: string, checked: boolean) => {
    const lockedItems = await toggleMainMenuItemLock(itemName, checked);
    setSettings((prev) => ({ ...prev, locked_main_menu_items: lockedItems }));
    if (cachedSettings) setCachedSettings({ ...cachedSettings, locked_main_menu_items: lockedItems });
  };

  const onCustomizationChange = async (updates: Partial<DeckLockerSettings>) => {
    const updated = await setCustomization(updates);
    setSettings(updated);
    setCachedSettings(updated);
  };

  // In-plugin equivalent of running scripts/reset-decklocker.sh — wipes the lock
  // credential and every lock/customization choice back to defaults (the backend backs
  // up the old settings file first, same as the script). Confirmed via a destructive
  // ConfirmModal first since there's no undo from inside the plugin.
  const onFactoryReset = async () => {
    const updated = await resetAllSettings();
    setSettings(updated);
    setCachedSettings(updated);
  };

  const onQamPinSubmit = async () => {
    const isEmpty =
      settings.lock_method === "pattern"
        ? qamPatternNodes.length === 0
        : settings.lock_method === "tap_code"
        ? qamKnockSequence.length === 0
        : qamPinInput.length === 0;
    if (isEmpty) return;
    const value =
      settings.lock_method === "pattern"
        ? sequenceToString(qamPatternNodes)
        : settings.lock_method === "tap_code"
        ? sequenceToString(qamKnockSequence)
        : qamPinInput;
    const ok = await checkCredential(settings.lock_method, value);
    if (ok) {
      qamUnlockedThisSession = true;
      setQamUnlocked(true);
      setQamPinError("");
    } else {
      setQamPinError(`Incorrect ${credentialLabel(settings.lock_method)}`);
      setQamPinInput("");
      setQamPatternNodes([]);
      setQamKnockSequence([]);
    }
  };

  if (settings.qam_lock_enabled && hasCredentialSet(settings) && !qamUnlocked) {
    return (
      <PanelSection>
        <PanelSectionRow>
          <div style={{ fontWeight: "bold", marginBottom: "4px" }}>Enter {credentialLabel(settings.lock_method)}</div>
        </PanelSectionRow>
        <CredentialCompactEntry
          lockMethod={settings.lock_method}
          pin={qamPinInput}
          onPinChange={(value) => {
            setQamPinError("");
            setQamPinInput(value);
          }}
          pattern={qamPatternNodes}
          onPatternChange={(nodes) => {
            setQamPinError("");
            setQamPatternNodes(nodes);
          }}
          onPatternSubmit={onQamPinSubmit}
          patternSettings={{
            lineThemeColor: settings.pattern_line_theme_color,
            lineTransparent: settings.pattern_line_transparent,
            dotShape: settings.pattern_dot_shape,
            cornerRadius: settings.pattern_corner_radius,
            glassEffect: settings.pattern_glass_effect,
          }}
          knock={qamKnockSequence}
          onKnockTap={(index) => {
            setQamPinError("");
            setQamKnockSequence((prev) => [...prev, index]);
          }}
          knockSettings={{
            showOutline: settings.tap_code_show_outline,
            showDividers: settings.tap_code_show_dividers,
          }}
        />
        {qamPinError && (
          <PanelSectionRow>
            <div style={{ color: "#f44336", fontSize: "13px" }}>{qamPinError}</div>
          </PanelSectionRow>
        )}
        {/* Pattern submits on drag-release (see PatternPad's onDragComplete) — no
            separate confirm step needed, unlike PIN/Password which still need this
            button. */}
        {settings.lock_method !== "pattern" && (
          <PanelSectionRow>
            <ButtonItem layout="below" onClick={onQamPinSubmit}>
              Unlock
            </ButtonItem>
          </PanelSectionRow>
        )}
      </PanelSection>
    );
  }

  if (showCustomization) {
    return (
      <PanelSection>
        <PanelSectionRow>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ fontWeight: "bold" }}>CUSTOMIZATION</div>
            <DialogButton
              onClick={() => setShowCustomization(false)}
              style={{ width: "32px", minWidth: "32px", padding: "4px" }}
            >
              X
            </DialogButton>
          </div>
        </PanelSectionRow>

        {/* PIN-only — the numeric keypad grid. Password's text field, Pattern's dot
            grid, and Knock Code's 2x2 grid each get their own (much smaller) section
            instead of sharing this one. */}
        {settings.lock_method === "pin" && (
          <>
            <PanelSectionRow>
              <div style={{ fontWeight: "bold", marginTop: "12px", opacity: 0.7, fontSize: "12px" }}>KEYPAD</div>
            </PanelSectionRow>

            <PanelSectionRow>
              <DropdownItem
                label="Key Shape"
                description="Choose the shape of the keypad buttons"
                rgOptions={[
                  { data: "square", label: "Square" },
                  { data: "rounded", label: "Rounded" },
                  { data: "circle", label: "Circle" },
                ]}
                selectedOption={settings.keypad_shape}
                onChange={(option) => onCustomizationChange({ keypad_shape: option.data })}
              />
            </PanelSectionRow>

            {settings.keypad_shape === "rounded" && (
              <PanelSectionRow>
                <SliderField
                  label="Corner Roundness"
                  description="How rounded the key corners are"
                  value={settings.keypad_corner_radius}
                  min={0}
                  max={36}
                  step={1}
                  onChange={(value: number) => onCustomizationChange({ keypad_corner_radius: value })}
                />
              </PanelSectionRow>
            )}

            <PanelSectionRow>
              <SliderField
                label="Key Size"
                description="Size of each keypad button"
                value={settings.keypad_key_size}
                min={60}
                max={110}
                step={2}
                onChange={(value: number) => onCustomizationChange({ keypad_key_size: value })}
              />
            </PanelSectionRow>

            <PanelSectionRow>
              <SliderField
                label="Number Size"
                description="Size of the numbers on each key"
                value={settings.keypad_font_size}
                min={14}
                max={32}
                step={1}
                onChange={(value: number) => onCustomizationChange({ keypad_font_size: value })}
              />
            </PanelSectionRow>

            <PanelSectionRow>
              <ToggleField
                label="Glass Effect"
                description="Frosted-glass look for the keypad buttons"
                checked={settings.keypad_glass_effect}
                onChange={(checked) => onCustomizationChange({ keypad_glass_effect: checked })}
              />
            </PanelSectionRow>
          </>
        )}

        {/* Pattern's own dot grid — replicated from KEYPAD above (same shape/size/glass
            vocabulary) with its own independent settings, plus "None" (a bare dot with
            no cell behind it, so Dot Size/Glass Effect have nothing left to affect and
            are hidden) and the theme line-color option. */}
        {settings.lock_method === "pattern" && (
          <>
            <PanelSectionRow>
              <div style={{ fontWeight: "bold", marginTop: "12px", opacity: 0.7, fontSize: "12px" }}>PATTERN</div>
            </PanelSectionRow>

            <PanelSectionRow>
              <DropdownItem
                label="Dot Shape"
                description="Choose the shape behind each dot, or None for bare dots"
                rgOptions={[
                  { data: "square", label: "Square" },
                  { data: "rounded", label: "Rounded" },
                  { data: "circle", label: "Circle" },
                  { data: "none", label: "None" },
                ]}
                selectedOption={settings.pattern_dot_shape}
                onChange={(option) => onCustomizationChange({ pattern_dot_shape: option.data })}
              />
            </PanelSectionRow>

            {settings.pattern_dot_shape === "rounded" && (
              <PanelSectionRow>
                <SliderField
                  label="Corner Roundness"
                  description="How rounded the dot cell's corners are"
                  value={settings.pattern_corner_radius}
                  min={0}
                  max={36}
                  step={1}
                  onChange={(value: number) => onCustomizationChange({ pattern_corner_radius: value })}
                />
              </PanelSectionRow>
            )}

            {settings.pattern_dot_shape !== "none" && (
              <PanelSectionRow>
                <SliderField
                  label="Dot Size"
                  description="Size of each dot's cell"
                  value={settings.pattern_dot_size}
                  min={60}
                  max={110}
                  step={2}
                  onChange={(value: number) => onCustomizationChange({ pattern_dot_size: value })}
                />
              </PanelSectionRow>
            )}

            {settings.pattern_dot_shape !== "none" && (
              <PanelSectionRow>
                <ToggleField
                  label="Glass Effect"
                  description="Frosted-glass look for each dot's cell"
                  checked={settings.pattern_glass_effect}
                  onChange={(checked) => onCustomizationChange({ pattern_glass_effect: checked })}
                />
              </PanelSectionRow>
            )}

            <PanelSectionRow>
              <ToggleField
                label="Theme Color"
                description="Color the dots/lines using the current theme's slider color instead of white"
                checked={settings.pattern_line_theme_color}
                onChange={(checked) => onCustomizationChange({ pattern_line_theme_color: checked })}
              />
            </PanelSectionRow>

            <PanelSectionRow>
              <ToggleField
                label="Transparent Line"
                description="Hide the line connecting the dots — only the dots themselves show"
                checked={settings.pattern_line_transparent}
                onChange={(checked) => onCustomizationChange({ pattern_line_transparent: checked })}
              />
            </PanelSectionRow>
          </>
        )}

        {/* Knock Code's customization is deliberately minimal — there's no per-cell
            background, shape, or size left to style (see KnockCodePad), so the only
            things left to offer are the single outline around the whole grid and,
            optionally, divider lines splitting it into 4 visible quadrants. */}
        {settings.lock_method === "tap_code" && (
          <>
            <PanelSectionRow>
              <div style={{ fontWeight: "bold", marginTop: "12px", opacity: 0.7, fontSize: "12px" }}>KNOCK CODE</div>
            </PanelSectionRow>

            <PanelSectionRow>
              <ToggleField
                label="Outline"
                description="Show an outline around the whole Knock Code grid"
                checked={settings.tap_code_show_outline}
                onChange={(checked) => onCustomizationChange({ tap_code_show_outline: checked })}
              />
            </PanelSectionRow>

            <PanelSectionRow>
              <ToggleField
                label="Dividers"
                description="Show divider lines splitting the grid into 4 quadrants"
                checked={settings.tap_code_show_dividers}
                onChange={(checked) => onCustomizationChange({ tap_code_show_dividers: checked })}
              />
            </PanelSectionRow>
          </>
        )}

        {/* Password's text field and Pattern's dot grid share the same dedicated
            Cancel/OK row (PIN's own Cancel/OK are keypad cells, covered by the
            KEYPAD section's own Glass Effect above instead; Knock Code's own Cancel/OK
            row intentionally isn't customizable, keeping its section above minimal). */}
        {(settings.lock_method === "password" || settings.lock_method === "pattern") && (
          <>
            <PanelSectionRow>
              <div style={{ fontWeight: "bold", marginTop: "12px", opacity: 0.7, fontSize: "12px" }}>BUTTONS</div>
            </PanelSectionRow>

            <PanelSectionRow>
              <ToggleField
                label="Cancel/OK Glass Effect"
                description="Frosted-glass look for the Cancel and OK buttons"
                checked={settings.action_button_glass_effect}
                onChange={(checked) => onCustomizationChange({ action_button_glass_effect: checked })}
              />
            </PanelSectionRow>
          </>
        )}

        <PanelSectionRow>
          <div style={{ fontWeight: "bold", marginTop: "12px", opacity: 0.7, fontSize: "12px" }}>GENERAL</div>
        </PanelSectionRow>

        <PanelSectionRow>
          <ToggleField
            label="Game Art"
            description="Show the game cover art next to the lock screen"
            checked={!settings.hide_game_art}
            onChange={(checked) => onCustomizationChange({ hide_game_art: !checked })}
          />
        </PanelSectionRow>

        {!settings.hide_game_art && (
          <PanelSectionRow>
            <ToggleField
              label="Swap Side"
              description="Move the credential entry to the right, game art to the left"
              checked={settings.keypad_on_right}
              onChange={(checked) => onCustomizationChange({ keypad_on_right: checked })}
            />
          </PanelSectionRow>
        )}

        <PanelSectionRow>
          <ToggleField
            label="Blurred Background"
            description="Show the game's art blurred behind the lock screen"
            checked={settings.lockscreen_hero_bg_enabled}
            onChange={(checked) => onCustomizationChange({ lockscreen_hero_bg_enabled: checked })}
          />
        </PanelSectionRow>

        {settings.lockscreen_hero_bg_enabled && (
          <>
            <PanelSectionRow>
              <SliderField
                label="Background Blur"
                description="How blurry the background looks"
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
                description="How visible the background is"
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
            description="Play a closing-lock animation when you manually re-lock a game"
            checked={settings.relock_animation_enabled}
            onChange={(checked) => onCustomizationChange({ relock_animation_enabled: checked })}
          />
        </PanelSectionRow>

        <PanelSectionRow>
          <div style={{ fontWeight: "bold", marginTop: "12px", opacity: 0.7, fontSize: "12px" }}>LOCKED BADGES</div>
        </PanelSectionRow>

        <PanelSectionRow>
          <ToggleField
            label="Enable Locked Badges"
            description="Show a lock icon on locked games' covers in Home, Recent, and the Library"
            checked={settings.locked_badge_enabled}
            onChange={(checked) => onCustomizationChange({ locked_badge_enabled: checked })}
          />
        </PanelSectionRow>

        {settings.locked_badge_enabled && (
          <PanelSectionRow>
            <DropdownItem
              label="Badge Position"
              description="Applies everywhere the badge appears (Home, Recent, Library, etc.)"
              rgOptions={[
                { data: "top-left", label: "Top Left" },
                { data: "top-right", label: "Top Right" },
                { data: "center", label: "Center" },
                { data: "bottom-left", label: "Bottom Left" },
                { data: "bottom-right", label: "Bottom Right" },
              ]}
              selectedOption={settings.locked_badge_position}
              onChange={(option) => onCustomizationChange({ locked_badge_position: option.data })}
            />
          </PanelSectionRow>
        )}

        <PanelSectionRow>
          <div style={{ marginTop: "12px" }}>
            <ButtonItem
              layout="below"
              onClick={() =>
                onCustomizationChange({
                  keypad_shape: "rounded",
                  keypad_corner_radius: 14,
                  keypad_key_size: 80,
                  keypad_font_size: 22,
                  keypad_glass_effect: false,
                  keypad_on_right: false,
                  pattern_dot_shape: "rounded",
                  pattern_corner_radius: 14,
                  pattern_dot_size: 72,
                  pattern_glass_effect: false,
                  pattern_line_theme_color: false,
                  pattern_line_transparent: false,
                  action_button_glass_effect: false,
                  tap_code_show_outline: true,
                  tap_code_show_dividers: false,
                  hide_game_art: false,
                  lockscreen_hero_bg_enabled: false,
                  lockscreen_bg_blur_px: 8,
                  lockscreen_bg_opacity_percent: 30,
                  relock_animation_enabled: true,
                  locked_badge_enabled: true,
                  locked_badge_position: "top-left",
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
          description="Require a PIN to access locked content"
          checked={settings.global_lock_enabled}
          onChange={onGlobalToggle}
        />
      </PanelSectionRow>

      {settings.global_lock_enabled && (
        <>
          <CollapsibleSection
            label="Lock Method"
            expanded={showLockMethod}
            onToggle={() => setShowLockMethod((v) => !v)}
            topMargin
          >
            {LOCK_METHOD_OPTIONS.map((method) => (
              <PanelSectionRow key={method.data}>
                <Field
                  label={method.implemented ? method.label : `${method.label} (Soon)`}
                  disabled={!method.implemented}
                  focusable={method.implemented}
                  onActivate={() => onCustomizationChange({ lock_method: method.data })}
                >
                  {settings.lock_method === method.data && <FaCheck size={14} color="#4caf50" />}
                </Field>
              </PanelSectionRow>
            ))}
          </CollapsibleSection>

          <PanelSectionRow>
            <ButtonItem
              layout="below"
              onClick={() => {
                const refresh = () => getSettings().then((s) => { setSettings(s); setCachedSettings(s); });
                showModal(
                  settings.lock_method === "password" ? (
                    <SetPasswordModal onPasswordSet={refresh} />
                  ) : settings.lock_method === "pattern" ? (
                    <SetPatternModal onPatternSet={refresh} />
                  ) : settings.lock_method === "tap_code" ? (
                    <SetKnockCodeModal onTapCodeSet={refresh} />
                  ) : (
                    <SetPinModal onPinSet={refresh} />
                  )
                );
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span>Set {credentialLabel(settings.lock_method)}</span>
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

          <CollapsibleSection
            label="More Settings"
            expanded={showMoreSettings}
            onToggle={() => setShowMoreSettings((v) => !v)}
          >
            <PanelSectionRow>
              <ToggleField
                label="Lock Decky Panel"
                description="Require a PIN before the Decky plugin list is shown"
                checked={settings.decky_panel_lock_enabled}
                onChange={onDeckyPanelLockToggle}
              />
            </PanelSectionRow>

            <PanelSectionRow>
              <ToggleField
                label="Re-lock on Sleep"
                description="Lock everything again when the Steam Deck goes to sleep"
                checked={settings.relock_on_sleep}
                onChange={onRelockOnSleepToggle}
              />
            </PanelSectionRow>

            <PanelSectionRow>
              <ToggleField
                label="Re-lock When Leaving Game"
                description="Ask for the PIN again each time you revisit a locked game's page"
                checked={settings.relock_on_exit}
                onChange={onRelockOnExitToggle}
              />
            </PanelSectionRow>
          </CollapsibleSection>

          <PanelSectionRow>
            <div style={{ height: "1px", background: "rgba(255,255,255,0.15)", marginTop: "16px", marginBottom: "4px" }} />
          </PanelSectionRow>

          {hasCredentialSet(settings) && (
            <>
              <PanelSectionRow>
                <div style={{ fontWeight: "bold", marginTop: "16px" }}>GAMES</div>
                <div style={{ fontSize: "12px", opacity: 0.7, marginTop: "2px" }}>
                  Choose which games require a PIN, including non-Steam games
                </div>
              </PanelSectionRow>

              <CollapsibleSection
                label="Show Games List"
                expanded={showGamesList}
                onToggle={() => setShowGamesList((v) => !v)}
                topMargin
              >
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
              </CollapsibleSection>

              <PanelSectionRow>
                <div style={{ height: "1px", background: "rgba(255,255,255,0.15)", marginTop: "16px", marginBottom: "4px" }} />
                <div style={{ fontWeight: "bold", marginTop: "8px" }}>PLUGINS</div>
                <div style={{ fontSize: "12px", opacity: 0.7, marginTop: "2px" }}>
                  Lock access to Decky plugins
                </div>
              </PanelSectionRow>

              <CollapsibleSection
                label="Show Plugin List"
                expanded={showPluginList}
                onToggle={() => setShowPluginList((v) => !v)}
                topMargin
              >
                <PanelSectionRow>
                  <ToggleField
                    label="Deck Locker"
                    description="Require a PIN to open this plugin's settings panel"
                    checked={settings.qam_lock_enabled}
                    onChange={onQamLockToggle}
                  />
                </PanelSectionRow>
                {otherPlugins.length === 0 && (
                  <PanelSectionRow>
                    <div style={{ fontSize: "12px", opacity: 0.6, marginTop: "2px" }}>
                      No other plugins found.
                    </div>
                  </PanelSectionRow>
                )}
                {otherPlugins.map((plugin) => (
                  <PanelSectionRow key={plugin.name}>
                    <ToggleField
                      label={plugin.name}
                      description="Require a PIN before this plugin's content is shown"
                      checked={settings.locked_plugins.includes(plugin.name)}
                      onChange={(checked) => onPluginToggle(plugin.name, checked)}
                    />
                  </PanelSectionRow>
                ))}
              </CollapsibleSection>

              <PanelSectionRow>
                <div style={{ height: "1px", background: "rgba(255,255,255,0.15)", marginTop: "16px", marginBottom: "4px" }} />
                <div style={{ fontWeight: "bold", marginTop: "8px" }}>QUICK MENU</div>
                <div style={{ fontSize: "12px", opacity: 0.7, marginTop: "2px" }}>
                  Lock access to Quick Access Menu tabs
                </div>
              </PanelSectionRow>

              <CollapsibleSection
                label="Show Tabs List"
                expanded={showTabsList}
                onToggle={() => setShowTabsList((v) => !v)}
                topMargin
              >
                {BUILTIN_LOCKABLE_TABS.map((tab) => (
                  <PanelSectionRow key={tab.name}>
                    <ToggleField
                      label={tab.name}
                      description="Require a PIN before this tab's content is shown"
                      checked={settings.locked_qam_tabs.includes(tab.name)}
                      onChange={(checked) => onQamTabToggle(tab.name, checked)}
                    />
                  </PanelSectionRow>
                ))}
              </CollapsibleSection>

              <PanelSectionRow>
                <div style={{ height: "1px", background: "rgba(255,255,255,0.15)", marginTop: "16px", marginBottom: "4px" }} />
                <div style={{ fontWeight: "bold", marginTop: "8px" }}>STEAM MENU</div>
                <div style={{ fontSize: "12px", opacity: 0.7, marginTop: "2px" }}>
                  Lock access to items in the Steam button menu
                </div>
              </PanelSectionRow>

              <CollapsibleSection
                label="Show Items List"
                expanded={showMainMenuItemsList}
                onToggle={() => setShowMainMenuItemsList((v) => !v)}
                topMargin
              >
                {MAIN_MENU_LOCKABLE_ITEMS.map((item) => (
                  <PanelSectionRow key={item}>
                    <ToggleField
                      label={item}
                      description="Require a PIN before this item's content is shown"
                      checked={settings.locked_main_menu_items.includes(item)}
                      onChange={(checked) => onMainMenuItemToggle(item, checked)}
                    />
                  </PanelSectionRow>
                ))}
              </CollapsibleSection>

              <PanelSectionRow>
                <div style={{ height: "3px", background: "rgba(255,255,255,0.15)", marginTop: "16px", marginBottom: "12px", borderRadius: "2px" }} />
              </PanelSectionRow>

              <PanelSectionRow>
                {/* Plain DialogButton rather than ButtonItem — ButtonItem draws its own
                    native bottom separator line, which read as a stray divider sitting
                    above the GitHub row right below it. DialogButton (same as the
                    GitHub/QR buttons underneath) doesn't carry that. */}
                <DialogButton
                  onClick={() =>
                    showModal(
                      <ConfirmModal
                        strTitle="Reset Deck Locker?"
                        strDescription="This erases your lock credential and every lock/customization setting back to defaults — the same wipe scripts/reset-decklocker.sh does. A backup of the current settings is kept alongside it. This can't be undone from here."
                        bDestructiveWarning
                        strOKButtonText="Reset"
                        onOK={onFactoryReset}
                      />
                    )
                  }
                  style={{ width: "100%" }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span>Reset Deck Locker</span>
                    <FaTrash size={14} />
                  </div>
                </DialogButton>
              </PanelSectionRow>

              <PanelSectionRow>
                {/* Grid (not flex) so Steam's spatial nav moves between the two buttons
                    with left/right instead of treating the row as a single stop — same
                    fix as Cancel/OK on the lock screen itself. The GitHub glyph stays a
                    plain (non-focusable) decoration outside the grid. */}
                <div style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "12px" }}>
                  <FaGithub size={28} color="#fff" style={{ flexShrink: 0, opacity: 0.85 }} />
                  <Focusable
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 40px",
                      gap: "8px",
                      flex: 1,
                    }}
                  >
                    <Focusable style={{ minWidth: 0 }}>
                      <DialogButton
                        onClick={() => Navigation.NavigateToExternalWeb(DECKLOCKER_GITHUB_URL)}
                        style={{ width: "100%", minWidth: 0, boxSizing: "border-box" }}
                      >
                        Open Project
                      </DialogButton>
                    </Focusable>
                    <Focusable style={{ minWidth: 0 }}>
                      <DialogButton
                        onClick={() => showModal(<ProjectQrModal />)}
                        style={{ width: "100%", minWidth: "40px", padding: "10px", boxSizing: "border-box" }}
                      >
                        <FaQrcode size={16} />
                      </DialogButton>
                    </Focusable>
                  </Focusable>
                </div>
              </PanelSectionRow>
            </>
          )}
        </>
      )}
    </PanelSection>
  );
}

// Fallback for when the Steam Client removes SteamClient.System.RegisterForOnSuspendRequest /
// RegisterForOnResumeFromSuspend (this has happened on Steam Beta Client releases — see
// SteamDeckHomebrew/decky-loader#803, unresolved upstream). The private webpack module that
// backs those two calls is still reachable directly; same technique used by decky-autosuspend.
const SleepManager = findModuleChild((m: any) => {
  if (typeof m !== "object" || m === null) return undefined;
  for (const prop in m) {
    try {
      if (m[prop]?.RegisterForNotifyResumeFromSuspend) return m[prop];
    } catch {
      return undefined;
    }
  }
});

export default definePlugin(() => {
  getSettingsCached().catch((e) => console.error("DeckLocker: initial settings warm-up failed", e));

  const libraryAppPagePatch = patchAppPage();
  const stopLibraryRouteLockWatcher = startLibraryRouteLockWatcher();

  routerHook.addGlobalComponent("DeckLockerMenuWatcher", GlobalMenuWatcher);
  const qamDeckyTabLockHook = patchQamDeckyTabLock();
  const mainMenuLockHook = patchMainMenuLock();

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

  // Clears all per-session game unlocks, plus the QAM/Decky panel unlocks (which
  // otherwise persist indefinitely once entered), when the Steam Deck goes to sleep,
  // if the user has relock_on_sleep enabled.
  let suspendHook: any;
  const relockOnSuspend = () => {
    const s = cachedSettings;
    if (s?.relock_on_sleep) {
      unlockedThisSession.clear();
      settledThisSession.clear();
      qamUnlockedThisSession = false;
      deckyQamLocked = true;
    }
  };
  const suspendRegistrars: Array<[string, (cb: () => void) => any]> = [
    ["SteamClient.System.RegisterForOnSuspendRequest", (cb) => (window as any).SteamClient?.System?.RegisterForOnSuspendRequest?.(cb)],
    ["SteamClient.System.RegisterForOnResumeFromSuspend", (cb) => (window as any).SteamClient?.System?.RegisterForOnResumeFromSuspend?.(cb)],
    ["SleepManager.RegisterForNotifyRequestSuspend", (cb) => SleepManager?.RegisterForNotifyRequestSuspend?.(cb)],
    ["SleepManager.RegisterForNotifyResumeFromSuspend", (cb) => SleepManager?.RegisterForNotifyResumeFromSuspend?.(cb)],
  ];
  for (const [label, register] of suspendRegistrars) {
    try {
      const result = register(relockOnSuspend);
      if (result) {
        suspendHook = result;
        console.log("DeckLocker: registered suspend hook via " + label);
        break;
      }
    } catch (e) {
      console.warn("DeckLocker: " + label + " failed:", e);
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
      stopLibraryRouteLockWatcher();
      routerHook.removeGlobalComponent("DeckLockerMenuWatcher");
      qamDeckyTabLockHook.unregister();
      mainMenuLockHook.unregister();
      lifetimeHook?.unregister?.();
      suspendHook?.unregister?.();
    },
  };
});
