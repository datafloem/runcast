// Browser permissions (scenario({ permissions })): decided before the first
// page load, so a test never waits on a prompt, and reported when the page
// asks, so the video can draw the prompt Chrome would show.

export type PermissionDecision = "allow" | "block";

/** The scenario's permissions: a list (all allowed) or each with its answer. */
export type PermissionsOption = Array<string> | Record<string, PermissionDecision>;

/** The binding the page calls when it asks (see wrapPermissions). */
export const PERMISSION_BINDING = "__runcastPermission";

export function permissionDecisions(option: PermissionsOption): Record<string, PermissionDecision> {
  return Array.isArray(option)
    ? Object.fromEntries(option.map((name) => [name, "allow" as const]))
    : { ...option };
}

/**
 * Runs in the page before its own scripts (an init script). Wraps the APIs
 * that make Chrome ask for the permissions the scenario names: each request
 * is reported to the kit; a blocked one fails the way Chrome fails it.
 * Self-contained: no imports, no outside names.
 */
export function wrapPermissions(decisions: Record<string, "allow" | "block">): void {
  const report = (names: Array<string>) => {
    const known = names.filter((name) => decisions[name]);
    if (known.length === 0) return;
    const binding = (window as unknown as Record<string, (names: Array<string>) => Promise<void>>)[
      "__runcastPermission"
    ];
    binding?.(known).catch(() => {});
  };
  const blocked = (names: Array<string>) => names.some((name) => decisions[name] === "block");
  const notAllowed = () => new DOMException("Permission denied", "NotAllowedError");

  const geo = navigator.geolocation as Geolocation | undefined;
  if (geo && decisions.geolocation) {
    const get = geo.getCurrentPosition.bind(geo);
    const watch = geo.watchPosition.bind(geo);
    let fakeId = 1_000_000;
    const deny = (error?: PositionErrorCallback | null) => {
      setTimeout(
        () =>
          error?.({
            code: 1,
            message: "User denied Geolocation",
            PERMISSION_DENIED: 1,
            POSITION_UNAVAILABLE: 2,
            TIMEOUT: 3,
          } as GeolocationPositionError),
        0,
      );
    };
    geo.getCurrentPosition = (success, error, options) => {
      report(["geolocation"]);
      if (blocked(["geolocation"])) return deny(error);
      return get(success, error, options);
    };
    geo.watchPosition = (success, error, options) => {
      report(["geolocation"]);
      if (blocked(["geolocation"])) {
        deny(error);
        return fakeId++;
      }
      return watch(success, error, options);
    };
  }

  if (typeof Notification !== "undefined" && decisions.notifications) {
    const request = Notification.requestPermission.bind(Notification);
    Notification.requestPermission = ((callback?: NotificationPermissionCallback) => {
      report(["notifications"]);
      if (blocked(["notifications"])) {
        callback?.("denied");
        return Promise.resolve("denied" as NotificationPermission);
      }
      return request(callback);
    }) as typeof Notification.requestPermission;
    if (blocked(["notifications"])) {
      Object.defineProperty(Notification, "permission", { get: () => "denied", configurable: true });
    }
  }

  const media = navigator.mediaDevices as MediaDevices | undefined;
  if (media?.getUserMedia && (decisions.camera || decisions.microphone)) {
    const getUserMedia = media.getUserMedia.bind(media);
    media.getUserMedia = (constraints?: MediaStreamConstraints) => {
      const names = [
        ...(constraints?.video ? ["camera"] : []),
        ...(constraints?.audio ? ["microphone"] : []),
      ];
      report(names);
      if (blocked(names)) return Promise.reject(notAllowed());
      return getUserMedia(constraints);
    };
  }

  const clipboard = navigator.clipboard as Clipboard | undefined;
  if (clipboard && decisions["clipboard-read"]) {
    for (const method of ["read", "readText"] as const) {
      const original = clipboard[method]?.bind(clipboard) as (() => Promise<unknown>) | undefined;
      if (!original) continue;
      (clipboard as unknown as Record<string, () => Promise<unknown>>)[method] = () => {
        report(["clipboard-read"]);
        if (blocked(["clipboard-read"])) return Promise.reject(notAllowed());
        return original();
      };
    }
  }

  // permissions.query names a blocked permission "denied", as Chrome does.
  const permissions = navigator.permissions as Permissions | undefined;
  if (permissions?.query) {
    const query = permissions.query.bind(permissions);
    permissions.query = (descriptor: PermissionDescriptor) => {
      const name = descriptor?.name === ("clipboard-read" as PermissionName) ? "clipboard-read" : descriptor?.name;
      if (name && decisions[name] === "block") {
        const status = new EventTarget() as PermissionStatus;
        Object.defineProperties(status, {
          state: { value: "denied" },
          name: { value: descriptor.name },
          onchange: { value: null, writable: true },
        });
        return Promise.resolve(status);
      }
      return query(descriptor);
    };
  }
}
