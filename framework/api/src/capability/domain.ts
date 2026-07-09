// Domain-state capability handle (ADR-0011): domain vocabulary over the
// runtime's stores. First cut covers configuration entries and registered
// locations — the set the reference surfaces consume today. Live trading
// data joins when the watcher data path is contracted.
import {
  type KfLocation,
  type KfLocator,
  type KfNativeBinding,
  modeName,
  resolveRuntimeDir,
  roleName,
} from './types.js';

export type ConfigEntry = {
  location: KfLocation;
  value: string;
};

export type DomainState = {
  runtimeDir: string;
  configs: () => ConfigEntry[];
  setConfig: (location: KfLocation, value: string) => boolean;
  removeConfig: (location: KfLocation) => boolean;
  locations: () => KfLocation[];
};

export type OpenDomainStateOptions = {
  binding: KfNativeBinding;
  locator: KfLocator;
};

export function openDomainState(options: OpenDomainStateOptions): DomainState {
  const { binding } = options;
  const runtimeDir = resolveRuntimeDir(options.locator);
  const store = new binding.ConfigStore(runtimeDir);

  const configs = (): ConfigEntry[] =>
    Object.values(store.getAllConfig()).map((row) => ({
      location: {
        role: roleName(row.role as number),
        namespace: String((row.namespace ?? row.group) as string),
        name: String(row.name),
        mode: modeName(row.mode as number),
      },
      value: String(row.value),
    }));

  const setConfig = (location: KfLocation, value: string): boolean =>
    store.setConfig(
      String(location.role),
      location.namespace,
      location.name,
      String(location.mode),
      value,
    );

  const removeConfig = (location: KfLocation): boolean =>
    store.removeConfig(
      String(location.role),
      location.namespace,
      location.name,
      String(location.mode),
    );

  const locations = (): KfLocation[] => {
    const io = new binding.IODevice(
      { role: 'system', namespace: 'capability', name: 'domain', mode: 'live' },
      runtimeDir,
    );
    return Object.values(io.getAllLocations()).map((row) => ({
      role: String(row.role),
      namespace: String(row.namespace ?? row.group),
      name: String(row.name),
      mode: String(row.mode),
    }));
  };

  return { runtimeDir, configs, setConfig, removeConfig, locations };
}
